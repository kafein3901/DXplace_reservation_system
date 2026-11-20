// 機器と予約状況（docs/design/detailed/api.md 8.18〜8.22・8.24。MNG-1, MNG-2, VIW-1〜VIW-3, LOG-2〜LOG-4）
// 共2・共3・共4（本文を読めたか）は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.5・8.12）。
// どれも、共3 から書き込みの終わりまで await がないので、ほぼ同時の要求も1つずつ処理される（RSV-23）
import { adminEvent } from './admin-event.js';
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { DAY_MS, formatDate, formatDateTime, parseDate } from '../lib/time.js';
import { validateDeviceName } from '../lib/validate.js';
import { checkDeviceActive, checkDeviceCreate, checkDeviceDelete, checkDeviceRename } from '../rules/devices.js';
import { daySlots } from '../rules/view.js';
import {
  findCurrentDeviceByName,
  findDevice,
  insertDevice,
  listCurrentDevices,
  markDeviceDeleted,
  updateDeviceName,
} from '../store/devices.js';
import { insertEvent } from '../store/events.js';
import {
  findActiveReservationsByDevice,
  findDayReservations,
  updateReservationAdminCancelled,
} from '../store/reservations.js';

// 一覧に共通：自動の変化を反映し、削除していない機器を引く。記録は反映した自動の変化だけ
function readDevices(storage, nowMin) {
  const sql = storage.sql;
  return storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    return listCurrentDevices(sql);
  });
}

// GET /api/admin/devices（api.md 8.18）
export function listDevicesForAdmin({ storage, nowMin }) {
  return ok({ devices: readDevices(storage, nowMin) });
}

// GET /api/devices（api.md 8.22）。利用者の情報は含まない。now は画面が今日の日を決めるのに使う（TIM-1）
export function listDevicesForUser({ storage, nowMin }) {
  return ok({ devices: readDevices(storage, nowMin), now: formatDateTime(nowMin) });
}

// GET /api/devices/{id}/day?date=YYYY-MM-DD（api.md 8.24。VIW-1〜VIW-3）。識別の組は受け取らない。
// 応答の項目はここで選び、学籍番号・生徒か教員か・予約の番号・予約なしの利用かは入れない（VIW-2）
export function deviceDay({ storage, request, params, nowMin }) {
  // 段 1。同じ名前が2つあれば最初の値。ここで断るときは何も書かず、自動の変化も反映しない
  const date = parseDate(new URL(request.url).searchParams.get('date'));
  if (!date.ok) return refuse(date.code);
  const dayStart = date.value;
  const dayEnd = dayStart + DAY_MS;

  const sql = storage.sql;
  // NOT_FOUND_DEVICE で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const checked = checkDeviceActive(findDevice(sql, params.id));
    if (!checked.ok) return { code: checked.code };
    return { slots: daySlots(findDayReservations(sql, params.id, dayStart, dayEnd), dayStart, dayEnd) };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok({
    date: formatDate(dayStart),
    now: formatDateTime(nowMin),
    // 日をまたいでも切らない（画面が切って描く）。名前・期生は現在の値（USR-7）
    slots: result.slots.map((slot) => ({
      start: formatDateTime(slot.start_at),
      end: formatDateTime(slot.end_at),
      status: slot.status,
      user_id: slot.user_id,
      name: slot.name,
      cohort: slot.cohort,
    })),
  });
}

// 追加・名前の変更に共通の共4 と段 1。断るなら { code }、通れば { name }（前後の空白を除いた名前）。
// ここで断るときは何も書かず、自動の変化も反映しない
function validateNameInput(body) {
  if (!hasStringFields(body, ['name'])) return { code: 'INPUT_BODY' };
  const name = validateDeviceName(body.name);
  if (!name.ok) return { code: name.code };
  return { name: name.value };
}

// POST /api/admin/devices（api.md 8.19）
export function createDevice({ storage, body, auth, now, nowMin }) {
  const input = validateNameInput(body);
  if (input.code !== undefined) return refuse(input.code);

  const sql = storage.sql;
  // 段 8 で断っても、反映した自動の変化は残す（戻り値で断るので取り消されない）
  const result = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const checked = checkDeviceCreate(findCurrentDeviceByName(sql, input.name));
    if (!checked.ok) return { code: checked.code };
    const device = insertDevice(sql, { name: input.name, createdAt: now });
    insertEvent(sql, adminEvent(now, auth, { kind: 'device_created', device_id: device.id, detail: { name: device.name } }));
    return { device };
  });
  if (result.code !== undefined) return refuse(result.code);
  return ok({ id: result.device.id, name: result.device.name });
}

// POST /api/admin/devices/{id}/rename（api.md 8.20）。今と同じ名前なら何も書かない
export function renameDevice({ storage, body, params, auth, now, nowMin }) {
  const input = validateNameInput(body);
  if (input.code !== undefined) return refuse(input.code);

  const sql = storage.sql;
  const result = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const device = findDevice(sql, params.id);
    const checked = checkDeviceRename(device, findCurrentDeviceByName(sql, input.name), input.name);
    if (!checked.ok) return { code: checked.code };
    if (checked.action === 'rename') {
      updateDeviceName(sql, device.id, input.name);
      insertEvent(
        sql,
        adminEvent(now, auth, {
          kind: 'device_renamed',
          device_id: device.id,
          detail: { before: { name: device.name }, after: { name: input.name } },
        }),
      );
    }
    return { id: device.id };
  });
  if (result.code !== undefined) return refuse(result.code);
  return ok({ id: result.id, name: input.name });
}

// POST /api/admin/devices/{id}/delete（api.md 8.21）。利用中があれば何も変えない（MNG-2）。
// 受け付けたら、機器の削除を先に記録し、予約済の取消を番号の順に1件ずつ記録する（LOG-3）
export function deleteDevice({ storage, params, auth, now, nowMin }) {
  const sql = storage.sql;
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。終了時刻を過ぎた利用中は終了になり、削除を妨げない
    applyAutoTransitions(sql, nowMin);
    const device = findDevice(sql, params.id);
    const active = device === null ? [] : findActiveReservationsByDevice(sql, device.id);
    const checked = checkDeviceDelete(device, active);
    if (!checked.ok) return { code: checked.code };

    markDeviceDeleted(sql, device.id, now);
    insertEvent(sql, adminEvent(now, auth, { kind: 'device_deleted', device_id: device.id, detail: { name: device.name } }));

    const byId = new Map(active.map((reservation) => [reservation.id, reservation]));
    for (const id of checked.cancel) {
      const reservation = byId.get(id);
      updateReservationAdminCancelled(sql, id, 'device_deleted');
      insertEvent(
        sql,
        adminEvent(now, auth, {
          kind: 'reservation_status',
          reservation_id: id,
          device_id: reservation.device_id,
          user_id: reservation.user_id,
          detail: { from: 'reserved', to: 'admin_cancelled', cause: 'device_deleted' },
        }),
      );
    }
    return { device };
  });
  if (result.code !== undefined) return refuse(result.code);
  return ok({ id: result.device.id, name: result.device.name });
}

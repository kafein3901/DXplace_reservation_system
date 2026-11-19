// 予約の操作（docs/design/detailed/api.md 8.16・8.25。RSV-2〜RSV-6, RSV-23, TIM-6, LOG-3）
// 共2・共3・共4（本文を読めたか）は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.12）。
// 共3 から書き込みの終わりまで await がないので、ほぼ同時の要求も1つずつ処理される（RSV-23）
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { formatDateTime, parseDateTime } from '../lib/time.js';
import { validateRole, validateStudentId } from '../lib/validate.js';
import { checkReserve } from '../rules/reservations.js';
import { findDevice } from '../store/devices.js';
import { insertEvent } from '../store/events.js';
import {
  findActiveReservationsByDevice,
  findActiveReservationsByUser,
  insertReservation,
} from '../store/reservations.js';
import { listSettings } from '../store/settings.js';
import { findUserByIdentity } from '../store/users.js';

// 本文の番号の項目：正の安全な整数（api.md 8.25。小数・0・負の数・文字列は INPUT_BODY）
function isPositiveId(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

// 段 1 の最初：識別の組（api.md 8.16）。断るなら { ok: false, code }、通れば { ok: true, role, studentId }
function validateIdentity(body) {
  const role = validateRole(body.role);
  if (!role.ok) return role;
  const studentId = validateStudentId(role.value, body.student_id);
  if (!studentId.ok) return studentId;
  return { ok: true, role: role.value, studentId: studentId.value };
}

// POST /api/reservations（api.md 8.25）
export function createReservation({ storage, body, now, nowMin }) {
  // 共4：識別の組と時刻は文字列、機器の番号は正の安全な整数
  if (!hasStringFields(body, ['role', 'student_id', 'start', 'end']) || !isPositiveId(body.device_id)) {
    return refuse('INPUT_BODY');
  }

  // 段 1。ここで断るときは何も書かず、自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);
  const start = parseDateTime(body.start);
  if (!start.ok) return refuse(start.code);
  const end = parseDateTime(body.end);
  if (!end.ok) return refuse(end.code);

  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す（戻り値で断るので取り消されない）
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。終了時刻を過ぎた利用中・猶予を過ぎた予約済は、件数にも重なりにも入らない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    const device = findDevice(sql, body.device_id);
    const checked = checkReserve({
      user,
      device,
      start: start.value,
      end: end.value,
      nowMin,
      settings: listSettings(sql),
      userActive: user === null ? [] : findActiveReservationsByUser(sql, user.id),
      deviceActive: device === null ? [] : findActiveReservationsByDevice(sql, device.id),
    });
    if (!checked.ok) return { code: checked.code };

    // 時刻は入力どおり。created_at と記録の at は秒を切り捨てない（TIM-5）
    const reservation = insertReservation(sql, {
      deviceId: device.id,
      userId: user.id,
      startAt: start.value,
      endAt: end.value,
      status: 'reserved',
      walkIn: 0,
      createdAt: now,
    });
    insertEvent(sql, {
      at: now,
      actor_kind: 'user',
      kind: 'reservation_created',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      detail: { start_at: reservation.start_at, end_at: reservation.end_at },
    });
    return { reservation };
  });
  if (result.code !== undefined) return refuse(result.code);

  const { reservation } = result;
  return ok({
    id: reservation.id,
    device_id: reservation.device_id,
    start: formatDateTime(reservation.start_at),
    end: formatDateTime(reservation.end_at),
    status: reservation.status,
  });
}

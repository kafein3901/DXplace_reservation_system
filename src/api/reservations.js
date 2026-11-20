// 予約の操作（docs/design/detailed/api.md 8.16・8.25・8.27・8.29・8.30・8.32・8.34・8.35。RSV-2〜RSV-20, RSV-23, TIM-4, TIM-6, LOG-3）
// 共2・共3・共4（本文を読めたか）は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.12）。
// 共3 から書き込みの終わりまで await がないので、ほぼ同時の要求も1つずつ処理される（RSV-23）
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { formatDateTime, parseDateTime } from '../lib/time.js';
import { validateRole, validateStudentId } from '../lib/validate.js';
import {
  checkBegin,
  checkCancel,
  checkChange,
  checkFinish,
  checkMyReservations,
  checkReserve,
  checkWalkIn,
} from '../rules/reservations.js';
import { findDevice } from '../store/devices.js';
import { insertEvent } from '../store/events.js';
import {
  findActiveReservationsByDevice,
  findActiveReservationsByUser,
  findMyReservations,
  findReservation,
  insertReservation,
  updateReservationBegin,
  updateReservationFinish,
  updateReservationStatus,
  updateReservationTimes,
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

// 確保・予約なしの利用・取消・時間帯の変更・利用開始・利用終了・管理者による取消と終了の応答の data
// （api.md 8.25・8.27・8.30・8.32・8.34・8.35・8.38・8.39 で同じ形）
export function reservationData(reservation) {
  return {
    id: reservation.id,
    device_id: reservation.device_id,
    start: formatDateTime(reservation.start_at),
    end: formatDateTime(reservation.end_at),
    status: reservation.status,
  };
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

  return ok(reservationData(result.reservation));
}

// POST /api/walk-ins（api.md 8.27）。開始時刻は受け取らず、台帳が nowMin にする（RSV-17, TIM-4, RSV-24）。
// 本文に start があっても知らない項目として読まない
export function startWalkIn({ storage, body, now, nowMin }) {
  // 共4：識別の組と終了時刻は文字列、機器の番号は正の安全な整数
  if (!hasStringFields(body, ['role', 'student_id', 'end']) || !isPositiveId(body.device_id)) {
    return refuse('INPUT_BODY');
  }

  // 段 1。ここで断るときは何も書かず、自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);
  const end = parseDateTime(body.end);
  if (!end.ok) return refuse(end.code);

  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。ちょうど nowMin に解放された予約は、空いているかの判定を妨げない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    const device = findDevice(sql, body.device_id);
    // 利用者の予約は引かない（件数に数えない。RSV-17）
    const checked = checkWalkIn({
      user,
      device,
      end: end.value,
      nowMin,
      settings: listSettings(sql),
      deviceActive: device === null ? [] : findActiveReservationsByDevice(sql, device.id),
    });
    if (!checked.ok) return { code: checked.code };

    // 開始はルールが返した値（= nowMin）。最初から利用中なので状態の変化の記録は書かない
    const reservation = insertReservation(sql, {
      deviceId: device.id,
      userId: user.id,
      startAt: checked.start,
      endAt: end.value,
      status: 'in_use',
      walkIn: 1,
      createdAt: now,
    });
    insertEvent(sql, {
      at: now,
      actor_kind: 'user',
      kind: 'walk_in_started',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      detail: { start_at: reservation.start_at, end_at: reservation.end_at },
    });
    return { reservation };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

// POST /api/my/reservations（api.md 8.29。RSV-7）。読むだけなので記録は書かない（反映した自動の変化を除く）
export function listMyReservations({ storage, body, nowMin }) {
  // 共4：識別の組は文字列
  if (!hasStringFields(body, ['role', 'student_id'])) return refuse('INPUT_BODY');

  // 段 1。ここで断るときは自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);

  const sql = storage.sql;
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-21）。猶予を過ぎた予約済・終了時刻を過ぎた利用中は一覧に出ない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    return checkMyReservations({ user, userActive: user === null ? [] : findMyReservations(sql, user.id) });
  });
  if (!result.ok) return refuse(result.code);

  // 名前・期生・学籍番号・walk_in は入れない（api.md 8.29）
  return ok({
    now: formatDateTime(nowMin),
    reservations: result.reservations.map((reservation) => ({
      id: reservation.id,
      device_id: reservation.device_id,
      device_name: reservation.device_name,
      start: formatDateTime(reservation.start_at),
      end: formatDateTime(reservation.end_at),
      status: reservation.status,
    })),
  });
}

// POST /api/reservations/{id}/cancel（api.md 8.30。RSV-8）。予約は番号だけで引き、本人のものかは rules が確かめる
export function cancelReservation({ storage, body, params, now, nowMin }) {
  // 共4：識別の組は文字列
  if (!hasStringFields(body, ['role', 'student_id'])) return refuse('INPUT_BODY');

  // 段 1。ここで断るときは自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);

  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。猶予の終わりがちょうど nowMin の予約済は無断不使用になり、取り消せない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    const reservation = findReservation(sql, params.id);
    const checked = checkCancel({ user, reservation });
    if (!checked.ok) return { code: checked.code };

    // 状態だけを変える。cause は NULL のまま、時刻は変えない。直ちに解放される（RSV-8）
    updateReservationStatus(sql, reservation.id, 'cancelled');
    // 取消は時間帯の境界を決めないので、記録の at は秒を切り捨てない（TIM-5）
    insertEvent(sql, {
      at: now,
      actor_kind: 'user',
      kind: 'reservation_status',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      detail: { from: 'reserved', to: 'cancelled' },
    });
    return { reservation: { ...reservation, status: 'cancelled' } };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

// POST /api/reservations/{id}/change（api.md 8.32。RSV-9〜RSV-12）。機器は受け取らない（RSV-9）。
// 変えない側も今の値を受け取り、今と同じ値の側を「変えない時刻」とする（rules.md 6.13）
export function changeReservation({ storage, body, params, now, nowMin }) {
  // 共4：識別の組と時刻は文字列。device_id は知らない項目として読まない
  if (!hasStringFields(body, ['role', 'student_id', 'start', 'end'])) return refuse('INPUT_BODY');

  // 段 1。ここで断るときは何も書かず、自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);
  const start = parseDateTime(body.start);
  if (!start.ok) return refuse(start.code);
  const end = parseDateTime(body.end);
  if (!end.ok) return refuse(end.code);

  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。終了時刻がちょうど nowMin の利用中は終了になり、延長できない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    const reservation = findReservation(sql, params.id);
    // 利用者の予約は引かない（件数を理由に断らない。RSV-12）。機器の予約はその予約自身を含む
    const checked = checkChange({
      user,
      reservation,
      start: start.value,
      end: end.value,
      nowMin,
      settings: listSettings(sql),
      deviceActive: reservation === null ? [] : findActiveReservationsByDevice(sql, reservation.device_id),
    });
    if (!checked.ok) return { code: checked.code };
    // 両方とも変えないときは何も書かない（記録もしない）
    if (checked.action === 'unchanged') return { reservation };

    // 時刻は入力どおり。記録の at は秒を切り捨てない（TIM-5）。状態は変わらないので reservation_status は書かない
    updateReservationTimes(sql, reservation.id, start.value, end.value);
    insertEvent(sql, {
      at: now,
      actor_kind: 'user',
      kind: 'reservation_time_changed',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      detail: {
        before: { start_at: reservation.start_at, end_at: reservation.end_at },
        after: { start_at: start.value, end_at: end.value },
      },
    });
    return { reservation: { ...reservation, start_at: start.value, end_at: end.value } };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

// POST /api/reservations/{id}/begin（api.md 8.34。RSV-13〜RSV-16, RSV-6）。開始時刻は受け取らない（RSV-15, TIM-4, RSV-24）
export function beginReservation({ storage, body, params, now, nowMin }) {
  // 共4：識別の組は文字列。start は知らない項目として読まない
  if (!hasStringFields(body, ['role', 'student_id'])) return refuse('INPUT_BODY');

  // 段 1。ここで断るときは何も書かず、自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);

  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。猶予の終わりがちょうど nowMin の予約済は無断不使用になり、利用開始できない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    const reservation = findReservation(sql, params.id);
    // 機器の予約はその予約自身を含む
    const checked = checkBegin({
      user,
      reservation,
      nowMin,
      settings: listSettings(sql),
      deviceActive: reservation === null ? [] : findActiveReservationsByDevice(sql, reservation.device_id),
    });
    if (!checked.ok) return { code: checked.code };

    // 開始時刻は rules が返した値を書く。前倒しでも reservation_time_changed は書かない（1回の操作を1行。schema.md 2.9）
    updateReservationBegin(sql, reservation.id, checked.start);
    const detail = { from: 'reserved', to: 'in_use' };
    if (checked.start !== reservation.start_at) {
      detail.start_at = { before: reservation.start_at, after: checked.start };
    }
    // 記録の at は秒を切り捨てない（TIM-5）
    insertEvent(sql, {
      at: now,
      actor_kind: 'user',
      kind: 'reservation_status',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      detail,
    });
    return { reservation: { ...reservation, status: 'in_use', start_at: checked.start } };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

// POST /api/reservations/{id}/finish（api.md 8.35。RSV-18, RSV-19, TIM-7）。終了時刻は受け取らない（RSV-18, TIM-4）
export function finishReservation({ storage, body, params, now, nowMin }) {
  // 共4：識別の組は文字列。end は知らない項目として読まない
  if (!hasStringFields(body, ['role', 'student_id'])) return refuse('INPUT_BODY');

  // 段 1。ここで断るときは何も書かず、自動の変化も反映しない
  const identity = validateIdentity(body);
  if (!identity.ok) return refuse(identity.code);

  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-19, RSV-22）。終了時刻がちょうど nowMin の利用中は自動で終了になり、利用終了できない
    applyAutoTransitions(sql, nowMin);
    const user = findUserByIdentity(sql, identity.role, identity.studentId);
    const reservation = findReservation(sql, params.id);
    const checked = checkFinish({ user, reservation, nowMin });
    if (!checked.ok) return { code: checked.code };

    // 直ちに解放する（RSV-19）。予定していた終了時刻を記録の before に残す（schema.md 2.3）
    updateReservationFinish(sql, reservation.id, checked.end);
    insertEvent(sql, {
      at: now,
      actor_kind: 'user',
      kind: 'reservation_status',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      detail: { from: 'in_use', to: 'finished', end_at: { before: reservation.end_at, after: checked.end } },
    });
    return { reservation: { ...reservation, status: 'finished', end_at: checked.end } };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

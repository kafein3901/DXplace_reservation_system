// 予約の管理（docs/design/detailed/api.md 8.37〜8.39。MNG-3, RSV-23, TIM-4, TIM-7, LOG-3, LOG-4）
// 共2・共3・共4（本文を読めたか）は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.5）。
// 共3 から書き込みの終わりまで await がないので、ほぼ同時の要求も1つずつ処理される（RSV-23）
import { adminEvent } from './admin-event.js';
import { applyAutoTransitions } from './auto.js';
import { reservationData } from './reservations.js';
import { ok, refuse } from './respond.js';
import { formatDateTime } from '../lib/time.js';
import { checkAdminCancel, checkAdminFinish, checkDeviceReservations } from '../rules/admin-reservations.js';
import { findDevice } from '../store/devices.js';
import { insertEvent } from '../store/events.js';
import {
  findAdminDeviceReservations,
  findReservation,
  updateReservationAdminCancelled,
  updateReservationAdminFinished,
} from '../store/reservations.js';

// GET /api/admin/devices/{id}/reservations（api.md 8.37）。管理者の API なので学籍番号を返す（MNG-3。VIW-2 は当てはまらない）
export function listDeviceReservationsForAdmin({ storage, params, nowMin }) {
  const sql = storage.sql;
  // NOT_FOUND_DEVICE で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-21）。猶予を過ぎた予約済・終了時刻を過ぎた利用中は一覧に出ない
    applyAutoTransitions(sql, nowMin);
    const device = findDevice(sql, params.id);
    const checked = checkDeviceReservations({
      device,
      deviceActive: device === null ? [] : findAdminDeviceReservations(sql, device.id),
    });
    if (!checked.ok) return { code: checked.code };
    return { reservations: checked.reservations };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok({
    reservations: result.reservations.map((reservation) => ({
      id: reservation.id,
      start: formatDateTime(reservation.start_at),
      end: formatDateTime(reservation.end_at),
      status: reservation.status,
      role: reservation.role,
      student_id: reservation.student_id,
      name: reservation.name,
    })),
  });
}

// POST /api/admin/reservations/{id}/cancel（api.md 8.38）。本文は {} で、項目は読まない。
// 時刻は変えないので、記録の detail に start_at・end_at は入れない
export function cancelReservationByAdmin({ storage, params, auth, now, nowMin }) {
  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-22）。猶予の終わりがちょうど nowMin の予約済は無断不使用になり、取り消せない
    applyAutoTransitions(sql, nowMin);
    const reservation = findReservation(sql, params.id);
    const checked = checkAdminCancel({ reservation });
    if (!checked.ok) return { code: checked.code };

    updateReservationAdminCancelled(sql, reservation.id, 'admin_action');
    insertEvent(
      sql,
      adminEvent(now, auth, {
        kind: 'reservation_status',
        reservation_id: reservation.id,
        device_id: reservation.device_id,
        user_id: reservation.user_id,
        detail: { from: 'reserved', to: 'admin_cancelled', cause: 'admin_action' },
      }),
    );
    return { reservation: { ...reservation, status: 'admin_cancelled', cause: 'admin_action' } };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

// POST /api/admin/reservations/{id}/finish（api.md 8.39）。終了時刻は受け取らない（MNG-3, TIM-4）。本文の end は読まない
export function finishReservationByAdmin({ storage, params, auth, now, nowMin }) {
  const sql = storage.sql;
  // 段 2 以降で断っても、反映した自動の変化は残す
  const result = storage.transactionSync(() => {
    // 自動の変化が先（RSV-19, RSV-22）。終了時刻がちょうど nowMin の利用中は自動で終了になり、終了させられない
    applyAutoTransitions(sql, nowMin);
    const reservation = findReservation(sql, params.id);
    const checked = checkAdminFinish({ reservation, nowMin });
    if (!checked.ok) return { code: checked.code };

    // 直ちに解放する。予定していた終了時刻を記録の before に残す（8.35 と同じ形）
    updateReservationAdminFinished(sql, reservation.id, checked.end);
    insertEvent(
      sql,
      adminEvent(now, auth, {
        kind: 'reservation_status',
        reservation_id: reservation.id,
        device_id: reservation.device_id,
        user_id: reservation.user_id,
        detail: {
          from: 'in_use',
          to: 'admin_finished',
          cause: 'admin_action',
          end_at: { before: reservation.end_at, after: checked.end },
        },
      }),
    );
    return { reservation: { ...reservation, status: 'admin_finished', cause: 'admin_action', end_at: checked.end } };
  });
  if (result.code !== undefined) return refuse(result.code);

  return ok(reservationData(result.reservation));
}

// 自動の変化の反映と書き込み（docs/design/detailed/api.md 3.5。RSV-13, RSV-16, RSV-19, RSV-21, LOG-3）
// 各 API が、transactionSync の中で、入力の形式を確かめた後に呼ぶ。読むだけの API でも呼ぶ
import { dueTransitions } from '../rules/transitions.js';
import { insertEvent } from '../store/events.js';
import { findTransitionCandidates, updateReservationStatus } from '../store/reservations.js';
import { listSettings } from '../store/settings.js';

export function applyAutoTransitions(sql, nowMin) {
  const candidates = findTransitionCandidates(sql, nowMin);
  const settings = listSettings(sql);
  const byId = new Map(candidates.map((reservation) => [reservation.id, reservation]));

  // 返された順（起きる時刻の順、同じなら番号の順）に1件ずつ
  for (const transition of dueTransitions(candidates, settings, nowMin)) {
    const reservation = byId.get(transition.reservationId);
    updateReservationStatus(sql, reservation.id, transition.to);
    insertEvent(sql, {
      at: transition.at, // ルール上の時刻（RSV-21）
      actor_kind: 'auto',
      kind: 'reservation_status',
      reservation_id: reservation.id,
      device_id: reservation.device_id,
      user_id: reservation.user_id,
      // 時刻を書き換えないので start_at・end_at は入れない（schema.md 2.9）
      detail: { from: reservation.status, to: transition.to },
    });
  }
}

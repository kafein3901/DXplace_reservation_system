// 自動の変化（docs/design/detailed/rules.md 5、docs/design/basic/time-and-concurrency.md 3。RSV-13, RSV-16, RSV-19, RSV-21, RSV-22, RSV-26）
import { MINUTE_MS } from '../lib/time.js';
import { settingAt } from './settings.js';

// reservations：予約の一覧（store が渡す。{ id, start_at, end_at, status, ... }）
// settings：数値の履歴の全件
// nowMin までに起きるはずの変化を、起きる時刻の順（同じ時刻なら予約の番号の順）に返す。
// 1件は { reservationId, to, at }。at は起きる時刻（ルール上の時刻。RSV-21）
export function dueTransitions(reservations, settings, nowMin) {
  const due = [];
  for (const reservation of reservations) {
    const transition = nextTransition(reservation, settings);
    // 「以下」で比べ、同じ時刻の操作より先に起きたものとする（RSV-22）
    if (transition !== null && transition.at <= nowMin) {
      due.push({ reservationId: reservation.id, to: transition.to, at: transition.at });
    }
  }
  return due.sort((a, b) => a.at - b.at || a.reservationId - b.reservationId);
}

// 予約の状態だけを見て、次に起きる自動の変化を決める。なければ null
function nextTransition(reservation, settings) {
  switch (reservation.status) {
    case 'reserved': {
      // 猶予は開始時刻の時点の値（RSV-26）。猶予が長さより長ければ終了時刻（RSV-16）
      const graceMinutes = settingAt(settings, 'grace_minutes', reservation.start_at);
      const at = Math.min(reservation.start_at + graceMinutes * MINUTE_MS, reservation.end_at);
      return { to: 'no_show', at }; // RSV-13
    }
    case 'in_use':
      return { to: 'finished', at: reservation.end_at }; // RSV-19
    default:
      return null;
  }
}

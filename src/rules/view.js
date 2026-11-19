// 予約状況（docs/design/detailed/rules.md 6.9。VIW-1）

// 表示する状態：確保済み（予約済・利用中）と、利用があった時間帯（終了・管理者による終了）
const SHOWN = new Set(['reserved', 'in_use', 'finished', 'admin_finished']);

// その日にかかるか。長さが正なら [開始, 終了) と日の範囲が重なるか（TIM-2）。
// 長さ0（TIM-7 の利用終了）は開始時刻を含む日に出す
function touchesDay(reservation, dayStart, dayEnd) {
  const { start_at: start, end_at: end } = reservation;
  if (start === end) return dayStart <= start && start < dayEnd;
  return start < dayEnd && end > dayStart;
}

// reservations：store が引いた、その機器の予約（状態で絞らない）。自動の変化を反映した後のもの（rules.md 5.3）。
// 残す予約を、開始時刻の順（同じなら番号の順）に並べて返す。要素はそのまま返し、項目は選ばない
export function daySlots(reservations, dayStart, dayEnd) {
  return reservations
    .filter((reservation) => SHOWN.has(reservation.status) && touchesDay(reservation, dayStart, dayEnd))
    .sort((a, b) => a.start_at - b.start_at || a.id - b.id);
}

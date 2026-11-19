// 予約の表（docs/design/detailed/schema.md 2.3・3）

// 自動の変化の反映で引く予約：予約済・利用中のうち、開始時刻が nowMin 以下のもの（rules.md 5.2）。
// reservations_status_start が使われる形で書く。テストで EXPLAIN QUERY PLAN を見るため書き出す
export const SQL_TRANSITION_CANDIDATES = `
  SELECT id, device_id, user_id, start_at, end_at, status, cause, walk_in, created_at
  FROM reservations
  WHERE status IN ('reserved', 'in_use') AND start_at <= ?`;

export function findTransitionCandidates(sql, nowMin) {
  return sql.exec(SQL_TRANSITION_CANDIDATES, nowMin).toArray();
}

// 状態だけを変える。時刻・原因・予約なしの利用かは変えない（api.md 3.5 の 3）
export function updateReservationStatus(sql, id, status) {
  sql.exec('UPDATE reservations SET status = ? WHERE id = ?', status, id);
}

// その機器の予約済・利用中の予約の全件（reservations_device_status が使われる形）。機器の削除で使う（MNG-2）
export function findActiveReservationsByDevice(sql, deviceId) {
  return sql
    .exec(
      `SELECT id, device_id, user_id, start_at, end_at, status, cause, walk_in, created_at
       FROM reservations
       WHERE device_id = ? AND status IN ('reserved', 'in_use')
       ORDER BY id`,
      deviceId,
    )
    .toArray();
}

// 管理者による取消。状態と原因だけを変え、時刻は変えない（api.md 8.21）
export function updateReservationAdminCancelled(sql, id, cause) {
  sql.exec("UPDATE reservations SET status = 'admin_cancelled', cause = ? WHERE id = ?", cause, id);
}

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

// その機器の予約済・利用中の予約の全件（reservations_device_status が使われる形）。機器の削除（MNG-2）と確保の重なり（RSV-3）で使う
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

// 予約状況で引く予約（api.md 8.24）：その機器の、終了が dayStart 以降で開始が dayEnd より前のもの。状態では絞らない。
// end_at >= dayStart は長さ0の利用を開始時刻を含む日に出すため（rules.md 6.9）。正確な絞り込みは daySlots が行う。
// users を結合して現在の名前・期生を付ける（USR-7）。学籍番号・生徒か教員かは引かない（VIW-2）。
// reservations_device_end が使われる形で書く。テストで EXPLAIN QUERY PLAN を見るため書き出す
export const SQL_DAY_RESERVATIONS = `
  SELECT r.id, r.start_at, r.end_at, r.status, r.user_id, u.name, u.cohort
  FROM reservations AS r JOIN users AS u ON u.id = r.user_id
  WHERE r.device_id = ? AND r.end_at >= ? AND r.start_at < ?`;

export function findDayReservations(sql, deviceId, dayStart, dayEnd) {
  return sql.exec(SQL_DAY_RESERVATIONS, deviceId, dayStart, dayEnd).toArray();
}

// その利用者の予約済・利用中の予約の全件（全機器。reservations_user_status が使われる形）。確保の件数で使う（RSV-4）
export function findActiveReservationsByUser(sql, userId) {
  return sql
    .exec(
      `SELECT id, device_id, user_id, start_at, end_at, status, cause, walk_in, created_at
       FROM reservations
       WHERE user_id = ? AND status IN ('reserved', 'in_use')
       ORDER BY id`,
      userId,
    )
    .toArray();
}

// 1行足し、足した行を返す。cause は NULL（schema.md 2.3）
export function insertReservation(sql, { deviceId, userId, startAt, endAt, status, walkIn, createdAt }) {
  return sql
    .exec(
      `INSERT INTO reservations (device_id, user_id, start_at, end_at, status, cause, walk_in, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       RETURNING id, device_id, user_id, start_at, end_at, status, cause, walk_in, created_at`,
      deviceId,
      userId,
      startAt,
      endAt,
      status,
      walkIn,
      createdAt,
    )
    .one();
}

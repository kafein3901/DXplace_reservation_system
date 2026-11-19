// 認証の失敗の表（docs/design/detailed/schema.md 2.10。SEC-3、LOG-4）
// 消すのはこの表の、10,000行を超えた古い行だけ（LOG-5）

export const MAX_AUTH_FAILURE_ROWS = 10_000;

// 入口・相手・10分の区切りで引く。なければ null
export function findAuthFailure(sql, entry, client, windowStart) {
  return (
    sql
      .exec(
        `SELECT id, entry, client, window_start, failures, unknown_id_failures, wrong_password_failures,
                last_login_id, first_at, last_at
         FROM auth_failures WHERE entry = ? AND client = ? AND window_start = ?`,
        entry,
        client,
        windowStart,
      )
      .toArray()[0] ?? null
  );
}

// 失敗を1つ数える。行がなければ failures = 1 で足し、あれば1増やして last_at を書く。
// at は実際の時刻（秒を切り捨てない）。足したときは 10,000行を超えた古い行を消す（schema.md 2.10）。
// 管理者の認証以外の入口では unknown_id_failures・wrong_password_failures は 0、last_login_id は NULL のまま
export function recordAuthFailure(sql, { entry, client, windowStart, at }) {
  const row = findAuthFailure(sql, entry, client, windowStart);
  if (row !== null) {
    sql.exec('UPDATE auth_failures SET failures = failures + 1, last_at = ? WHERE id = ?', at, row.id);
    return;
  }
  const id = sql
    .exec(
      `INSERT INTO auth_failures
         (entry, client, window_start, failures, unknown_id_failures, wrong_password_failures, last_login_id,
          first_at, last_at)
       VALUES (?, ?, ?, 1, 0, 0, NULL, ?, ?)
       RETURNING id`,
      entry,
      client,
      windowStart,
      at,
      at,
    )
    .one().id;
  sql.exec('DELETE FROM auth_failures WHERE id <= ?', id - MAX_AUTH_FAILURE_ROWS);
}

// 管理者の認証した状態の表（docs/design/detailed/schema.md 2.8。ADM-2）
// 行は消さない。認証を解くときは ended_at を入れる（LOG-5）

// Cookie の値の SHA-256 で引く。なければ null
export function findAdminSessionByHash(sql, tokenHash) {
  return (
    sql
      .exec(
        'SELECT id, admin_id, password_version, created_at, ended_at FROM admin_sessions WHERE token_hash = ?',
        tokenHash,
      )
      .toArray()[0] ?? null
  );
}

// 1行足し、番号を返す。password_version はその管理者の現在の版
export function insertAdminSession(sql, { tokenHash, adminId, passwordVersion, createdAt }) {
  return sql
    .exec(
      `INSERT INTO admin_sessions (token_hash, admin_id, password_version, created_at, ended_at)
       VALUES (?, ?, ?, ?, NULL)
       RETURNING id`,
      tokenHash,
      adminId,
      passwordVersion,
      createdAt,
    )
    .one().id;
}

export function endAdminSession(sql, id, endedAt) {
  sql.exec('UPDATE admin_sessions SET ended_at = ? WHERE id = ?', endedAt, id);
}

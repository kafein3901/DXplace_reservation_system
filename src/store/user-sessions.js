// 利用を始めた証明の表（docs/design/detailed/schema.md 2.7。USR-2, ADM-3）
// 行は消さず、書き換えもしない。共有された情報の版が変わると、古い版の行は利用者の API で AUTH_REVOKED になる

// Cookie の値の SHA-256 で引く。なければ null
export function findUserSessionByHash(sql, tokenHash) {
  return (
    sql.exec('SELECT id, shared_info_id, created_at FROM user_sessions WHERE token_hash = ?', tokenHash).toArray()[0] ??
    null
  );
}

// 1行足し、番号を返す。sharedInfoId は始めたときの共有された情報の版
export function insertUserSession(sql, { tokenHash, sharedInfoId, createdAt }) {
  return sql
    .exec(
      'INSERT INTO user_sessions (token_hash, shared_info_id, created_at) VALUES (?, ?, ?) RETURNING id',
      tokenHash,
      sharedInfoId,
      createdAt,
    )
    .one().id;
}

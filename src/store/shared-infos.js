// 共有された情報の表（docs/design/detailed/schema.md 2.6。ADM-3）
// id が版で、id の最も大きい行が現在の値。行は消さない

// 1行足し、番号（新しい版）を返す。hash は値の SHA-256
export function insertSharedInfo(sql, { hash, createdAt }) {
  return sql.exec('INSERT INTO shared_infos (hash, created_at) VALUES (?, ?) RETURNING id', hash, createdAt).one().id;
}

// 現在の共有された情報（id の最も大きい行）。なければ null
export function findCurrentSharedInfo(sql) {
  return sql.exec('SELECT id, hash, created_at FROM shared_infos ORDER BY id DESC LIMIT 1').toArray()[0] ?? null;
}

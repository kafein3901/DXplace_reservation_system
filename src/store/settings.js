// 数値の履歴の表（docs/design/detailed/schema.md 2.4）

// 全件を返す。変更のたびに1行なので小さい（rules.md 3.1）
export function listSettings(sql) {
  return sql.exec('SELECT id, key, value, effective_at FROM settings').toArray();
}

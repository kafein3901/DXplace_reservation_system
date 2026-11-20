// 数値の履歴の表（docs/design/detailed/schema.md 2.4）

// 全件を返す。変更のたびに1行なので小さい（rules.md 3.1）
export function listSettings(sql) {
  return sql.exec('SELECT id, key, value, effective_at FROM settings').toArray();
}

// 変更の1行を足す（api.md 8.42）。effective_at は境界の時刻（nowMin）
export function insertSetting(sql, key, value, effectiveAt) {
  sql.exec('INSERT INTO settings (key, value, effective_at) VALUES (?, ?, ?)', key, value, effectiveAt);
}

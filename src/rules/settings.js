// 数値の履歴（docs/design/detailed/rules.md 3.1。RSV-25, RSV-26）

// settings：数値の履歴の全件（store が渡す。{ id, key, value, effective_at }）。
// key の行のうち、有効になる時刻が at 以下で最も新しい行の値を返す。
// 有効になる時刻が同じ行が複数あれば、番号の大きい行（後に足した行）を使う。
// 初期データ（effective_at = 0。schema.md 4）があるので、値は必ず見つかる。見つからなければバグとして例外にする
export function settingAt(settings, key, at) {
  let found = null;
  for (const row of settings) {
    if (row.key !== key || row.effective_at > at) continue;
    if (
      found === null ||
      row.effective_at > found.effective_at ||
      (row.effective_at === found.effective_at && row.id > found.id)
    ) {
      found = row;
    }
  }
  if (found === null) throw new Error(`数値の履歴に値がない：${key}`);
  return found.value;
}

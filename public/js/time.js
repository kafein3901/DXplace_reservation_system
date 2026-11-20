// 時刻の文字列の表示と足し引き（screens.md 1・2.8。TIM-1）
// API の YYYY-MM-DDTHH:mm・YYYY-MM-DD は日本時間。文字列を切り分けて表示を作り、端末のタイムゾーンには直さない。
// 足し引きは日本時間の値をそのまま Date.UTC で作り、getUTC* で読み戻す（端末のタイムゾーンに左右されない）

const pad = (n) => String(n).padStart(2, '0');

// 2026-11-20T10:00 → 11月20日 10:00
export function displayDateTime(s) {
  return `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日 ${s.slice(11, 16)}`;
}

// 選んだ日（YYYY-MM-DD）と同じ日なら時刻だけ、違う日なら日付も付ける（screens.md 3.4）
export function displayInDay(s, date) {
  return s.slice(0, 10) === date ? s.slice(11, 16) : displayDateTime(s);
}

// 時間帯を日付付きで出す（screens.md 3.7）：11月20日 10:00–11:00。終わりが別の日なら終わりにも日付を付ける
export function displayRange(start, end) {
  return `${displayDateTime(start)}–${displayInDay(end, start.slice(0, 10))}`;
}

// YYYY-MM-DDTHH:mm に分を足す
export function addMinutes(s, minutes) {
  const d = new Date(
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)), Number(s.slice(11, 13)), Number(s.slice(14, 16)) + minutes),
  );
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// 日（YYYY-MM-DD）の範囲 [その日 00:00, 翌日 00:00) を YYYY-MM-DDTHH:mm の組で返す
export function dayRange(date) {
  const start = `${date}T00:00`;
  return { start, end: addMinutes(start, 24 * 60) };
}

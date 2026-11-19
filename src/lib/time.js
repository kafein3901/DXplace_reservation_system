// 時刻（docs/design/detailed/rules.md 6.8、docs/design/basic/time-and-concurrency.md 1・2）
// 時刻はすべて 1970-01-01 00:00 UTC からのミリ秒の整数で扱う。日本時間との換算はこのファイルだけで行う

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
export const JST_OFFSET_MS = 32_400_000; // 9時間

// 日本時間の YYYY-MM-DDTHH:mm にする。秒以下は書かない（rules.md 6.8。TIM-1）
export function formatDateTime(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

// 日本時間の YYYY-MM-DD にする（TIM-1）
export function formatDate(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// u を付けないので \d は半角の数字だけ。秒・タイムゾーンは書けない形にする（TIM-3）
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// 日本時間の YYYY-MM-DDTHH:mm をミリ秒に直す（TIM-1, TIM-3）。
// Date.UTC は 02-30・24:00 などを繰り上げるので、戻した文字列が元と違えば断る
export function parseDateTime(s) {
  const match = DATE_TIME_PATTERN.exec(s);
  if (match === null) return { ok: false, code: 'INPUT_TIME' };
  const [, year, month, day, hour, minute] = match.map(Number);
  const value = Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS;
  if (formatDateTime(value) !== s) return { ok: false, code: 'INPUT_TIME' };
  return { ok: true, value };
}

// 日本時間の YYYY-MM-DD を、その日の 0:00 のミリ秒に直す（VIW-1）。s が null（クエリにない）でも断る
export function parseDate(s) {
  if (s === null) return { ok: false, code: 'INPUT_DATE' };
  const match = DATE_PATTERN.exec(s);
  if (match === null) return { ok: false, code: 'INPUT_DATE' };
  const [, year, month, day] = match.map(Number);
  const value = Date.UTC(year, month - 1, day) - JST_OFFSET_MS;
  if (formatDate(value) !== s) return { ok: false, code: 'INPUT_DATE' };
  return { ok: true, value };
}

// 秒以下を切り捨てて分の境界にする。現在時刻から nowMin を作るのに使う（TIM-4, TIM-6）
export function floorMinute(ms) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

// 試行を数える10分の区切りの始まり（rules.md 6.3、auth.md 7。SEC-3）。始まりを含む
export const ATTEMPT_WINDOW_MS = 600_000;

export function windowStart(now) {
  return Math.floor(now / ATTEMPT_WINDOW_MS) * ATTEMPT_WINDOW_MS;
}

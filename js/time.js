// 時刻の表示と計算（タイムゾーンは Asia/Tokyo）
// 判定はサーバーの now() で行う。ここの時計は表示のためだけに使う

const TZ = "Asia/Tokyo";
const hm = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const mdw = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, month: "numeric", day: "numeric", weekday: "short" });

// サーバーの時計とのずれ（ミリ秒）。get_home の server_now で合わせる
let offsetMs = 0;
export function syncClock(serverNowIso) {
  offsetMs = new Date(serverNowIso).getTime() - Date.now();
}
export function nowMs() {
  return Date.now() + offsetMs;
}

export function toMs(iso) {
  return new Date(iso).getTime();
}

// "16:42"
export function formatTime(value) {
  if (value == null) return "";
  return hm.format(new Date(value));
}

// "2026-11-08"
export function dateKey(value) {
  return ymd.format(new Date(value));
}

// "11/8(日)"
export function formatDate(value) {
  return mdw.format(new Date(value));
}

// "11/8(日) 16:42"。今日なら時刻だけ
export function formatDateTime(value) {
  const t = new Date(value);
  return dateKey(t) === dateKey(nowMs()) ? formatTime(t) : `${formatDate(t)} ${formatTime(t)}`;
}

// その日（東京時間）の 0:00 のミリ秒
export function dayStartMs(day) {
  return new Date(`${day}T00:00:00+09:00`).getTime();
}

// 日付と時刻の入力欄の値（東京時間）からミリ秒
export function fromInputs(day, time) {
  return new Date(`${day}T${time}:00+09:00`).getTime();
}

// ミリ秒から時刻の入力欄の値 "16:42"
export function toTimeInput(ms) {
  return formatTime(ms);
}

export function addDays(day, n) {
  return dateKey(dayStartMs(day) + n * 86400000 + 12 * 3600000);
}

export const MINUTE = 60000;

// 分単位に切り捨て・切り上げ
export function floorMinute(ms) {
  return Math.floor(ms / MINUTE) * MINUTE;
}
export function ceilMinute(ms) {
  return Math.ceil(ms / MINUTE) * MINUTE;
}

// "1時間30分"
export function formatDuration(ms) {
  const min = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}

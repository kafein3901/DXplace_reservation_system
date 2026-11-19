// 時刻（docs/design/detailed/rules.md 6.8、docs/design/basic/time-and-concurrency.md 1・2）
// 時刻はすべて 1970-01-01 00:00 UTC からのミリ秒の整数で扱う

export const MINUTE_MS = 60_000;
export const JST_OFFSET_MS = 32_400_000; // 9時間

// 日本時間の YYYY-MM-DDTHH:mm にする。秒以下は書かない（rules.md 6.8。TIM-1）。
// 日本時間との換算はこのファイルだけで行う
export function formatDateTime(ms) {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
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

// 時刻（docs/design/detailed/rules.md 6.8、docs/design/basic/time-and-concurrency.md 1・2）
// 時刻はすべて 1970-01-01 00:00 UTC からのミリ秒の整数で扱う

export const MINUTE_MS = 60_000;

// 秒以下を切り捨てて分の境界にする。現在時刻から nowMin を作るのに使う（TIM-4, TIM-6）
export function floorMinute(ms) {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

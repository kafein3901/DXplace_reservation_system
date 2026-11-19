// 予約の操作のルール（docs/design/detailed/rules.md 6.10〜。RSV-2〜RSV-6, TIM-6, TIM-7）
// 時刻はミリ秒。nowMin は秒を切り捨てた現在時刻。データは自動の変化を反映した後のもの（rules.md 5.3）
import { MINUTE_MS } from '../lib/time.js';
import { checkDeviceActive } from './devices.js';
import { settingAt } from './settings.js';

const OK = { ok: true };

// 確保済み（RSV-1）
function isActive(reservation) {
  return reservation.status === 'reserved' || reservation.status === 'in_use';
}

// 段 4：開始時刻は現在時刻以降（TIM-6）
export function checkStartNotPast(start, nowMin) {
  return start >= nowMin ? OK : { ok: false, code: 'RULE_PAST' };
}

// 段 4：終了時刻は現在時刻より後（TIM-6）
export function checkEndNotPast(end, nowMin) {
  return end > nowMin ? OK : { ok: false, code: 'RULE_PAST' };
}

// 段 5：終了 > 開始（TIM-7, RSV-5）
export function checkTimeOrder(start, end) {
  return end > start ? OK : { ok: false, code: 'RULE_TIME_ORDER' };
}

// 段 6：長さが上限以下（RSV-6）
export function checkLength(start, end, limitMinutes) {
  return end - start <= limitMinutes * MINUTE_MS ? OK : { ok: false, code: 'RULE_LENGTH' };
}

// 段 7：その利用者の確保済みの件数が上限未満（RSV-4）。予約なしの利用で始めたものは数えない（RSV-5, RSV-17）。
// userActive は全機器の予約
export function checkCount(userActive, limit) {
  const count = userActive.filter((reservation) => isActive(reservation) && reservation.walk_in === 0).length;
  return count < limit ? OK : { ok: false, code: 'RULE_COUNT' };
}

// 段 8：その機器の確保済みの予約と [start, end) が重ならない（RSV-1, RSV-3, TIM-2）。
// excludeId の予約は除く（確保では null）。同じ人の予約どうしも断る
export function checkOverlap(deviceActive, start, end, excludeId) {
  const overlaps = deviceActive.some(
    (reservation) =>
      isActive(reservation) && reservation.id !== excludeId && reservation.start_at < end && start < reservation.end_at,
  );
  return overlaps ? { ok: false, code: 'RULE_OVERLAP' } : OK;
}

// 確保（rules.md 6.10）。段 1 は api/ が先に確かめる。段 3 はない（新しく作るので状態がない）。
// 開室時間は確かめない（TIM-8）
export function checkReserve({ user, device, start, end, nowMin, settings, userActive, deviceActive }) {
  const steps = [
    () => (user === null ? { ok: false, code: 'NOT_FOUND_USER' } : OK),
    () => checkDeviceActive(device),
    () => checkStartNotPast(start, nowMin),
    () => checkEndNotPast(end, nowMin),
    () => checkTimeOrder(start, end),
    () => checkLength(start, end, settingAt(settings, 'max_length_minutes', nowMin)),
    () => checkCount(userActive, settingAt(settings, 'max_count', nowMin)),
    () => checkOverlap(deviceActive, start, end, null),
  ];
  for (const step of steps) {
    const result = step();
    if (!result.ok) return result;
  }
  return OK;
}

// 予約の操作のルール（docs/design/detailed/rules.md 6.10〜6.15。RSV-2〜RSV-20, TIM-4, TIM-6, TIM-7）
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

// 段 8：機器が空いている（RSV-20）。nowMin を含む確保済みの時間帯がない（TIM-2）。
// 自分の予約でも断る。RULE_OVERLAP より先に確かめ、「今は使えない」ことを見分けられるようにする（rules.md 6.11）
export function checkVacant(deviceActive, nowMin) {
  const busy = deviceActive.some(
    (reservation) => isActive(reservation) && reservation.start_at <= nowMin && nowMin < reservation.end_at,
  );
  return busy ? { ok: false, code: 'RULE_DEVICE_BUSY' } : OK;
}

// 段を順に確かめ、最初に断った段の結果を返す（RSV-27）。すべて通れば null
function firstRefusal(steps) {
  for (const step of steps) {
    const result = step();
    if (!result.ok) return result;
  }
  return null;
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
  return firstRefusal(steps) ?? OK;
}

// 予約なしの利用（rules.md 6.11。RSV-17）。開始時刻は nowMin で、入力から受け取らない（TIM-4, RSV-24）。
// 段 1 は api/ が先に確かめる。段 3 はない。段 5 は段 4 を通れば必ず成り立つので置かない。
// 段 7 はない（件数に数えない。RSV-17）
export function checkWalkIn({ user, device, end, nowMin, settings, deviceActive }) {
  const steps = [
    () => (user === null ? { ok: false, code: 'NOT_FOUND_USER' } : OK),
    () => checkDeviceActive(device),
    () => checkEndNotPast(end, nowMin),
    () => checkLength(nowMin, end, settingAt(settings, 'max_length_minutes', nowMin)),
    () => checkVacant(deviceActive, nowMin),
    () => checkOverlap(deviceActive, nowMin, end, null),
  ];
  return firstRefusal(steps) ?? { ok: true, start: nowMin };
}

// 自分の予約の一覧（rules.md 6.12。RSV-7）。段 1 は api/ が先に確かめる。
// 予約なしの利用で始めたものも出す。状態は rules でも確かめ、開始時刻の順（同じなら番号の順）に並べる。
// 要素は選ばずにそのまま返す
export function checkMyReservations({ user, userActive }) {
  if (user === null) return { ok: false, code: 'NOT_FOUND_USER' };
  const reservations = userActive
    .filter(isActive)
    .sort((a, b) => a.start_at - b.start_at || a.id - b.id);
  return { ok: true, reservations };
}

// 取消（rules.md 6.12。RSV-8）。段 1 は api/ が先に確かめる。段 4〜8 はない。
// 本人の予約でなければ、ないときと同じ NOT_FOUND_RESERVATION（状態を漏らさない）。
// 猶予の中の予約済は開始時刻を過ぎていても取り消せる。2回目の取消・利用中は STATE_NOT_RESERVED
export function checkCancel({ user, reservation }) {
  const own = checkOwnReservation(user, reservation);
  if (!own.ok) return own;
  if (reservation.status !== 'reserved') return { ok: false, code: 'STATE_NOT_RESERVED' };
  return OK;
}

// 段 2：利用者がいて、予約が本人のもの（rules.md 6.12・6.13）。
// 本人の予約でなければ、ないときと同じ NOT_FOUND_RESERVATION（予約があるか・状態を漏らさない）
function checkOwnReservation(user, reservation) {
  if (user === null) return { ok: false, code: 'NOT_FOUND_USER' };
  if (reservation === null || reservation.user_id !== user.id) return { ok: false, code: 'NOT_FOUND_RESERVATION' };
  return OK;
}

// 段 4：開始時刻を変えられるのは、変更前の開始時刻になる前だけ（RSV-11。TIM-2 と同じく、ちょうどの分からは変えられない）
export function checkStartNotPassed(oldStart, nowMin) {
  return nowMin < oldStart ? OK : { ok: false, code: 'RULE_START_PASSED' };
}

// 段 6：変更後の長さが上限以下、または変更前の長さ以下（RSV-12。上限を下げた後もずらす・短くするは受け付ける）
export function checkChangeLength(oldStart, oldEnd, newStart, newEnd, limitMinutes) {
  const length = newEnd - newStart;
  return length <= limitMinutes * MINUTE_MS || length <= oldEnd - oldStart ? OK : { ok: false, code: 'RULE_LENGTH' };
}

// 時間帯の変更（rules.md 6.13。RSV-9〜RSV-12）。段 1 は api/ が先に確かめる。
// start・end は変更後の値で、変えない側は今と同じ値。今と同じ値の側を「変えない時刻」とする。
// 利用中の開始は必ず nowMin 以下なので、段 4 の RSV-11 の条件だけで RSV-10（終了時刻だけ）が守られる。
// 段 7 はない（件数を理由に断らない。RSV-12）。両方とも変えないときも段 3〜8 を確かめる（必ず通る）
export function checkChange({ user, reservation, start, end, nowMin, settings, deviceActive }) {
  const r = reservation;
  const steps = [
    () => checkOwnReservation(user, r),
    () => (isActive(r) ? OK : { ok: false, code: 'STATE_NOT_ACTIVE' }),
    () => (start !== r.start_at ? checkStartNotPassed(r.start_at, nowMin) : OK),
    () => (start !== r.start_at ? checkStartNotPast(start, nowMin) : OK),
    () => (end !== r.end_at ? checkEndNotPast(end, nowMin) : OK),
    () => checkTimeOrder(start, end),
    () => checkChangeLength(r.start_at, r.end_at, start, end, settingAt(settings, 'max_length_minutes', nowMin)),
    () => checkOverlap(deviceActive, start, end, r.id),
  ];
  const refusal = firstRefusal(steps);
  if (refusal !== null) return refusal;
  return { ok: true, action: start === r.start_at && end === r.end_at ? 'unchanged' : 'change' };
}

// 段 6：前倒しの長さが上限以下（RSV-6, RSV-15）。条件は checkLength と同じで、コードだけを分ける（rules.md 6.14）
export function checkBeginLength(nowMin, end, limitMinutes) {
  return checkLength(nowMin, end, limitMinutes).ok ? OK : { ok: false, code: 'RULE_BEGIN_LENGTH' };
}

// 段 8：[nowMin, 開始) に、その予約を除く確保済みの予約がない（RSV-15, RSV-3, TIM-2）。
// 条件は checkOverlap と同じで、コードだけを分ける（rules.md 6.14）
export function checkBeginOverlap(deviceActive, nowMin, start, excludeId) {
  return checkOverlap(deviceActive, nowMin, start, excludeId).ok ? OK : { ok: false, code: 'RULE_BEGIN_OVERLAP' };
}

// 利用開始（rules.md 6.14。RSV-13〜RSV-16, RSV-6）。段 1 は api/ が先に確かめる。
// 段 4・5 はない（反映した後の予約済は必ず猶予のうち。RSV-13, RSV-16）。段 7 はない（件数は変わらない）。
// 前倒し（nowMin < 開始）のときだけ段 6・8 を確かめ、開始時刻を nowMin にする（RSV-15, TIM-4）。
// 前倒しでなければ時刻を変えない（上限を下げた後も、確保済みの予約は利用開始できる。RSV-25）
export function checkBegin({ user, reservation, nowMin, settings, deviceActive }) {
  const r = reservation;
  const early = () => r.start_at > nowMin;
  const steps = [
    () => checkOwnReservation(user, r),
    () => (r.status === 'reserved' ? OK : { ok: false, code: 'STATE_NOT_RESERVED' }),
    () => (early() ? checkBeginLength(nowMin, r.end_at, settingAt(settings, 'max_length_minutes', nowMin)) : OK),
    () => (early() ? checkBeginOverlap(deviceActive, nowMin, r.start_at, r.id) : OK),
  ];
  return firstRefusal(steps) ?? { ok: true, start: early() ? nowMin : r.start_at };
}

// 利用終了（rules.md 6.15。RSV-18, RSV-19, TIM-7）。段 1 は api/ が先に確かめる。段 4〜8 はない。
// 予約なしの利用で始めたものも同じ（RSV-17）。開始と同じ分に終えると長さ0になり、それを認める（TIM-7）
export function checkFinish({ user, reservation, nowMin }) {
  const own = checkOwnReservation(user, reservation);
  if (!own.ok) return own;
  if (reservation.status !== 'in_use') return { ok: false, code: 'STATE_NOT_IN_USE' };
  return { ok: true, end: nowMin };
}

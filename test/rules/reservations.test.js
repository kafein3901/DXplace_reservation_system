// 確保・予約なしの利用（rules.md 6.10・6.11）。時刻は nowMin = 10:00、上限は初期値（3件、1440分）
import { describe, expect, test } from 'vitest';
import {
  checkCount,
  checkEndNotPast,
  checkLength,
  checkOverlap,
  checkReserve,
  checkStartNotPast,
  checkTimeOrder,
  checkVacant,
  checkWalkIn,
} from '../../src/rules/reservations.js';

const MIN = 60_000;
const T = (hour, minute = 0) => Date.UTC(2026, 10, 20, hour - 9, minute); // 2026-11-20 の日本時間
const NOW = T(10);

const SETTINGS = [
  { id: 1, key: 'max_count', value: 3, effective_at: 0 },
  { id: 2, key: 'grace_minutes', value: 15, effective_at: 0 },
  { id: 3, key: 'max_length_minutes', value: 1440, effective_at: 0 },
];

let nextId = 100;
const r = ({ start = T(10), end = T(11), status = 'reserved', walkIn = 0, id = nextId++, deviceId = 1 } = {}) => ({
  id,
  device_id: deviceId,
  user_id: 1,
  start_at: start,
  end_at: end,
  status,
  walk_in: walkIn,
});

const PAST_STATES = ['cancelled', 'no_show', 'finished', 'admin_cancelled', 'admin_finished'];

describe('TIM-6 過去の時刻（checkStartNotPast・checkEndNotPast）', () => {
  test('TIM-6 開始がちょうど nowMin は受け付ける', () => {
    expect(checkStartNotPast(T(10), NOW)).toEqual({ ok: true });
  });

  test('TIM-6 開始が1分前は RULE_PAST', () => {
    expect(checkStartNotPast(T(9, 59), NOW)).toEqual({ ok: false, code: 'RULE_PAST' });
  });

  test('TIM-6 終了が1分後は受け付ける', () => {
    expect(checkEndNotPast(T(10, 1), NOW)).toEqual({ ok: true });
  });

  test('TIM-6 終了がちょうど nowMin は RULE_PAST', () => {
    expect(checkEndNotPast(T(10), NOW)).toEqual({ ok: false, code: 'RULE_PAST' });
  });
});

describe('TIM-7 終了 > 開始（checkTimeOrder。RSV-5）', () => {
  test('TIM-7 終了が開始の1分後は受け付ける', () => {
    expect(checkTimeOrder(T(10), T(10, 1))).toEqual({ ok: true });
  });

  test('TIM-7 終了 = 開始は RULE_TIME_ORDER', () => {
    expect(checkTimeOrder(T(10), T(10))).toEqual({ ok: false, code: 'RULE_TIME_ORDER' });
  });

  test('TIM-7 終了 < 開始は RULE_TIME_ORDER', () => {
    expect(checkTimeOrder(T(11), T(10))).toEqual({ ok: false, code: 'RULE_TIME_ORDER' });
  });
});

describe('RSV-6 長さの上限（checkLength）', () => {
  test('RSV-6 1440分ちょうどは受け付ける', () => {
    expect(checkLength(T(10), T(10) + 1440 * MIN, 1440)).toEqual({ ok: true });
  });

  test('RSV-6 1441分は RULE_LENGTH', () => {
    expect(checkLength(T(10), T(10) + 1441 * MIN, 1440)).toEqual({ ok: false, code: 'RULE_LENGTH' });
  });
});

describe('RSV-4 件数の上限（checkCount）', () => {
  test('RSV-4 予約済・利用中が2件なら受け付ける', () => {
    expect(checkCount([r(), r({ status: 'in_use' })], 3)).toEqual({ ok: true });
  });

  test('RSV-5 予約なしの利用で始めた利用中は数えない', () => {
    const walkIns = [1, 2, 3].map(() => r({ status: 'in_use', walkIn: 1 }));
    expect(checkCount(walkIns, 3)).toEqual({ ok: true });
  });

  test('RSV-4 取消・無断不使用・終了などは数えない', () => {
    expect(checkCount([r(), r(), ...PAST_STATES.map((status) => r({ status }))], 3)).toEqual({ ok: true });
  });

  test('RSV-4 別の機器の予約も合わせて数え、3件で RULE_COUNT', () => {
    const list = [r({ deviceId: 1 }), r({ deviceId: 2 }), r({ deviceId: 3, status: 'in_use' })];
    expect(checkCount(list, 3)).toEqual({ ok: false, code: 'RULE_COUNT' });
  });

  test('RSV-4 上限が1なら1件で RULE_COUNT', () => {
    expect(checkCount([r()], 1)).toEqual({ ok: false, code: 'RULE_COUNT' });
  });
});

describe('RSV-3 重なり（checkOverlap。TIM-2）', () => {
  const existing = r({ start: T(10), end: T(11), id: 1 });

  test.each([
    ['[11:00, 12:00)', T(11), T(12)],
    ['[9:00, 10:00)', T(9), T(10)],
  ])('RSV-3 既存 [10:00, 11:00) に対して %s は受け付ける', (_, start, end) => {
    expect(checkOverlap([existing], start, end, null)).toEqual({ ok: true });
  });

  test.each([
    ['[10:59, 11:30)', T(10, 59), T(11, 30)],
    ['[9:00, 10:01)', T(9), T(10, 1)],
    ['[10:15, 10:45)（含まれる）', T(10, 15), T(10, 45)],
    ['[9:00, 12:00)（含む）', T(9), T(12)],
    ['同じ時間帯', T(10), T(11)],
  ])('RSV-3 既存 [10:00, 11:00) に対して %s は RULE_OVERLAP', (_, start, end) => {
    expect(checkOverlap([existing], start, end, null)).toEqual({ ok: false, code: 'RULE_OVERLAP' });
  });

  test('RSV-3 既存が利用中でも RULE_OVERLAP', () => {
    expect(checkOverlap([r({ status: 'in_use' })], T(10), T(11), null)).toEqual({ ok: false, code: 'RULE_OVERLAP' });
  });

  test.each(PAST_STATES)('RSV-1 既存が %s なら同じ時間帯でも受け付ける', (status) => {
    expect(checkOverlap([r({ status })], T(10), T(11), null)).toEqual({ ok: true });
  });

  test('RSV-3 excludeId の予約は除く', () => {
    expect(checkOverlap([existing], T(10), T(11), 1)).toEqual({ ok: true });
  });
});

describe('RSV-2 確保（checkReserve）', () => {
  const user = { id: 1, role: 'student', student_id: '12345678', name: '山田', cohort: 12 };
  const device = { id: 1, name: 'PC1', created_at: 0, deleted_at: null };
  const deletedDevice = { ...device, deleted_at: 1 };
  const base = { user, device, start: T(10), end: T(11), nowMin: NOW, settings: SETTINGS, userActive: [], deviceActive: [] };
  const three = [r({ deviceId: 2 }), r({ deviceId: 2 }), r({ deviceId: 3 })];

  test('RSV-2 すべての段を通る入力は受け付ける', () => {
    expect(checkReserve(base)).toEqual({ ok: true });
  });

  test('TIM-8 深夜 [2:00, 3:00) と休日（日曜日）の時間帯も受け付ける', () => {
    expect(checkReserve({ ...base, start: T(26), end: T(27) })).toEqual({ ok: true }); // 11月21日 2:00
    const sunday = Date.UTC(2026, 10, 22, 1, 0); // 2026-11-22（日）10:00
    expect(checkReserve({ ...base, start: sunday, end: sunday + 60 * MIN })).toEqual({ ok: true });
  });

  test('RSV-2 user が null なら NOT_FOUND_USER', () => {
    expect(checkReserve({ ...base, user: null })).toEqual({ ok: false, code: 'NOT_FOUND_USER' });
  });

  test('MNG-1 device が null・削除済みなら NOT_FOUND_DEVICE', () => {
    expect(checkReserve({ ...base, device: null })).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
    expect(checkReserve({ ...base, device: deletedDevice })).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('RSV-6 上限を 60 に変えた履歴（effective_at が nowMin ちょうど）では61分を RULE_LENGTH', () => {
    const settings = [...SETTINGS, { id: 4, key: 'max_length_minutes', value: 60, effective_at: NOW }];
    expect(checkReserve({ ...base, settings, end: T(11, 1) })).toEqual({ ok: false, code: 'RULE_LENGTH' });
    expect(checkReserve({ ...base, settings, end: T(11) })).toEqual({ ok: true });
  });

  test('RSV-4 上限を 1 に変えた履歴では1件で RULE_COUNT', () => {
    const settings = [...SETTINGS, { id: 4, key: 'max_count', value: 1, effective_at: NOW }];
    expect(checkReserve({ ...base, settings, userActive: [r({ deviceId: 2 })] })).toEqual({
      ok: false,
      code: 'RULE_COUNT',
    });
  });

  test('RSV-3 その機器の予約と重なれば RULE_OVERLAP', () => {
    expect(checkReserve({ ...base, deviceActive: [r()] })).toEqual({ ok: false, code: 'RULE_OVERLAP' });
  });

  describe('RSV-27 確かめる順', () => {
    test('RSV-27 user が null で機器も削除済み → NOT_FOUND_USER', () => {
      expect(checkReserve({ ...base, user: null, device: deletedDevice })).toEqual({
        ok: false,
        code: 'NOT_FOUND_USER',
      });
    });

    test('RSV-27 機器が削除済みかつ過去 → NOT_FOUND_DEVICE', () => {
      expect(checkReserve({ ...base, device: deletedDevice, start: T(9) })).toEqual({
        ok: false,
        code: 'NOT_FOUND_DEVICE',
      });
    });

    test('RSV-27 過去かつ長さ超え → RULE_PAST', () => {
      expect(checkReserve({ ...base, start: T(9), end: T(9) + 1441 * MIN })).toEqual({ ok: false, code: 'RULE_PAST' });
    });

    test('RSV-27 終了 = 開始かつ件数超え → RULE_TIME_ORDER', () => {
      // 終了が nowMin 以前だと段 4 で断るので、先の時刻で終了 = 開始にする
      expect(checkReserve({ ...base, start: T(12), end: T(12), userActive: three })).toEqual({
        ok: false,
        code: 'RULE_TIME_ORDER',
      });
    });

    test('RSV-27 長さ超えかつ件数超え → RULE_LENGTH', () => {
      expect(checkReserve({ ...base, end: T(10) + 1441 * MIN, userActive: three })).toEqual({
        ok: false,
        code: 'RULE_LENGTH',
      });
    });

    test('RSV-27 件数超えかつ重なり → RULE_COUNT', () => {
      expect(checkReserve({ ...base, userActive: three, deviceActive: [r()] })).toEqual({
        ok: false,
        code: 'RULE_COUNT',
      });
    });
  });
});

describe('RSV-20 空いている（checkVacant。TIM-2）', () => {
  test('RSV-20 予約がない・ちょうど nowMin に終わる・nowMin より後に始まるなら受け付ける', () => {
    expect(checkVacant([], NOW)).toEqual({ ok: true });
    expect(checkVacant([r({ start: T(9), end: T(10) })], NOW)).toEqual({ ok: true });
    expect(checkVacant([r({ start: T(10, 1), end: T(11) })], NOW)).toEqual({ ok: true });
  });

  test.each(PAST_STATES)('RSV-20 [9:00, 11:00) が %s なら受け付ける', (status) => {
    expect(checkVacant([r({ start: T(9), end: T(11), status })], NOW)).toEqual({ ok: true });
  });

  test.each(['in_use', 'reserved'])('RSV-20 [9:00, 11:00) が %s なら RULE_DEVICE_BUSY', (status) => {
    expect(checkVacant([r({ start: T(9), end: T(11), status })], NOW)).toEqual({ ok: false, code: 'RULE_DEVICE_BUSY' });
  });

  test('RSV-20 ちょうど nowMin に始まる予約があれば RULE_DEVICE_BUSY', () => {
    expect(checkVacant([r({ start: T(10), end: T(11) })], NOW)).toEqual({ ok: false, code: 'RULE_DEVICE_BUSY' });
  });
});

describe('RSV-17 予約なしの利用（checkWalkIn）', () => {
  const user = { id: 1, role: 'student', student_id: '12345678', name: '山田', cohort: 12 };
  const device = { id: 1, name: 'PC1', created_at: 0, deleted_at: null };
  const deletedDevice = { ...device, deleted_at: 1 };
  const base = { user, device, end: T(11), nowMin: NOW, settings: SETTINGS, deviceActive: [] };
  const busy = r({ start: T(9), end: T(11), status: 'in_use' });

  test('RSV-17 すべての段を通る入力は受け付け、start は nowMin', () => {
    expect(checkWalkIn(base)).toEqual({ ok: true, start: NOW });
    expect(checkWalkIn({ ...base, end: T(10, 1) })).toEqual({ ok: true, start: NOW });
  });

  test('RSV-17 user が null なら NOT_FOUND_USER', () => {
    expect(checkWalkIn({ ...base, user: null })).toEqual({ ok: false, code: 'NOT_FOUND_USER' });
  });

  test('MNG-1 device が null・削除済みなら NOT_FOUND_DEVICE', () => {
    expect(checkWalkIn({ ...base, device: null })).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
    expect(checkWalkIn({ ...base, device: deletedDevice })).toEqual({ ok: false, code: 'NOT_FOUND_DEVICE' });
  });

  test('TIM-6 終了がちょうど nowMin・それより前なら RULE_PAST（RULE_TIME_ORDER にならない）', () => {
    expect(checkWalkIn({ ...base, end: T(10) })).toEqual({ ok: false, code: 'RULE_PAST' });
    expect(checkWalkIn({ ...base, end: T(9, 59) })).toEqual({ ok: false, code: 'RULE_PAST' });
  });

  test('RSV-6 1440分は受け付け、1441分は RULE_LENGTH', () => {
    expect(checkWalkIn({ ...base, end: T(34) })).toEqual({ ok: true, start: NOW }); // 翌日 10:00
    expect(checkWalkIn({ ...base, end: T(34, 1) })).toEqual({ ok: false, code: 'RULE_LENGTH' });
  });

  test('RSV-6 上限を 60 に変えた履歴（effective_at が nowMin ちょうど）では61分を RULE_LENGTH', () => {
    const settings = [...SETTINGS, { id: 4, key: 'max_length_minutes', value: 60, effective_at: NOW }];
    expect(checkWalkIn({ ...base, settings, end: T(11, 1) })).toEqual({ ok: false, code: 'RULE_LENGTH' });
    expect(checkWalkIn({ ...base, settings, end: T(11) })).toEqual({ ok: true, start: NOW });
  });

  test('RSV-3 予約済 [10:30, 11:00) に対して終了 10:30 は受け付け、10:31 は RULE_OVERLAP（自分の予約でも）', () => {
    const later = r({ start: T(10, 30), end: T(11) }); // user_id は利用者と同じ 1
    expect(checkWalkIn({ ...base, end: T(10, 30), deviceActive: [later] })).toEqual({ ok: true, start: NOW });
    expect(checkWalkIn({ ...base, end: T(10, 31), deviceActive: [later] })).toEqual({
      ok: false,
      code: 'RULE_OVERLAP',
    });
  });

  test('RSV-20 現在時刻を含む予約があれば RULE_DEVICE_BUSY（自分の予約でも）', () => {
    expect(checkWalkIn({ ...base, deviceActive: [busy] })).toEqual({ ok: false, code: 'RULE_DEVICE_BUSY' });
  });

  test('RSV-17 件数を数えないので、予約済・利用中が上限（3件）ある利用者でも受け付ける', () => {
    // checkWalkIn は利用者の予約を受け取らない。上限ちょうどの件数があっても判定に入らない
    const three = [r({ deviceId: 2 }), r({ deviceId: 2 }), r({ deviceId: 3 })];
    expect(checkWalkIn({ ...base, userActive: three })).toEqual({ ok: true, start: NOW });
  });

  describe('RSV-27 確かめる順', () => {
    test('RSV-27 user が null で機器も削除済み → NOT_FOUND_USER', () => {
      expect(checkWalkIn({ ...base, user: null, device: deletedDevice })).toEqual({
        ok: false,
        code: 'NOT_FOUND_USER',
      });
    });

    test('RSV-27 過去かつ空いていない → RULE_PAST', () => {
      expect(checkWalkIn({ ...base, end: T(10), deviceActive: [busy] })).toEqual({ ok: false, code: 'RULE_PAST' });
    });

    test('RSV-27 長さ超えかつ空いていない → RULE_LENGTH', () => {
      expect(checkWalkIn({ ...base, end: T(34, 1), deviceActive: [busy] })).toEqual({
        ok: false,
        code: 'RULE_LENGTH',
      });
    });

    test('RSV-27 空いていないかつ後の予約とも重なる → RULE_DEVICE_BUSY', () => {
      const later = r({ start: T(11, 30), end: T(12) });
      expect(checkWalkIn({ ...base, end: T(12), deviceActive: [busy, later] })).toEqual({
        ok: false,
        code: 'RULE_DEVICE_BUSY',
      });
    });
  });
});

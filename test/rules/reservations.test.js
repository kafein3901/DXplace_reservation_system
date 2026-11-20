// 確保・予約なしの利用・自分の予約・取消・時間帯の変更・利用開始・利用終了（rules.md 6.10〜6.15）。時刻は nowMin = 10:00、上限は初期値（3件、1440分）
import { describe, expect, test } from 'vitest';
import {
  checkBegin,
  checkBeginLength,
  checkBeginOverlap,
  checkCancel,
  checkChange,
  checkChangeLength,
  checkCount,
  checkEndNotPast,
  checkFinish,
  checkLength,
  checkMyReservations,
  checkOverlap,
  checkReserve,
  checkStartNotPassed,
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

describe('RSV-7 自分の予約の一覧（checkMyReservations）', () => {
  const USER = { id: 1 };

  test('RSV-7 予約済・利用中（予約なしの利用を含む）を開始時刻の順に、同じ開始時刻なら番号の順に返す。別の機器も合わせる', () => {
    const a = r({ id: 5, start: T(12), end: T(13) });
    const b = r({ id: 3, start: T(10), end: T(11), status: 'in_use', walkIn: 1, deviceId: 2 });
    const c = r({ id: 2, start: T(12), end: T(14), deviceId: 2 });
    expect(checkMyReservations({ user: USER, userActive: [a, b, c] })).toEqual({ ok: true, reservations: [b, c, a] });
  });

  test('RSV-7 要素はそのまま返す（項目を選ばない）', () => {
    const a = { ...r(), device_name: 'PC1' };
    expect(checkMyReservations({ user: USER, userActive: [a] }).reservations[0]).toBe(a);
  });

  test('RSV-7 userActive が空なら空の配列', () => {
    expect(checkMyReservations({ user: USER, userActive: [] })).toEqual({ ok: true, reservations: [] });
  });

  test('RSV-7 取消・無断不使用・終了などが混ざっていても落とす', () => {
    const active = r({ start: T(11) });
    const past = PAST_STATES.map((status) => r({ status }));
    expect(checkMyReservations({ user: USER, userActive: [...past, active] }).reservations).toEqual([active]);
  });

  test('RSV-7 user が null なら NOT_FOUND_USER', () => {
    expect(checkMyReservations({ user: null, userActive: [] })).toEqual({ ok: false, code: 'NOT_FOUND_USER' });
  });
});

describe('RSV-8 取消（checkCancel）', () => {
  const USER = { id: 1 };

  test('RSV-8 本人の予約済は受け付ける', () => {
    expect(checkCancel({ user: USER, reservation: r({ start: T(11), end: T(12) }) })).toEqual({ ok: true });
  });

  test('RSV-8 開始時刻を過ぎた予約済（猶予の中）も受け付ける', () => {
    expect(checkCancel({ user: USER, reservation: r({ start: T(9, 50), end: T(11) }) })).toEqual({ ok: true });
  });

  test('RSV-8 user が null なら NOT_FOUND_USER', () => {
    expect(checkCancel({ user: null, reservation: r() })).toEqual({ ok: false, code: 'NOT_FOUND_USER' });
  });

  test('RSV-8 reservation が null なら NOT_FOUND_RESERVATION', () => {
    expect(checkCancel({ user: USER, reservation: null })).toEqual({ ok: false, code: 'NOT_FOUND_RESERVATION' });
  });

  test('RSV-8 他の利用者の予約は NOT_FOUND_RESERVATION', () => {
    expect(checkCancel({ user: { id: 2 }, reservation: r() })).toEqual({ ok: false, code: 'NOT_FOUND_RESERVATION' });
  });

  test.each(['in_use', ...PAST_STATES])('RSV-8 本人の %s は STATE_NOT_RESERVED', (status) => {
    expect(checkCancel({ user: USER, reservation: r({ status }) })).toEqual({ ok: false, code: 'STATE_NOT_RESERVED' });
  });
});

describe('RSV-27 取消の確かめる順（checkCancel）', () => {
  test('RSV-27 user が null で予約も null なら NOT_FOUND_USER', () => {
    expect(checkCancel({ user: null, reservation: null }).code).toBe('NOT_FOUND_USER');
  });

  test('RSV-27 他の利用者の取消済みの予約は NOT_FOUND_RESERVATION（STATE_ にならない）', () => {
    expect(checkCancel({ user: { id: 2 }, reservation: r({ status: 'cancelled' }) }).code).toBe('NOT_FOUND_RESERVATION');
  });
});

describe('RSV-11 変更前の開始時刻を過ぎていない（checkStartNotPassed）', () => {
  test('RSV-11 変更前の開始 10:01 は受け付ける', () => {
    expect(checkStartNotPassed(T(10, 1), NOW)).toEqual({ ok: true });
  });

  test.each([
    ['10:00（ちょうど nowMin）', T(10)],
    ['9:59', T(9, 59)],
  ])('RSV-11 変更前の開始 %s は RULE_START_PASSED', (_label, oldStart) => {
    expect(checkStartNotPassed(oldStart, NOW)).toEqual({ ok: false, code: 'RULE_START_PASSED' });
  });
});

describe('RSV-12 変更の長さ（checkChangeLength）', () => {
  test('RSV-12 新しい長さが1440分ちょうどは受け付ける', () => {
    expect(checkChangeLength(T(11), T(12), T(11), T(11) + 1440 * MIN, 1440)).toEqual({ ok: true });
  });

  test.each([
    ['変更前 120分 → 120分（ずらす）', T(11), T(13), T(12), T(14)],
    ['変更前 120分 → 90分', T(11), T(13), T(11), T(12, 30)],
    ['変更前 30分 → 60分', T(11), T(11, 30), T(11), T(12)],
  ])('RSV-12 上限 60 で %s は受け付ける', (_label, oldStart, oldEnd, newStart, newEnd) => {
    expect(checkChangeLength(oldStart, oldEnd, newStart, newEnd, 60)).toEqual({ ok: true });
  });

  test.each([
    ['変更前 30分 → 61分', T(11), T(11, 30), T(11), T(12, 1)],
    ['変更前 120分 → 121分', T(11), T(13), T(11), T(13, 1)],
  ])('RSV-12 上限 60 で %s は RULE_LENGTH', (_label, oldStart, oldEnd, newStart, newEnd) => {
    expect(checkChangeLength(oldStart, oldEnd, newStart, newEnd, 60)).toEqual({ ok: false, code: 'RULE_LENGTH' });
  });
});

describe('RSV-9 時間帯の変更（checkChange）', () => {
  const USER = { id: 1 };
  // start・end を省くと今の値（変えない時刻）。reservation は deviceActive にも入れる（その予約自身を含む。api.md 8.32）
  const change = ({ user = USER, reservation, start, end, settings = SETTINGS, others = [] }) =>
    checkChange({
      user,
      reservation,
      start: start ?? reservation?.start_at,
      end: end ?? reservation?.end_at,
      nowMin: NOW,
      settings,
      deviceActive: reservation === null ? others : [reservation, ...others],
    });

  test.each([
    ['[13:00, 14:00)', T(13), T(14)],
    ['[10:00, 11:00)（開始がちょうど nowMin）', T(10), T(11)],
    ['[11:00, 12:30)', T(11), T(12, 30)],
    ['[11:30, 12:00)', T(11, 30), T(12)],
  ])('RSV-9 予約済 [11:00, 12:00) を %s にすると change', (_label, start, end) => {
    const reservation = r({ start: T(11), end: T(12) });
    expect(change({ reservation, start, end })).toEqual({ ok: true, action: 'change' });
  });

  test('RSV-9 両方とも今と同じなら unchanged', () => {
    expect(change({ reservation: r({ start: T(11), end: T(12) }) })).toEqual({ ok: true, action: 'unchanged' });
  });

  test('RSV-9 user が null なら NOT_FOUND_USER', () => {
    expect(change({ user: null, reservation: r({ start: T(11), end: T(12) }) }).code).toBe('NOT_FOUND_USER');
  });

  test('RSV-9 reservation が null なら NOT_FOUND_RESERVATION', () => {
    expect(change({ reservation: null, start: T(11), end: T(12) }).code).toBe('NOT_FOUND_RESERVATION');
  });

  test('RSV-9 他の利用者の予約は NOT_FOUND_RESERVATION', () => {
    expect(change({ user: { id: 2 }, reservation: r({ start: T(11), end: T(12) }) }).code).toBe(
      'NOT_FOUND_RESERVATION',
    );
  });

  test.each(['reserved', 'in_use'])('RSV-9 状態が %s なら受け付ける', (status) => {
    const reservation = r({ start: T(9), end: T(11), status });
    expect(change({ reservation, end: T(12) })).toEqual({ ok: true, action: 'change' });
  });

  test.each(PAST_STATES)('RSV-9 状態が %s なら STATE_NOT_ACTIVE', (status) => {
    const reservation = r({ start: T(11), end: T(12), status });
    expect(change({ reservation, start: T(13), end: T(14) })).toEqual({ ok: false, code: 'STATE_NOT_ACTIVE' });
  });

  describe('RSV-10 利用中', () => {
    test.each([
      ['12:00（延長）', T(12)],
      ['10:01（短縮）', T(10, 1)],
    ])('RSV-10 利用中 [9:00, 11:00) の終了を %s にできる', (_label, end) => {
      expect(change({ reservation: r({ start: T(9), end: T(11), status: 'in_use' }), end }).ok).toBe(true);
    });

    test('RSV-10 予約なしの利用で始めたものも終了を変えられる', () => {
      const reservation = r({ start: T(9), end: T(11), status: 'in_use', walkIn: 1 });
      expect(change({ reservation, end: T(12) })).toEqual({ ok: true, action: 'change' });
    });

    test('RSV-10 開始を 9:30 にすると RULE_START_PASSED', () => {
      const reservation = r({ start: T(9), end: T(11), status: 'in_use' });
      expect(change({ reservation, start: T(9, 30) }).code).toBe('RULE_START_PASSED');
    });

    test('RSV-10 終了を 10:00（ちょうど nowMin）にすると RULE_PAST', () => {
      const reservation = r({ start: T(9), end: T(11), status: 'in_use' });
      expect(change({ reservation, end: T(10) }).code).toBe('RULE_PAST');
    });
  });

  describe('RSV-11 猶予の中の予約済', () => {
    test('RSV-11 予約済 [9:55, 11:00) の終了を 11:30 にできる（開始は今と同じ）', () => {
      const reservation = r({ start: T(9, 55), end: T(11) });
      expect(change({ reservation, end: T(11, 30) })).toEqual({ ok: true, action: 'change' });
    });

    test('RSV-11 開始を 10:05 にすると RULE_START_PASSED（新しい開始が未来でも断る）', () => {
      const reservation = r({ start: T(9, 55), end: T(11) });
      expect(change({ reservation, start: T(10, 5) }).code).toBe('RULE_START_PASSED');
    });
  });

  describe('TIM-6 過去の時刻', () => {
    test('TIM-6 開始を nowMin ちょうどに、終了を 10:01 にできる', () => {
      expect(change({ reservation: r({ start: T(11), end: T(12) }), start: T(10) }).ok).toBe(true);
      expect(change({ reservation: r({ start: T(9), end: T(11), status: 'in_use' }), end: T(10, 1) }).ok).toBe(true);
    });

    test('TIM-6 予約済 [11:00, 12:00) の開始を 9:59 にすると RULE_PAST', () => {
      expect(change({ reservation: r({ start: T(11), end: T(12) }), start: T(9, 59) }).code).toBe('RULE_PAST');
    });

    test('TIM-6 予約済 [11:00, 12:00) の終了を 10:00 にすると RULE_PAST', () => {
      expect(change({ reservation: r({ start: T(11), end: T(12) }), end: T(10) }).code).toBe('RULE_PAST');
    });
  });

  describe('TIM-7 終了 > 開始', () => {
    test('TIM-7 開始だけを終了の1分前にできる', () => {
      expect(change({ reservation: r({ start: T(11), end: T(12) }), start: T(11, 59) }).ok).toBe(true);
    });

    test.each([
      ['12:00', T(12)],
      ['12:30', T(12, 30)],
    ])('TIM-7 予約済 [11:00, 12:00) の開始だけを %s にすると RULE_TIME_ORDER', (_label, start) => {
      expect(change({ reservation: r({ start: T(11), end: T(12) }), start }).code).toBe('RULE_TIME_ORDER');
    });
  });

  test('RSV-12 予約済・利用中が上限（3件）ある利用者の予約の変更も受け付ける（件数を数えない）', () => {
    const reservation = r({ start: T(11), end: T(12) });
    const others = [r({ start: T(13), end: T(14) }), r({ start: T(15), end: T(16) })];
    expect(change({ reservation, start: T(17), end: T(18), others }).ok).toBe(true);
  });

  describe('RSV-3 重なり', () => {
    const other = () => r({ start: T(12), end: T(13) });

    test.each([
      ['[11:00, 12:00) のまま', T(11), T(12)],
      ['[11:30, 12:00)', T(11, 30), T(12)],
      ['[10:30, 11:30)（元の自分と重なる）', T(10, 30), T(11, 30)],
    ])('RSV-3 既存 [12:00, 13:00) に対して [11:00, 12:00) を %s にできる', (_label, start, end) => {
      expect(change({ reservation: r({ start: T(11), end: T(12) }), start, end, others: [other()] }).ok).toBe(true);
    });

    test('RSV-3 [11:00, 12:01) にすると RULE_OVERLAP（既存が自分の別の予約でも断る）', () => {
      const result = change({ reservation: r({ start: T(11), end: T(12) }), end: T(12, 1), others: [other()] });
      expect(result).toEqual({ ok: false, code: 'RULE_OVERLAP' });
    });

    test('RSV-3 利用中の延長が後の予約と重なると RULE_OVERLAP', () => {
      const reservation = r({ start: T(9), end: T(11), status: 'in_use' });
      expect(change({ reservation, end: T(12, 30), others: [other()] }).code).toBe('RULE_OVERLAP');
    });
  });

  describe('RSV-27 確かめる順', () => {
    test('RSV-27 user が null で予約も null なら NOT_FOUND_USER', () => {
      expect(change({ user: null, reservation: null, start: T(11), end: T(12) }).code).toBe('NOT_FOUND_USER');
    });

    test('RSV-27 他の利用者の取消済みの予約は NOT_FOUND_RESERVATION', () => {
      const reservation = r({ start: T(11), end: T(12), status: 'cancelled' });
      expect(change({ user: { id: 2 }, reservation, start: T(13) }).code).toBe('NOT_FOUND_RESERVATION');
    });

    test('RSV-27 本人の取消済みの予約で新しい開始も過去なら STATE_NOT_ACTIVE', () => {
      const reservation = r({ start: T(11), end: T(12), status: 'cancelled' });
      expect(change({ reservation, start: T(9) }).code).toBe('STATE_NOT_ACTIVE');
    });

    test('RSV-27 利用中で開始も過去にすると RULE_START_PASSED（RULE_PAST にならない）', () => {
      const reservation = r({ start: T(9), end: T(11), status: 'in_use' });
      expect(change({ reservation, start: T(8) }).code).toBe('RULE_START_PASSED');
    });

    test('RSV-27 過去かつ長さ超えなら RULE_PAST', () => {
      const reservation = r({ start: T(11), end: T(12) });
      expect(change({ reservation, start: T(9), end: T(9) + 1441 * MIN }).code).toBe('RULE_PAST');
    });

    test('RSV-27 終了 ≤ 開始かつ重なりなら RULE_TIME_ORDER', () => {
      const reservation = r({ start: T(11), end: T(12) });
      const others = [r({ start: T(12), end: T(13) })];
      expect(change({ reservation, start: T(12, 30), others }).code).toBe('RULE_TIME_ORDER');
    });

    test('RSV-27 長さ超えかつ重なりなら RULE_LENGTH', () => {
      const reservation = r({ start: T(11), end: T(12) });
      const others = [r({ start: T(12), end: T(13) })];
      expect(change({ reservation, end: T(11) + 1441 * MIN, others }).code).toBe('RULE_LENGTH');
    });
  });
});

describe('RSV-6 前倒しの長さ（checkBeginLength）', () => {
  test('RSV-6 nowMin から終了まで 1440分ちょうどは受け付ける', () => {
    expect(checkBeginLength(NOW, NOW + 1440 * MIN, 1440)).toEqual({ ok: true });
  });

  test('RSV-6 1441分は RULE_BEGIN_LENGTH（RULE_LENGTH ではない）', () => {
    expect(checkBeginLength(NOW, NOW + 1441 * MIN, 1440)).toEqual({ ok: false, code: 'RULE_BEGIN_LENGTH' });
  });
});

describe('RSV-15 前倒しの重なり（checkBeginOverlap。TIM-2）', () => {
  test('RSV-15 [nowMin, 開始) に重なる予約がなければ受け付ける。excludeId の予約は除く', () => {
    const self = r({ id: 1, start: T(10, 30), end: T(11) });
    const before = r({ start: T(9), end: T(10) });
    expect(checkBeginOverlap([self, before], NOW, T(10, 30), 1)).toEqual({ ok: true });
  });

  test('RSV-15 [10:29, 10:30) に対して開始 10:30 は RULE_BEGIN_OVERLAP（1分でも重なる）', () => {
    const other = r({ start: T(10, 29), end: T(10, 30) });
    expect(checkBeginOverlap([other], NOW, T(10, 30), 1)).toEqual({ ok: false, code: 'RULE_BEGIN_OVERLAP' });
  });
});

describe('RSV-14 利用開始（checkBegin）', () => {
  const USER = { id: 1 };
  const begin = ({ user = USER, reservation, others = [], settings = SETTINGS } = {}) =>
    checkBegin({
      user,
      reservation,
      nowMin: NOW,
      settings,
      deviceActive: reservation === null ? others : [reservation, ...others],
    });
  const limit60 = [...SETTINGS, { id: 4, key: 'max_length_minutes', value: 60, effective_at: NOW }];

  test('RSV-14 本人の予約済 [10:00, 11:00)（開始ちょうど）は受け付け、start は 10:00', () => {
    expect(begin({ reservation: r({ start: T(10), end: T(11) }) })).toEqual({ ok: true, start: T(10) });
  });

  test('RSV-13 [9:50, 11:00)（猶予のうち）は受け付け、start は 9:50 のまま', () => {
    expect(begin({ reservation: r({ start: T(9, 50), end: T(11) }) })).toEqual({ ok: true, start: T(9, 50) });
  });

  test('RSV-16 猶予より短い [9:55, 10:05) を 10:00 に利用開始できる', () => {
    expect(begin({ reservation: r({ start: T(9, 55), end: T(10, 5) }) })).toEqual({ ok: true, start: T(9, 55) });
  });

  test('RSV-14 user が null なら NOT_FOUND_USER', () => {
    expect(begin({ user: null, reservation: r() }).code).toBe('NOT_FOUND_USER');
  });

  test.each([
    ['予約が null', null],
    ['他の利用者の予約', { ...r(), user_id: 2 }],
  ])('RSV-14 %sなら NOT_FOUND_RESERVATION', (_label, reservation) => {
    expect(begin({ reservation }).code).toBe('NOT_FOUND_RESERVATION');
  });

  test.each([
    ['in_use', 0],
    ['in_use', 1],
    ...PAST_STATES.map((status) => [status, 0]),
  ])('RSV-14 %s（walk_in = %i）の予約は STATE_NOT_RESERVED', (status, walkIn) => {
    expect(begin({ reservation: r({ start: T(9, 50), status, walkIn }) })).toEqual({
      ok: false,
      code: 'STATE_NOT_RESERVED',
    });
  });

  describe('RSV-15 前倒し', () => {
    test('RSV-15 予約済 [10:30, 11:00) は受け付け、start は nowMin', () => {
      expect(begin({ reservation: r({ start: T(10, 30), end: T(11) }) })).toEqual({ ok: true, start: NOW });
    });

    test('RSV-22 既存 [9:00, 10:00)（ちょうど nowMin に終わる）があっても受け付ける', () => {
      const others = [r({ start: T(9), end: T(10), status: 'in_use' })];
      expect(begin({ reservation: r({ start: T(10, 30), end: T(11) }), others }).ok).toBe(true);
    });

    test.each(PAST_STATES)('RSV-15 既存 [10:00, 10:30) が %s なら受け付ける', (status) => {
      const others = [r({ start: T(10), end: T(10, 30), status })];
      expect(begin({ reservation: r({ start: T(10, 30), end: T(11) }), others }).ok).toBe(true);
    });

    test('RSV-15 既存 [10:00, 10:30) が別の機器なら受け付ける', () => {
      const reservation = r({ start: T(10, 30), end: T(11) });
      const result = checkBegin({
        user: USER,
        reservation,
        nowMin: NOW,
        settings: SETTINGS,
        deviceActive: [reservation],
      });
      expect(result.ok).toBe(true);
    });

    test.each([
      ['[10:00, 10:30) の予約済', T(10), T(10, 30), 'reserved'],
      ['[10:10, 10:20) の予約済', T(10, 10), T(10, 20), 'reserved'],
      ['[9:00, 10:15) の利用中', T(9), T(10, 15), 'in_use'],
    ])('RSV-15 既存 %s があると RULE_BEGIN_OVERLAP（同じ人の予約でも断る）', (_label, start, end, status) => {
      const others = [r({ start, end, status })];
      expect(begin({ reservation: r({ start: T(10, 30), end: T(11) }), others })).toEqual({
        ok: false,
        code: 'RULE_BEGIN_OVERLAP',
      });
    });

    test('RSV-6 [10:30, 翌 10:00) の前倒し（1440分ちょうど）は受け付ける', () => {
      expect(begin({ reservation: r({ start: T(10, 30), end: NOW + 1440 * MIN }) }).ok).toBe(true);
    });

    test('RSV-6 [10:30, 翌 10:01) の前倒し（1441分）は RULE_BEGIN_LENGTH', () => {
      expect(begin({ reservation: r({ start: T(10, 30), end: NOW + 1441 * MIN }) }).code).toBe('RULE_BEGIN_LENGTH');
    });

    test('RSV-6 上限を 60 に変えた履歴で [10:30, 11:01) の前倒しは RULE_BEGIN_LENGTH', () => {
      const reservation = r({ start: T(10, 30), end: T(11, 1) });
      expect(begin({ reservation, settings: limit60 }).code).toBe('RULE_BEGIN_LENGTH');
    });
  });

  test('RSV-25 上限を 60 に変えた履歴で、確保済みの [10:00, 12:00) を開始ちょうどに利用開始できる', () => {
    expect(begin({ reservation: r({ start: T(10), end: T(12) }), settings: limit60 })).toEqual({
      ok: true,
      start: T(10),
    });
  });

  describe('RSV-27 確かめる順', () => {
    test('RSV-27 user が null で予約も null なら NOT_FOUND_USER', () => {
      expect(begin({ user: null, reservation: null }).code).toBe('NOT_FOUND_USER');
    });

    test('RSV-27 他の利用者の利用中の予約は NOT_FOUND_RESERVATION', () => {
      expect(begin({ reservation: { ...r({ status: 'in_use' }), user_id: 2 } }).code).toBe('NOT_FOUND_RESERVATION');
    });

    test('RSV-27 本人の利用中で、前倒しなら重なる既存があっても STATE_NOT_RESERVED', () => {
      const reservation = r({ start: T(10, 30), end: T(11), status: 'in_use' });
      const others = [r({ start: T(10), end: T(10, 30) })];
      expect(begin({ reservation, others }).code).toBe('STATE_NOT_RESERVED');
    });

    test('RSV-27 長さ超えかつ重なりなら RULE_BEGIN_LENGTH', () => {
      const reservation = r({ start: T(10, 30), end: NOW + 1441 * MIN });
      const others = [r({ start: T(10), end: T(10, 30) })];
      expect(begin({ reservation, others }).code).toBe('RULE_BEGIN_LENGTH');
    });
  });
});

describe('RSV-18 利用終了（checkFinish）', () => {
  const USER = { id: 1 };
  const finish = ({ user = USER, reservation }) => checkFinish({ user, reservation, nowMin: NOW });

  test('RSV-18 本人の利用中 [9:00, 11:00) は受け付け、end は 10:00', () => {
    expect(finish({ reservation: r({ start: T(9), end: T(11), status: 'in_use' }) })).toEqual({ ok: true, end: NOW });
  });

  test('RSV-17 予約なしの利用で始めたもの（walk_in = 1）も受け付ける', () => {
    const reservation = r({ start: T(9), end: T(11), status: 'in_use', walkIn: 1 });
    expect(finish({ reservation })).toEqual({ ok: true, end: NOW });
  });

  test('TIM-7 同じ分に始めた利用中 [10:00, 11:00) は end が 10:00（長さ0）', () => {
    expect(finish({ reservation: r({ start: T(10), end: T(11), status: 'in_use' }) })).toEqual({ ok: true, end: T(10) });
  });

  test('RSV-18 user が null なら NOT_FOUND_USER', () => {
    expect(finish({ user: null, reservation: r({ status: 'in_use' }) }).code).toBe('NOT_FOUND_USER');
  });

  test.each([
    ['予約が null', null],
    ['他の利用者の予約', { ...r({ status: 'in_use' }), user_id: 2 }],
  ])('RSV-18 %sなら NOT_FOUND_RESERVATION', (_label, reservation) => {
    expect(finish({ reservation }).code).toBe('NOT_FOUND_RESERVATION');
  });

  test.each(['reserved', ...PAST_STATES])('RSV-18 %s の予約は STATE_NOT_IN_USE', (status) => {
    expect(finish({ reservation: r({ start: T(9, 50), status }) })).toEqual({ ok: false, code: 'STATE_NOT_IN_USE' });
  });

  describe('RSV-27 確かめる順', () => {
    test('RSV-27 user が null で予約も null なら NOT_FOUND_USER', () => {
      expect(finish({ user: null, reservation: null }).code).toBe('NOT_FOUND_USER');
    });

    test('RSV-27 他の利用者の終了済みの予約は NOT_FOUND_RESERVATION（STATE_ にならない）', () => {
      expect(finish({ reservation: { ...r({ status: 'finished' }), user_id: 2 } }).code).toBe('NOT_FOUND_RESERVATION');
    });
  });
});

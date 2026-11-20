// 利用開始・利用終了（api.md 8.34〜8.36。RSV-13〜RSV-19, RSV-6, RSV-23, TIM-4, TIM-7, LOG-3）。
// 時計は 10:00:30（nowMin = 10:00）、猶予は初期値（15分）
import { describe, expect, test } from 'vitest';
import { T10, insertReservation, rows, withLedger } from './helpers.js';
import {
  DAY,
  STUDENT,
  TEACHER,
  at,
  body,
  codeOf,
  dayReq,
  events,
  req,
  reservations,
  reserveReq,
  seed,
  send,
  setup,
} from './reservation-helpers.js';

const NOW_AT = T10 + 30_000;
const PAST_STATES = ['cancelled', 'no_show', 'finished', 'admin_cancelled', 'admin_finished'];

const beginReq = (user, id, payload = STUDENT, options = {}) =>
  req('POST', `/api/reservations/${id}/begin`, { body: payload, user, ...options });
const finishReq = (user, id, payload = STUDENT, options = {}) =>
  req('POST', `/api/reservations/${id}/finish`, { body: payload, user, ...options });
const sendAt = (ledger, request, time = NOW_AT) => send(ledger, request, { at: time });
const walkInReq = (user, end, who = STUDENT, deviceId = 1) =>
  req('POST', '/api/walk-ins', { body: { ...who, device_id: deviceId, end: `${DAY}T${end}` }, user });
const allEvents = (state) => rows(state, 'SELECT * FROM events ORDER BY id');
const snapshot = (state) => ({ reservations: reservations(state), events: allEvents(state) });
const setSetting = (state, key, value, effectiveAt) =>
  state.storage.sql.exec('INSERT INTO settings (key, value, effective_at) VALUES (?, ?, ?)', key, value, effectiveAt);
const NEXT_DAY = (hour, minute = 0) => at(24 + hour, minute);

describe('RSV-14 利用開始', () => {
  test('RSV-14 本人の予約済 [10:00, 11:00) を利用開始すると in_use になり、start_at は変わらず、記録が1行できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });

      const result = await sendAt(ledger, beginReq(user, 1));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: '2026-11-20T10:00',
        end: '2026-11-20T11:00',
        status: 'in_use',
      });
      expect(reservations(state)[0]).toMatchObject({
        status: 'in_use',
        start_at: at(10),
        end_at: at(11),
        cause: null,
        walk_in: 0,
      });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        at: NOW_AT,
        actor_kind: 'user',
        actor_admin_id: null,
        admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
      });
      expect(JSON.parse(status[0].detail)).toEqual({ from: 'reserved', to: 'in_use' });
    });
  });

  test('RSV-13 開始 9:50 の予約済（猶予のうち）は利用開始でき、start_at は 9:50 のまま', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 50), endAt: at(11), status: 'reserved' });
      const result = await sendAt(ledger, beginReq(user, 1));
      expect(result.status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ status: 'in_use', start_at: at(9, 50) });
    });
  });

  test('RSV-13 開始 9:45 の予約済（猶予の終わりがちょうど nowMin）は無断不使用になり、STATE_NOT_RESERVED（409）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      const result = await sendAt(ledger, beginReq(user, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_RESERVED');
      expect(reservations(state)[0].status).toBe('no_show');
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: T10 });
    });
  });

  test('RSV-16 [9:55, 10:05)（猶予より短い）は 10:00 に利用開始できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 55), endAt: at(10, 5), status: 'reserved' });
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
      expect(reservations(state)[0].status).toBe('in_use');
    });
  });

  test('RSV-16 [9:55, 10:05) を利用開始しないまま 10:05 にすると無断不使用になり、STATE_NOT_RESERVED', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 55), endAt: at(10, 5), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, beginReq(user, 1), at(10, 5)))).toBe('STATE_NOT_RESERVED');
      expect(reservations(state)[0].status).toBe('no_show');
      expect(events(state, 'reservation_status')[0]).toMatchObject({ actor_kind: 'auto', at: at(10, 5) });
    });
  });

  test.each(PAST_STATES)('RSV-14 %s の予約の利用開始は STATE_NOT_RESERVED で、表と events が変わらない', async (status) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status });
      const before = snapshot(state);
      const result = await sendAt(ledger, beginReq(user, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_RESERVED');
      expect(snapshot(state)).toEqual(before);
    });
  });

  test('RSV-14 利用中（2回目の利用開始）は STATE_NOT_RESERVED', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, beginReq(user, 1)))).toBe('STATE_NOT_RESERVED');
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });

  test.each([
    ['他の利用者の予約', true],
    ['ない番号', false],
  ])('RSV-14 %sは NOT_FOUND_RESERVATION（404）で、表が変わらない', async (_, exists) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      if (exists) insertReservation(state, { userId: 2, startAt: at(10), endAt: at(11), status: 'reserved' });
      const before = snapshot(state);
      const result = await sendAt(ledger, beginReq(user, exists ? 1 : 99));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_RESERVATION');
      expect(snapshot(state)).toEqual(before);
    });
  });
});

describe('RSV-15 前倒しの利用開始', () => {
  test('RSV-15 予約済 [10:30, 11:00) を利用開始すると start_at が 10:00 になり、記録は reservation_status の1行だけ', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      const result = await sendAt(ledger, beginReq(user, 1));
      expect(result.status).toBe(200);
      expect(result.body.data).toMatchObject({ start: '2026-11-20T10:00', end: '2026-11-20T11:00', status: 'in_use' });
      expect(reservations(state)[0]).toMatchObject({ status: 'in_use', start_at: at(10), end_at: at(11) });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ at: NOW_AT, actor_kind: 'user' });
      expect(JSON.parse(status[0].detail)).toEqual({
        from: 'reserved',
        to: 'in_use',
        start_at: { before: at(10, 30), after: at(10) },
      });
      expect(events(state, 'reservation_time_changed')).toHaveLength(0);
    });
  });

  test.each([
    ['他の人', 2],
    ['同じ人', 1],
  ])('RSV-15 同じ機器に %sの [10:00, 10:30) の予約済があると RULE_BEGIN_OVERLAP（409）で、表と events が変わらない', async (_, userId) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      insertReservation(state, { userId, startAt: at(10), endAt: at(10, 30), status: 'reserved' });
      const before = snapshot(state);
      const result = await sendAt(ledger, beginReq(user, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_BEGIN_OVERLAP');
      expect(snapshot(state)).toEqual(before);
    });
  });

  test.each([
    ['別の機器', { deviceId: 2, status: 'reserved' }],
    ['取消済み', { deviceId: 1, status: 'cancelled' }],
  ])('RSV-15 既存 [10:00, 10:30) が%sなら成功する', async (_, existing) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      insertReservation(state, { userId: 2, startAt: at(10), endAt: at(10, 30), ...existing });
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
    });
  });

  test('RSV-22 終了時刻がちょうど 10:00 の利用中 [9:00, 10:00) があっても前倒しは成功する（先に自動で終了）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      insertReservation(state, { userId: 2, startAt: at(9), endAt: at(10), status: 'in_use' });
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
      expect(reservations(state)[1]).toMatchObject({ status: 'finished', end_at: at(10) });
      const auto = events(state, 'reservation_status').filter((e) => e.actor_kind === 'auto');
      expect(auto).toHaveLength(1);
      expect(auto[0]).toMatchObject({ reservation_id: 2, at: T10 });
    });
  });

  test('RSV-6 [10:30, 翌 10:00) の前倒しは成功し、[10:30, 翌 10:01) は RULE_BEGIN_LENGTH', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: NEXT_DAY(10), status: 'reserved' });
      insertReservation(state, { deviceId: 2, startAt: at(10, 30), endAt: NEXT_DAY(10, 1), status: 'reserved' });
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
      const result = await sendAt(ledger, beginReq(user, 2));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_BEGIN_LENGTH');
      expect(reservations(state)[1]).toMatchObject({ status: 'reserved', start_at: at(10, 30) });
    });
  });

  test('RSV-6 上限を 60 にすると、確保済みの [10:00, 12:00) は開始ちょうどに利用開始でき、[10:30, 11:31) の前倒しは RULE_BEGIN_LENGTH', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(12), status: 'reserved' });
      insertReservation(state, { deviceId: 2, startAt: at(10, 30), endAt: at(11, 31), status: 'reserved' });
      setSetting(state, 'max_length_minutes', 60, T10);
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, beginReq(user, 2)))).toBe('RULE_BEGIN_LENGTH');
    });
  });

  test('RSV-5 予約で始めた利用中は確保の件数に数え続ける（walk_in が 0 のまま）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      insertReservation(state, { startAt: at(12), endAt: at(13), status: 'reserved' });
      insertReservation(state, { startAt: at(14), endAt: at(15), status: 'reserved' });
      expect((await sendAt(ledger, beginReq(user, 1))).status).toBe(200);
      expect(reservations(state)[0].walk_in).toBe(0);
      expect(codeOf(await sendAt(ledger, reserveReq(user, body('16:00', '17:00'))))).toBe('RULE_COUNT');
    });
  });
});

describe('RSV-18 利用終了', () => {
  test('RSV-18 本人の利用中 [9:00, 11:00) を利用終了すると finished・end_at が 10:00 になり、記録が1行できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      const result = await sendAt(ledger, finishReq(user, 1));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: '2026-11-20T09:00',
        end: '2026-11-20T10:00',
        status: 'finished',
      });
      expect(reservations(state)[0]).toMatchObject({ status: 'finished', cause: null, start_at: at(9), end_at: at(10) });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        at: NOW_AT,
        actor_kind: 'user',
        actor_admin_id: null,
        admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
      });
      expect(JSON.parse(status[0].detail)).toEqual({
        from: 'in_use',
        to: 'finished',
        end_at: { before: at(11), after: at(10) },
      });
    });
  });

  test('RSV-19 利用終了した直後に、同じ機器の [10:00, 11:00) を別の人が確保・予約なしの利用で使える', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      insertReservation(state, { deviceId: 2, startAt: at(9), endAt: at(11), status: 'in_use' });
      expect((await sendAt(ledger, finishReq(user, 1))).status).toBe(200);
      expect((await sendAt(ledger, finishReq(user, 2))).status).toBe(200);
      expect((await sendAt(ledger, reserveReq(user, body('10:00', '11:00', { who: TEACHER })))).status).toBe(200);
      expect((await sendAt(ledger, walkInReq(user, '11:00', TEACHER, 2))).status).toBe(200);
    });
  });

  test('RSV-19 終了時刻がちょうど 10:00 の利用中は自動で終了になり、利用終了は STATE_NOT_IN_USE（409）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(10), status: 'in_use' });
      const result = await sendAt(ledger, finishReq(user, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_IN_USE');
      expect(reservations(state)[0]).toMatchObject({ status: 'finished', end_at: at(10) });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: T10 });
      expect(JSON.parse(status[0].detail)).toEqual({ from: 'in_use', to: 'finished' });
    });
  });

  test('TIM-7 10:00:10 に予約なしの利用を始め、10:00:50 に利用終了すると start_at = end_at = 10:00 で、予約状況に出る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await sendAt(ledger, walkInReq(user, '11:00'), T10 + 10_000)).status).toBe(200);
      const result = await sendAt(ledger, finishReq(user, 1), T10 + 50_000);
      expect(result.status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ status: 'finished', start_at: at(10), end_at: at(10), walk_in: 1 });
      const day = await sendAt(ledger, dayReq(user), T10 + 50_000);
      expect(day.body.data.slots).toEqual([
        expect.objectContaining({ start: '2026-11-20T10:00', end: '2026-11-20T10:00', status: 'finished' }),
      ]);
    });
  });

  test('RSV-17 予約なしの利用で始めた利用中も利用終了できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use', walkIn: 1 });
      expect((await sendAt(ledger, finishReq(user, 1))).status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ status: 'finished', end_at: at(10) });
    });
  });

  test.each(['reserved', ...PAST_STATES])('RSV-18 %s の予約の利用終了は STATE_NOT_IN_USE で、表と events が変わらない', async (status) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status });
      const before = snapshot(state);
      const result = await sendAt(ledger, finishReq(user, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_IN_USE');
      expect(snapshot(state)).toEqual(before);
    });
  });

  test('RSV-18 2回目の利用終了は STATE_NOT_IN_USE', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      expect((await sendAt(ledger, finishReq(user, 1))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, finishReq(user, 1)))).toBe('STATE_NOT_IN_USE');
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });

  test.each([
    ['他の利用者の予約', true],
    ['ない番号', false],
  ])('RSV-18 %sは NOT_FOUND_RESERVATION（404）', async (_, exists) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      if (exists) insertReservation(state, { userId: 2, startAt: at(9), endAt: at(11), status: 'in_use' });
      const before = snapshot(state);
      const result = await sendAt(ledger, finishReq(user, exists ? 1 : 99));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_RESERVATION');
      expect(snapshot(state)).toEqual(before);
    });
  });
});

describe('RSV-23 ほぼ同時の操作', () => {
  test('RSV-23 同じ予約への利用開始を2つ同時に送ると、1つが成功し、もう1つが STATE_NOT_RESERVED（記録は1行）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      const results = await Promise.all([sendAt(ledger, beginReq(user, 1)), sendAt(ledger, beginReq(user, 1))]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'STATE_NOT_RESERVED'].sort());
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });

  test('RSV-23 前倒しの利用開始と、同じ機器の [10:00, 10:30) の確保を同時に送ると、どちらか1つだけが成功する', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      const [begun, reserved] = await Promise.all([
        sendAt(ledger, beginReq(user, 1)),
        sendAt(ledger, reserveReq(user, body('10:00', '10:30', { who: TEACHER }))),
      ]);
      const codes = [codeOf(begun) ?? null, codeOf(reserved) ?? null];
      expect(codes.filter((code) => code === null)).toHaveLength(1);
      if (begun.status === 200) {
        expect(codeOf(reserved)).toBe('RULE_OVERLAP');
        expect(reservations(state)).toHaveLength(1);
      } else {
        expect(codeOf(begun)).toBe('RULE_BEGIN_OVERLAP');
        expect(reservations(state)[0]).toMatchObject({ status: 'reserved', start_at: at(10, 30) });
      }
    });
  });

  test('RSV-23 利用終了を2つ同時に送ると、1つが STATE_NOT_IN_USE', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      const results = await Promise.all([sendAt(ledger, finishReq(user, 1)), sendAt(ledger, finishReq(user, 1))]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'STATE_NOT_IN_USE'].sort());
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

describe('RSV-21 断ったときの自動の変化', () => {
  test.each([
    ['利用開始', beginReq],
    ['利用終了', finishReq],
  ])('RSV-21 %sを段 2 以降で断っても反映した自動の変化が残り、段 1 で断ったときは変わらない', async (_, make) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'reserved' }); // 猶予の終わり 9:15
      expect(codeOf(await sendAt(ledger, make(user, 1, { role: 'x', student_id: '1' })))).toBe('INPUT_ROLE');
      expect(reservations(state)[0].status).toBe('reserved');
      expect(codeOf(await sendAt(ledger, make(user, 99)))).toBe('NOT_FOUND_RESERVATION');
      expect(reservations(state)[0].status).toBe('no_show');
      expect(events(state, 'reservation_status')[0]).toMatchObject({ actor_kind: 'auto', at: at(9, 15) });
    });
  });
});

describe('USR-4・USR-2・API 利用者・認証・経路', () => {
  test.each([
    ['利用開始', beginReq, 'reserved'],
    ['利用終了', finishReq, 'in_use'],
  ])('USR-4 %sで識別の組の利用者がいなければ NOT_FOUND_USER', async (_, make, status) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 50), endAt: at(11), status });
      const result = await sendAt(ledger, make(user, 1, { role: 'student', student_id: '99999999' }));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_USER');
      expect(reservations(state)[0].status).toBe(status);
    });
  });

  test.each([
    ['利用開始', beginReq],
    ['利用終了', finishReq],
  ])('USR-2 %sは Cookie がないと AUTH_REQUIRED、Origin がないと AUTH_ORIGIN、管理者の Cookie だけでも AUTH_REQUIRED', async (_, make) => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      expect(codeOf(await sendAt(ledger, make(undefined, 1)))).toBe('AUTH_REQUIRED');
      expect(codeOf(await sendAt(ledger, make(user, 1, STUDENT, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(codeOf(await sendAt(ledger, make(undefined, 1, STUDENT, { admin })))).toBe('AUTH_REQUIRED');
    });
  });

  test.each([
    ['利用開始', beginReq],
    ['利用終了', finishReq],
  ])('API %sの本文の識別の組が文字列でなければ INPUT_BODY', async (_, make) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await sendAt(ledger, make(user, 1, { role: 'student', student_id: 12345678 })))).toBe('INPUT_BODY');
    });
  });

  test.each(['0', '01', 'abc'])('API {id} が %s なら、利用開始も利用終了も NOT_FOUND_API', async (id) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await sendAt(ledger, beginReq(user, id)))).toBe('NOT_FOUND_API');
      expect(codeOf(await sendAt(ledger, finishReq(user, id)))).toBe('NOT_FOUND_API');
    });
  });

  test('API 本文に start・end を入れても無視される（前倒しの開始は nowMin、終了は nowMin）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      const extra = { ...STUDENT, start: `${DAY}T10:20`, end: `${DAY}T10:40` };
      expect((await sendAt(ledger, beginReq(user, 1, extra))).status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ start_at: at(10), end_at: at(11) });
      expect((await sendAt(ledger, finishReq(user, 1, extra))).status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ start_at: at(10), end_at: at(10) });
    });
  });
});

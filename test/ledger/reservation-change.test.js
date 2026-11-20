// 時間帯の変更（api.md 8.32・8.33。RSV-9〜RSV-12, RSV-3, RSV-6, RSV-23, TIM-6, LOG-3）。時計は 10:00:30（nowMin = 10:00）
import { describe, expect, test } from 'vitest';
import { T10, insertReservation, rows, withLedger } from './helpers.js';
import {
  DAY,
  STUDENT,
  TEACHER,
  at,
  body,
  codeOf,
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

// 本文。時刻は 2026-11-20 の日本時間の HH:mm
const change = (start, end, who = STUDENT) => ({ ...who, start: `${DAY}T${start}`, end: `${DAY}T${end}` });
const changeReq = (user, id, payload, options = {}) =>
  req('POST', `/api/reservations/${id}/change`, { body: payload, user, ...options });
const sendAt = (ledger, request, time = NOW_AT) => send(ledger, request, { at: time });
const myReq = (user) => req('POST', '/api/my/reservations', { body: STUDENT, user });
const cancelReq = (user, id) => req('POST', `/api/reservations/${id}/cancel`, { body: STUDENT, user });
const allEvents = (state) => rows(state, 'SELECT * FROM events ORDER BY id');
const snapshot = (state) => ({ reservations: reservations(state), events: allEvents(state) });
const setSetting = (state, key, value, effectiveAt) =>
  state.storage.sql.exec('INSERT INTO settings (key, value, effective_at) VALUES (?, ?, ?)', key, value, effectiveAt);

describe('RSV-9 予約済の時間帯の変更', () => {
  test('RSV-9 本人の予約済 [11:00, 12:00) を [13:00, 14:30) にすると時刻だけが変わり、記録が1行できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });

      const result = await sendAt(ledger, changeReq(user, 1, change('13:00', '14:30')));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: '2026-11-20T13:00',
        end: '2026-11-20T14:30',
        status: 'reserved',
      });
      expect(reservations(state)[0]).toMatchObject({
        start_at: at(13),
        end_at: at(14, 30),
        status: 'reserved',
        cause: null,
        walk_in: 0,
        device_id: 1,
      });
      const changed = events(state, 'reservation_time_changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        at: NOW_AT,
        actor_kind: 'user',
        actor_admin_id: null,
        admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
      });
      expect(JSON.parse(changed[0].detail)).toEqual({
        before: { start_at: at(11), end_at: at(12) },
        after: { start_at: at(13), end_at: at(14, 30) },
      });
      expect(events(state, 'reservation_status')).toHaveLength(0);
    });
  });

  test('RSV-9 終了だけを変えても detail の before・after に両方の時刻が入る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect((await sendAt(ledger, changeReq(user, 1, change('11:00', '12:30')))).status).toBe(200);
      expect(JSON.parse(events(state, 'reservation_time_changed')[0].detail)).toEqual({
        before: { start_at: at(11), end_at: at(12) },
        after: { start_at: at(11), end_at: at(12, 30) },
      });
    });
  });

  test('RSV-9 両方とも今と同じ値を送ると成功し、表と events が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const before = snapshot(state);
      const result = await sendAt(ledger, changeReq(user, 1, change('11:00', '12:00')));
      expect(result.status).toBe(200);
      expect(result.body.data).toMatchObject({ start: '2026-11-20T11:00', end: '2026-11-20T12:00', status: 'reserved' });
      expect(snapshot(state)).toEqual(before);
    });
  });

  test('RSV-9 本文に別の device_id を入れても機器は変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const result = await sendAt(ledger, changeReq(user, 1, { ...change('13:00', '14:00'), device_id: 2 }));
      expect(result.body.data.device_id).toBe(1);
      expect(reservations(state)[0].device_id).toBe(1);
    });
  });

  test.each(PAST_STATES)('RSV-9 %s の予約の変更は STATE_NOT_ACTIVE（409）', async (status) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status });
      const before = snapshot(state);
      const result = await sendAt(ledger, changeReq(user, 1, change('13:00', '14:00')));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_ACTIVE');
      expect(snapshot(state)).toEqual(before);
    });
  });

  test.each([
    ['他の利用者の予約済', 'reserved'],
    ['他の利用者の取消済みの予約', 'cancelled'],
    ['ない番号', null],
  ])('RSV-9 %sは NOT_FOUND_RESERVATION（404）で、表が変わらない', async (_, status) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      if (status !== null) insertReservation(state, { userId: 2, startAt: at(11), endAt: at(12), status });
      const before = snapshot(state);
      const result = await sendAt(ledger, changeReq(user, status === null ? 99 : 1, change('13:00', '14:00')));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_RESERVATION');
      expect(snapshot(state)).toEqual(before);
    });
  });
});

describe('RSV-10 利用中の終了時刻の変更', () => {
  test.each([
    ['利用中', 0],
    ['予約なしの利用で始めた利用中', 1],
  ])('RSV-10 %sの終了を延長・短縮できる', async (_, walkIn) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use', walkIn });
      const longer = await sendAt(ledger, changeReq(user, 1, change('09:00', '12:00')));
      expect(longer.body.data).toMatchObject({ end: '2026-11-20T12:00', status: 'in_use' });
      expect((await sendAt(ledger, changeReq(user, 1, change('09:00', '10:01')))).status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ start_at: at(9), end_at: at(10, 1), status: 'in_use', walk_in: walkIn });
    });
  });

  test('RSV-10 利用中の開始を変えようとすると RULE_START_PASSED（409）で、表が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      const before = snapshot(state);
      const result = await sendAt(ledger, changeReq(user, 1, change('09:30', '11:00')));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_START_PASSED');
      expect(snapshot(state)).toEqual(before);
    });
  });
});

describe('RSV-11 開始時刻を過ぎた予約済', () => {
  test('RSV-11 猶予の中の予約済は終了だけ変えられ、開始を変えようとすると RULE_START_PASSED', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 55), endAt: at(11), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('10:05', '11:00'))))).toBe('RULE_START_PASSED');
      expect((await sendAt(ledger, changeReq(user, 1, change('09:55', '11:30')))).status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ start_at: at(9, 55), end_at: at(11, 30), status: 'reserved' });
    });
  });

  test('RSV-11 開始がちょうど 10:00 の予約済の開始の変更も RULE_START_PASSED', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('10:30', '11:00'))))).toBe('RULE_START_PASSED');
    });
  });
});

describe('TIM-6・TIM-7 時刻', () => {
  test('TIM-6 開始をちょうど nowMin にする変更は成功', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect((await sendAt(ledger, changeReq(user, 1, change('10:00', '12:00')))).status).toBe(200);
    });
  });

  test.each([
    ['開始を1分前', '09:59', '12:00'],
    ['終了をちょうど nowMin', '11:00', '10:00'],
  ])('TIM-6 %sにすると RULE_PAST', async (_, start, end) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change(start, end))))).toBe('RULE_PAST');
    });
  });

  test('TIM-7 開始だけを今の終了と同じ時刻にずらすと RULE_TIME_ORDER', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('12:00', '12:00'))))).toBe('RULE_TIME_ORDER');
    });
  });
});

describe('RSV-12 長さと件数', () => {
  test('RSV-12 上限 60 で、120分の予約済をずらす・短くするのは成功し、121分は RULE_LENGTH', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      setSetting(state, 'max_length_minutes', 60, T10);
      insertReservation(state, { startAt: at(11), endAt: at(13), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('11:00', '13:01'))))).toBe('RULE_LENGTH');
      expect((await sendAt(ledger, changeReq(user, 1, change('12:00', '14:00')))).status).toBe(200);
      expect((await sendAt(ledger, changeReq(user, 1, change('12:00', '13:00')))).status).toBe(200);
    });
  });

  test('RSV-12 上限 60 で、30分の予約を61分にすると RULE_LENGTH、60分は成功', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      setSetting(state, 'max_length_minutes', 60, T10);
      insertReservation(state, { startAt: at(15), endAt: at(15, 30), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('15:00', '16:01'))))).toBe('RULE_LENGTH');
      expect((await sendAt(ledger, changeReq(user, 1, change('15:00', '16:00')))).status).toBe(200);
    });
  });

  test('RSV-12 予約済・利用中が上限（3件）ある利用者の変更も成功する', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { deviceId: 2, startAt: at(13), endAt: at(14), status: 'reserved' });
      insertReservation(state, { startAt: at(9), endAt: at(10, 30), status: 'in_use' });
      expect((await sendAt(ledger, changeReq(user, 1, change('15:00', '16:00')))).status).toBe(200);
    });
  });

  test('RSV-12 予約なしの利用で始めたものの終了を延ばした後も、確保の件数に数えない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'in_use', walkIn: 1 });
      insertReservation(state, { deviceId: 2, startAt: at(13), endAt: at(14), status: 'reserved' });
      insertReservation(state, { deviceId: 2, startAt: at(15), endAt: at(16), status: 'reserved' });
      expect((await sendAt(ledger, changeReq(user, 1, change('10:00', '12:00')))).status).toBe(200);
      expect(reservations(state)[0].walk_in).toBe(1);
      const reserved = await sendAt(ledger, reserveReq(user, body('17:00', '18:00')));
      expect(reserved.status).toBe(200);
    });
  });
});

describe('RSV-3 重なり', () => {
  test('RSV-3 後に [12:00, 13:00) がある機器で [11:00, 12:00) を [11:00, 12:01) にすると RULE_OVERLAP、[10:30, 11:30) は成功', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { userId: 2, startAt: at(12), endAt: at(13), status: 'reserved' });
      const before = snapshot(state);
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('11:00', '12:01'))))).toBe('RULE_OVERLAP');
      expect(snapshot(state)).toEqual(before);
      expect((await sendAt(ledger, changeReq(user, 1, change('10:30', '11:30')))).status).toBe(200);
    });
  });

  test('RSV-3 既存が同じ人の予約でも RULE_OVERLAP。別の機器の予約とは重なってもよい', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { startAt: at(12), endAt: at(13), status: 'reserved' });
      insertReservation(state, { deviceId: 2, startAt: at(14), endAt: at(15), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('11:00', '12:30'))))).toBe('RULE_OVERLAP');
      expect((await sendAt(ledger, changeReq(user, 1, change('14:00', '15:00')))).status).toBe(200);
    });
  });
});

describe('RSV-23 ほぼ同時の操作', () => {
  test('RSV-23 同じ機器の2つの予約を同じ空きへ同時に広げると、1つが成功し、もう1つが RULE_OVERLAP', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { userId: 2, startAt: at(13), endAt: at(14), status: 'reserved' });
      const results = await Promise.all([
        sendAt(ledger, changeReq(user, 1, change('11:00', '12:30'))),
        sendAt(ledger, changeReq(user, 2, change('12:15', '14:00', TEACHER))),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'RULE_OVERLAP'].sort());
      expect(events(state, 'reservation_time_changed')).toHaveLength(1);
    });
  });

  test('RSV-23 同じ予約への変更と取消を同時に送ると、取消は成功し、変更は取消が先なら STATE_NOT_ACTIVE', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const [changed, cancelled] = await Promise.all([
        sendAt(ledger, changeReq(user, 1, change('13:00', '14:00'))),
        sendAt(ledger, cancelReq(user, 1)),
      ]);
      expect(cancelled.status).toBe(200);
      expect(reservations(state)[0].status).toBe('cancelled');
      // 先に処理された方の結果を見て、後の方が判定される
      const kinds = allEvents(state)
        .filter((e) => e.reservation_id === 1)
        .map((e) => e.kind);
      if (changed.status === 200) {
        expect(kinds).toEqual(['reservation_time_changed', 'reservation_status']);
        expect(reservations(state)[0].start_at).toBe(at(13));
      } else {
        expect(codeOf(changed)).toBe('STATE_NOT_ACTIVE');
        expect(kinds).toEqual(['reservation_status']);
      }
    });
  });
});

describe('RSV-22・RSV-26・RSV-16 自動の変化', () => {
  test('RSV-22 終了時刻がちょうど nowMin の利用中の延長は、先に終了になって STATE_NOT_ACTIVE', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(10), status: 'in_use' });
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('09:00', '11:00'))))).toBe('STATE_NOT_ACTIVE');
      expect(reservations(state)[0]).toMatchObject({ status: 'finished', end_at: at(10) });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: T10 });
      expect(events(state, 'reservation_time_changed')).toHaveLength(0);
    });
  });

  test('RSV-22 終了時刻がちょうど nowMin の他の利用中がある機器で、その時刻から始まるようにずらせる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { userId: 2, startAt: at(9), endAt: at(10), status: 'in_use' });
      expect((await sendAt(ledger, changeReq(user, 1, change('10:00', '11:00')))).status).toBe(200);
      expect(reservations(state)[1].status).toBe('finished');
    });
  });

  test('RSV-26 猶予 15分の予約済の開始を 11:00 から 12:00 にすると、12:14 は予約済のまま、12:15 で無断不使用', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(13), status: 'reserved' });
      expect((await sendAt(ledger, changeReq(user, 1, change('12:00', '13:00')))).status).toBe(200);
      await sendAt(ledger, myReq(user), at(12, 14));
      expect(reservations(state)[0].status).toBe('reserved');
      await sendAt(ledger, myReq(user), at(12, 15));
      expect(reservations(state)[0].status).toBe('no_show');
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: at(12, 15) });
    });
  });

  test('RSV-26 開始を変えた後に猶予の数値を変えると、変更後の開始時刻の時点の値が使われる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(13), status: 'reserved' });
      expect((await sendAt(ledger, changeReq(user, 1, change('12:00', '13:00')))).status).toBe(200);
      // 11:30 から猶予 5分。変更前の開始 11:00 の時点では 15分だが、変更後の開始 12:00 の時点の値を使う
      setSetting(state, 'grace_minutes', 5, at(11, 30));
      await sendAt(ledger, myReq(user), at(12, 4));
      expect(reservations(state)[0].status).toBe('reserved');
      await sendAt(ledger, myReq(user), at(12, 5));
      expect(reservations(state)[0].status).toBe('no_show');
      expect(events(state, 'reservation_status')[0]).toMatchObject({ actor_kind: 'auto', at: at(12, 5) });
    });
  });

  test('RSV-16 猶予の中の予約済の終了を、開始＋猶予より前に短くすると、その終了時刻に無断不使用になる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 55), endAt: at(11), status: 'reserved' }); // 猶予の終わり 10:10
      expect((await sendAt(ledger, changeReq(user, 1, change('09:55', '10:05')))).status).toBe(200);
      await sendAt(ledger, myReq(user), at(10, 4));
      expect(reservations(state)[0].status).toBe('reserved');
      await sendAt(ledger, myReq(user), at(10, 5));
      expect(reservations(state)[0].status).toBe('no_show');
      expect(events(state, 'reservation_status')[0]).toMatchObject({ actor_kind: 'auto', at: at(10, 5) });
    });
  });

  test('RSV-21 段 2 以降で断っても反映した自動の変化が残り、段 1 で断ったときは変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'reserved' }); // 猶予の終わり 9:15
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('13:00', '14:00', { role: 'x', student_id: '1' }))))).toBe(
        'INPUT_ROLE',
      );
      expect(reservations(state)[0].status).toBe('reserved');
      expect(codeOf(await sendAt(ledger, changeReq(user, 99, change('13:00', '14:00'))))).toBe('NOT_FOUND_RESERVATION');
      expect(reservations(state)[0].status).toBe('no_show');
      expect(events(state, 'reservation_status')[0]).toMatchObject({ actor_kind: 'auto', at: at(9, 15) });
    });
  });
});

describe('TIM-3・USR-4 入力と利用者', () => {
  test.each([
    ['start に秒がある', { start: `${DAY}T11:00:00` }],
    ['end がありえない日時', { end: '2026-02-30T12:00' }],
  ])('TIM-3 %sなら INPUT_TIME', async (_, override) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const result = await sendAt(ledger, changeReq(user, 1, { ...change('11:00', '12:00'), ...override }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_TIME');
    });
  });

  test.each([
    ['end がない', { end: undefined }],
    ['end が数値', { end: at(12) }],
  ])('TIM-3 %sなら INPUT_BODY', async (_, override) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const result = await sendAt(ledger, changeReq(user, 1, { ...change('11:00', '12:00'), ...override }));
      expect(codeOf(result)).toBe('INPUT_BODY');
    });
  });

  test('USR-4 識別の組の利用者がいなければ NOT_FOUND_USER', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const nobody = { role: 'student', student_id: '99999999' };
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('13:00', '14:00', nobody))))).toBe('NOT_FOUND_USER');
      expect(reservations(state)[0].start_at).toBe(at(11));
    });
  });
});

describe('USR-2・API 認証と経路', () => {
  test('USR-2 Cookie がないと AUTH_REQUIRED、Origin がないと AUTH_ORIGIN', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, changeReq(undefined, 1, change('13:00', '14:00'))))).toBe('AUTH_REQUIRED');
      expect(codeOf(await sendAt(ledger, changeReq(user, 1, change('13:00', '14:00'), { origin: null })))).toBe(
        'AUTH_ORIGIN',
      );
      expect(reservations(state)[0].start_at).toBe(at(11));
    });
  });

  test('ADM-1 管理者の Cookie だけでも AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      expect(codeOf(await sendAt(ledger, changeReq(undefined, 1, change('13:00', '14:00'), { admin })))).toBe(
        'AUTH_REQUIRED',
      );
    });
  });

  test.each(['0', '01', 'abc'])('API {id} が %s なら NOT_FOUND_API', async (id) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await sendAt(ledger, changeReq(user, id, change('13:00', '14:00'))))).toBe('NOT_FOUND_API');
    });
  });
});

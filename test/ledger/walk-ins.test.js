// 予約なしの利用（api.md 8.27・8.28）
import { describe, expect, test } from 'vitest';
import { T10, insertReservation, withLedger } from './helpers.js';
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

const walkInReq = (user, payload, options = {}) => req('POST', '/api/walk-ins', { body: payload, user, ...options });

// 予約なしの利用の本文。終了は 2026-11-20 の日本時間の HH:mm
const walkIn = (end, { deviceId = 1, who = STUDENT } = {}) => ({ ...who, device_id: deviceId, end: `${DAY}T${end}` });

describe('RSV-17 予約なしの利用', () => {
  test('RSV-17 時計が 10:00:30 のとき、開始 10:00 の利用中の行と walk_in_started ができ、reservation_status は書かれない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, walkInReq(user, walkIn('11:00')), { at: T10 + 30_123 });
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: '2026-11-20T10:00',
        end: '2026-11-20T11:00',
        status: 'in_use',
      });
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);

      expect(reservations(state)).toEqual([
        {
          id: 1,
          device_id: 1,
          user_id: 1,
          start_at: at(10),
          end_at: at(11),
          status: 'in_use',
          cause: null,
          walk_in: 1,
          created_at: T10 + 30_123,
        },
      ]);
      const started = events(state, 'walk_in_started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        at: T10 + 30_123,
        actor_kind: 'user',
        actor_admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
        admin_id: null,
      });
      expect(JSON.parse(started[0].detail)).toEqual({ start_at: at(10), end_at: at(11) });
      expect(events(state, 'reservation_status')).toEqual([]);
    });
  });

  test('RSV-17 本文に start を入れても無視され、開始は nowMin', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, walkInReq(user, { ...walkIn('11:00'), start: `${DAY}T10:30` }));
      expect(result.status).toBe(200);
      expect(result.body.data.start).toBe('2026-11-20T10:00');
      expect(reservations(state)[0].start_at).toBe(at(10));
    });
  });

  test('RSV-17 予約済が上限（3件）ある利用者でも成功し、その後の確保も予約なしの利用の行を数えない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      // 上限 − 1 件の予約済。予約なしの利用の後の確保で、予約なしの利用を数えなければ3件目が通る
      expect((await send(ledger, reserveReq(user, body('13:00', '14:00', { deviceId: 2 })))).status).toBe(200);
      expect((await send(ledger, reserveReq(user, body('14:00', '15:00', { deviceId: 2 })))).status).toBe(200);
      expect((await send(ledger, walkInReq(user, walkIn('11:00')))).status).toBe(200);
      expect((await send(ledger, reserveReq(user, body('15:00', '16:00', { deviceId: 2 })))).status).toBe(200);
      // 予約済が上限の3件でも、予約なしの利用は別の機器で成功する（RSV-3「別の機器であれば」）
      expect(codeOf(await send(ledger, reserveReq(user, body('16:00', '17:00', { deviceId: 2 }))))).toBe('RULE_COUNT');
      expect((await send(ledger, walkInReq(user, walkIn('11:00', { deviceId: 2 })))).status).toBe(200);
    });
  });

  test('USR-4 識別の組の利用者がいなければ NOT_FOUND_USER（404）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, walkInReq(user, walkIn('11:00', { who: { role: 'student', student_id: '99999999' } })));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_USER');
      expect(reservations(state)).toEqual([]);
    });
  });

  test('MNG-1 ない機器・削除した機器は NOT_FOUND_DEVICE（404）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec('UPDATE devices SET deleted_at = 1 WHERE id = 2');
      for (const deviceId of [2, 99]) {
        const result = await send(ledger, walkInReq(user, walkIn('11:00', { deviceId })));
        expect(result.status).toBe(404);
        expect(codeOf(result)).toBe('NOT_FOUND_DEVICE');
      }
      expect(reservations(state)).toEqual([]);
    });
  });
});

describe('RSV-20 空いている', () => {
  test.each([
    ['利用中', 'in_use', at(9, 30)],
    ['予約済（猶予の間）', 'reserved', at(9, 50)],
  ])('RSV-20 現在時刻を含む%sがある機器は RULE_DEVICE_BUSY（409）で、行が増えない', async (_, status, startAt) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 2, startAt, endAt: at(11), status });
      const result = await send(ledger, walkInReq(user, walkIn('10:30')));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_DEVICE_BUSY');
      expect(reservations(state)).toHaveLength(1);
      expect(events(state, 'walk_in_started')).toEqual([]);
    });
  });

  test('RSV-20 自分の予約が現在時刻にかかっていても RULE_DEVICE_BUSY', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 1, startAt: at(10), endAt: at(11), status: 'reserved' });
      expect(codeOf(await send(ledger, walkInReq(user, walkIn('10:30'))))).toBe('RULE_DEVICE_BUSY');
    });
  });
});

describe('RSV-3 後の予約との重なり', () => {
  test('RSV-3 10:30 に始まる予約済がある機器で、終了 10:30 は成功、10:31 は RULE_OVERLAP', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 2, startAt: at(10, 30), endAt: at(11), status: 'reserved' });
      const overlap = await send(ledger, walkInReq(user, walkIn('10:31')));
      expect(overlap.status).toBe(409);
      expect(codeOf(overlap)).toBe('RULE_OVERLAP');
      expect((await send(ledger, walkInReq(user, walkIn('10:30')))).status).toBe(200);
    });
  });
});

describe('RSV-6 TIM-6 時刻の条件', () => {
  test('RSV-6 1440分は成功、1441分は RULE_LENGTH', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const tooLong = await send(ledger, walkInReq(user, { ...STUDENT, device_id: 1, end: '2026-11-21T10:01' }));
      expect(tooLong.status).toBe(409);
      expect(codeOf(tooLong)).toBe('RULE_LENGTH');
      expect((await send(ledger, walkInReq(user, { ...STUDENT, device_id: 1, end: '2026-11-21T10:00' }))).status).toBe(200);
    });
  });

  test('TIM-6 終了がちょうど nowMin は RULE_PAST（RULE_TIME_ORDER ではない）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, walkInReq(user, walkIn('10:00')), { at: T10 + 30_000 });
      expect(codeOf(result)).toBe('RULE_PAST');
    });
  });
});

describe('TIM-3 入力の形式', () => {
  test.each(['2026-11-20T11:00:00', '2026-02-30T11:00'])('TIM-3 end が %s なら INPUT_TIME（400）', async (end) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, walkInReq(user, { ...walkIn('11:00'), end }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_TIME');
    });
  });

  test.each([
    ['end がない', { end: undefined }],
    ['end が数値', { end: 1 }],
    ['device_id が "1"', { device_id: '1' }],
    ['device_id が 1.5', { device_id: 1.5 }],
    ['device_id が 0', { device_id: 0 }],
  ])('TIM-3 %s なら INPUT_BODY', async (_, change) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, walkInReq(user, { ...walkIn('11:00'), ...change }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_BODY');
    });
  });

  test('USR-4 確かめる順は INPUT_ROLE → INPUT_STUDENT_ID → INPUT_TIME', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const bad = { ...walkIn('11:00'), end: 'x' };
      expect(codeOf(await send(ledger, walkInReq(user, { ...bad, role: 'x', student_id: 'x' })))).toBe('INPUT_ROLE');
      expect(codeOf(await send(ledger, walkInReq(user, { ...bad, student_id: 'x' })))).toBe('INPUT_STUDENT_ID');
      expect(codeOf(await send(ledger, walkInReq(user, bad)))).toBe('INPUT_TIME');
    });
  });
});

describe('RSV-23 ほぼ同時の予約なしの利用', () => {
  test('RSV-23 同じ機器に2つ同時に送ると、1つが成功し、もう1つが RULE_DEVICE_BUSY', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const results = await Promise.all([
        send(ledger, walkInReq(user, walkIn('11:00'))),
        send(ledger, walkInReq(user, walkIn('10:30', { who: TEACHER }))),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'RULE_DEVICE_BUSY'].sort());
      expect(reservations(state)).toHaveLength(1);
    });
  });
});

describe('RSV-22 自動の変化が先', () => {
  test.each([
    ['終了時刻がちょうど nowMin の利用中', { startAt: at(9), endAt: at(10), status: 'in_use' }, 'finished', at(10)],
    // 猶予15分。9:45 開始の予約済は 10:00 に無断不使用
    ['猶予の終わりがちょうど nowMin の予約済', { startAt: at(9, 45), endAt: at(11), status: 'reserved' }, 'no_show', at(10)],
  ])('RSV-22 %sがある機器で成功し、先の予約は自動で変わる', async (_, existing, after, ruleAt) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 2, ...existing });
      expect((await send(ledger, walkInReq(user, walkIn('11:00')), { at: T10 + 30_000 })).status).toBe(200);
      expect(reservations(state)[0].status).toBe(after);
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: ruleAt, reservation_id: 1 });
    });
  });
});

describe('RSV-21 断っても反映した自動の変化は残る', () => {
  test('RSV-21 段 2 以降で断っても、反映した自動の変化が残る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: T10, status: 'in_use' });
      expect(codeOf(await send(ledger, walkInReq(user, walkIn('10:00'))))).toBe('RULE_PAST');
      expect(reservations(state)[0].status).toBe('finished');
    });
  });

  test('RSV-21 段 1 で断ったときは変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: T10, status: 'in_use' });
      expect(codeOf(await send(ledger, walkInReq(user, { ...walkIn('11:00'), end: 'x' })))).toBe('INPUT_TIME');
      expect(reservations(state)[0].status).toBe('in_use');
      expect(events(state, 'reservation_status')).toEqual([]);
    });
  });
});

describe('VIW-1 予約状況', () => {
  test('VIW-1 予約なしの利用が予約状況に利用中として出る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, walkInReq(user, walkIn('11:00')))).status).toBe(200);
      const day = await send(ledger, dayReq(user));
      expect(day.body.data.slots).toHaveLength(1);
      expect(day.body.data.slots[0]).toMatchObject({
        start: '2026-11-20T10:00',
        end: '2026-11-20T11:00',
        status: 'in_use',
      });
    });
  });
});

describe('USR-2 認証', () => {
  test('USR-2 Cookie がないと AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, walkInReq(undefined, walkIn('11:00'))))).toBe('AUTH_REQUIRED');
    });
  });

  test('USR-2 Origin がないと AUTH_ORIGIN', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, walkInReq(user, walkIn('11:00'), { origin: null })))).toBe('AUTH_ORIGIN');
      expect(reservations(state)).toEqual([]);
    });
  });
});

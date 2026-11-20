// 自分の予約・取消（api.md 8.29〜8.31。RSV-7, RSV-8）
import { describe, expect, test } from 'vitest';
import { T10, insertReservation, rows, withLedger } from './helpers.js';
import {
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
import { SQL_MY_RESERVATIONS } from '../../src/store/reservations.js';

const myReq = (user, payload = STUDENT, options = {}) =>
  req('POST', '/api/my/reservations', { body: payload, user, ...options });
const cancelReq = (user, id, payload = STUDENT, options = {}) =>
  req('POST', `/api/reservations/${id}/cancel`, { body: payload, user, ...options });

const PAST_STATES = ['cancelled', 'no_show', 'finished', 'admin_cancelled', 'admin_finished'];
const allEvents = (state) => rows(state, 'SELECT * FROM events ORDER BY id');

describe('RSV-7 自分の予約の一覧', () => {
  test('RSV-7 予約済2件（別の機器）と予約なしの利用の利用中1件が開始時刻の順で出て、ほかは出ない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { deviceId: 1, startAt: at(13), endAt: at(14), status: 'reserved' });
      insertReservation(state, { deviceId: 2, startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { deviceId: 1, startAt: at(10), endAt: at(11), status: 'in_use', walkIn: 1 });
      for (const status of PAST_STATES) {
        insertReservation(state, { deviceId: 1, startAt: at(15), endAt: at(16), status });
      }
      insertReservation(state, { deviceId: 2, userId: 2, startAt: at(15), endAt: at(16), status: 'reserved' });

      const result = await send(ledger, myReq(user));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);
      expect(result.body.data).toEqual({
        now: '2026-11-20T10:00',
        reservations: [
          { id: 3, device_id: 1, device_name: '3Dプリンタ1', start: '2026-11-20T10:00', end: '2026-11-20T11:00', status: 'in_use' },
          { id: 2, device_id: 2, device_name: 'PC1', start: '2026-11-20T11:00', end: '2026-11-20T12:00', status: 'reserved' },
          { id: 1, device_id: 1, device_name: '3Dプリンタ1', start: '2026-11-20T13:00', end: '2026-11-20T14:00', status: 'reserved' },
        ],
      });
    });
  });

  test('RSV-7 予約がなければ reservations は空の配列。now は秒を切り捨てた時刻', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, myReq(user), { at: T10 + 59_999 });
      expect(result.body.data).toEqual({ now: '2026-11-20T10:00', reservations: [] });
    });
  });

  test('RSV-7 1つの項目は id・device_id・device_name・start・end・status だけで、学籍番号・名前を含まない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const result = await send(ledger, myReq(user));
      expect(Object.keys(result.body.data.reservations[0]).sort()).toEqual(
        ['device_id', 'device_name', 'end', 'id', 'start', 'status'].sort(),
      );
      expect(result.text).not.toContain('12345678');
      expect(result.text).not.toContain('山田');
    });
  });

  test('MNG-1 機器の名前を変えた後の一覧では device_name が新しい名前', async () => {
    await withLedger(async (ledger, state) => {
      const { user, admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const renamed = await send(
        ledger,
        req('POST', '/api/admin/devices/1/rename', { body: { name: '3Dプリンタ改' }, admin }),
      );
      expect(renamed.status).toBe(200);
      expect((await send(ledger, myReq(user))).body.data.reservations[0].device_name).toBe('3Dプリンタ改');
    });
  });

  test('RSV-21 猶予を過ぎた予約済・終了時刻を過ぎた利用中は出ず、無断不使用・終了になっている', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 30), endAt: at(11), status: 'reserved' }); // 猶予の終わり 9:45
      insertReservation(state, { deviceId: 2, startAt: at(9), endAt: at(9, 50), status: 'in_use' });
      const result = await send(ledger, myReq(user), { at: T10 + 30_000 });
      expect(result.body.data.reservations).toEqual([]);
      expect(reservations(state).map((r) => r.status)).toEqual(['no_show', 'finished']);
      const status = events(state, 'reservation_status');
      expect(status.map((e) => [e.actor_kind, e.at, e.reservation_id]).sort((a, b) => a[2] - b[2])).toEqual([
        ['auto', at(9, 45), 1],
        ['auto', at(9, 50), 2],
      ]);
    });
  });

  test('RSV-21 段 1 で断ったときは変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(9, 50), status: 'in_use' });
      expect(codeOf(await send(ledger, myReq(user, { ...STUDENT, role: 'x' })))).toBe('INPUT_ROLE');
      expect(reservations(state)[0].status).toBe('in_use');
      expect(events(state, 'reservation_status')).toEqual([]);
    });
  });

  test('USR-4 教員の識別の組でも引ける', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 2, startAt: at(11), endAt: at(12), status: 'reserved' });
      const result = await send(ledger, myReq(user, TEACHER));
      expect(result.body.data.reservations.map((r) => r.id)).toEqual([1]);
    });
  });

  test('RSV-7 自分の予約の SQL は reservations_user_status を使う', async () => {
    await withLedger(async (_ledger, state) => {
      const plan = rows(state, `EXPLAIN QUERY PLAN ${SQL_MY_RESERVATIONS}`, 1)
        .map((r) => r.detail)
        .join('\n');
      expect(plan).toContain('reservations_user_status');
    });
  });
});

describe('RSV-8 取消', () => {
  test('RSV-8 本人の予約済を取り消すと cancelled になり、reservation_status が1行できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const result = await send(ledger, cancelReq(user, 1), { at: T10 + 30_123 });
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: '2026-11-20T11:00',
        end: '2026-11-20T12:00',
        status: 'cancelled',
      });
      expect(reservations(state)[0]).toMatchObject({
        status: 'cancelled',
        cause: null,
        start_at: at(11),
        end_at: at(12),
      });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        at: T10 + 30_123,
        actor_kind: 'user',
        actor_admin_id: null,
        admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
      });
      expect(JSON.parse(status[0].detail)).toEqual({ from: 'reserved', to: 'cancelled' });
    });
  });

  test('RSV-8 取り消した直後に、同じ人が同じ機器の同じ時間帯を確保できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, reserveReq(user, body('11:00', '12:00')))).status).toBe(200);
      expect(codeOf(await send(ledger, reserveReq(user, body('11:00', '12:00'))))).toBe('RULE_OVERLAP');
      expect((await send(ledger, cancelReq(user, 1))).status).toBe(200);
      expect((await send(ledger, reserveReq(user, body('11:00', '12:00')))).status).toBe(200);
    });
  });

  test('RSV-8 件数の上限に達していた人が、1件取り消すと確保できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      for (const [start, end] of [
        ['11:00', '12:00'],
        ['12:00', '13:00'],
        ['13:00', '14:00'],
      ]) {
        expect((await send(ledger, reserveReq(user, body(start, end)))).status).toBe(200);
      }
      expect(codeOf(await send(ledger, reserveReq(user, body('14:00', '15:00'))))).toBe('RULE_COUNT');
      expect((await send(ledger, cancelReq(user, 2))).status).toBe(200);
      expect((await send(ledger, reserveReq(user, body('14:00', '15:00')))).status).toBe(200);
    });
  });

  test('RSV-8 開始時刻を過ぎて猶予の中の予約済は取り消せる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 50), endAt: at(11), status: 'reserved' }); // 猶予の終わり 10:05
      expect((await send(ledger, cancelReq(user, 1))).status).toBe(200);
      expect(reservations(state)[0].status).toBe('cancelled');
    });
  });

  test('RSV-8 開始時刻＋猶予がちょうど nowMin の予約済は無断不使用になり、取消は STATE_NOT_RESERVED（409）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      const result = await send(ledger, cancelReq(user, 1), { at: T10 + 30_000 });
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_RESERVED');
      expect(reservations(state)[0].status).toBe('no_show');
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: T10 });
    });
  });

  test('RSV-8 2回目の取消は STATE_NOT_RESERVED で、表と events が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect((await send(ledger, cancelReq(user, 1))).status).toBe(200);
      const before = { reservations: reservations(state), events: allEvents(state) };
      expect(codeOf(await send(ledger, cancelReq(user, 1)))).toBe('STATE_NOT_RESERVED');
      expect(reservations(state)).toEqual(before.reservations);
      expect(allEvents(state)).toEqual(before.events);
    });
  });

  test.each([
    ['利用中', 0],
    ['予約なしの利用で始めた利用中', 1],
  ])('RSV-8 %sの取消は STATE_NOT_RESERVED で、表と events が変わらない', async (_, walkIn) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'in_use', walkIn });
      const before = { reservations: reservations(state), events: allEvents(state) };
      expect(codeOf(await send(ledger, cancelReq(user, 1)))).toBe('STATE_NOT_RESERVED');
      expect(reservations(state)).toEqual(before.reservations);
      expect(allEvents(state)).toEqual(before.events);
    });
  });

  test.each([
    ['他の利用者の予約済', 'reserved'],
    ['他の利用者の取消済みの予約', 'cancelled'],
    ['ない番号', null],
  ])('RSV-8 %sは NOT_FOUND_RESERVATION（404）で、表が変わらない', async (_, status) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      if (status !== null) insertReservation(state, { userId: 2, startAt: at(11), endAt: at(12), status });
      const before = { reservations: reservations(state), events: allEvents(state) };
      const result = await send(ledger, cancelReq(user, status === null ? 99 : 1));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_RESERVATION');
      expect(reservations(state)).toEqual(before.reservations);
      expect(allEvents(state)).toEqual(before.events);
    });
  });
});

describe('USR-4 利用者がいない', () => {
  test('USR-4 識別の組の利用者がいなければ、一覧・取消とも NOT_FOUND_USER', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const nobody = { role: 'student', student_id: '99999999' };
      expect(codeOf(await send(ledger, myReq(user, nobody)))).toBe('NOT_FOUND_USER');
      expect(codeOf(await send(ledger, cancelReq(user, 1, nobody)))).toBe('NOT_FOUND_USER');
      expect(reservations(state)[0].status).toBe('reserved');
    });
  });
});

describe('RSV-23 ほぼ同時の取消', () => {
  test('RSV-23 同じ予約への取消を2つ同時に送ると、1つが成功し、もう1つが STATE_NOT_RESERVED', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const results = await Promise.all([send(ledger, cancelReq(user, 1)), send(ledger, cancelReq(user, 1))]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'STATE_NOT_RESERVED'].sort());
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

describe('USR-2 認証', () => {
  test('USR-2 一覧・取消とも Cookie がないと AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, myReq(undefined)))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, cancelReq(undefined, 1)))).toBe('AUTH_REQUIRED');
    });
  });

  test('USR-2 一覧・取消とも Origin がないと AUTH_ORIGIN', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect(codeOf(await send(ledger, myReq(user, STUDENT, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(codeOf(await send(ledger, cancelReq(user, 1, STUDENT, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(reservations(state)[0].status).toBe('reserved');
    });
  });

  test('ADM-1 管理者の Cookie だけでも AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, myReq(undefined, STUDENT, { admin })))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, cancelReq(undefined, 1, STUDENT, { admin })))).toBe('AUTH_REQUIRED');
    });
  });
});

describe('API 経路と本文', () => {
  test.each(['0', '01', 'abc'])('API 取消の {id} が %s なら NOT_FOUND_API', async (id) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, cancelReq(user, id)))).toBe('NOT_FOUND_API');
    });
  });

  test('API 証明が有効で本文に role がないと、一覧・取消とも INPUT_BODY', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const payload = { student_id: '12345678' };
      expect(codeOf(await send(ledger, myReq(user, payload)))).toBe('INPUT_BODY');
      expect(codeOf(await send(ledger, cancelReq(user, 1, payload)))).toBe('INPUT_BODY');
    });
  });
});

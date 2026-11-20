// 予約の管理（api.md 8.37〜8.40。MNG-3, RSV-21〜RSV-23, TIM-4, TIM-7, LOG-3, LOG-4）。
// 時計は 10:00:30（nowMin = 10:00）、猶予は初期値（15分）
import { describe, expect, test } from 'vitest';
import { SQL_ADMIN_DEVICE_RESERVATIONS } from '../../src/store/reservations.js';
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

const listReq = (admin, deviceId, options = {}) => req('GET', `/api/admin/devices/${deviceId}/reservations`, { admin, ...options });
const cancelReq = (admin, id, options = {}) =>
  req('POST', `/api/admin/reservations/${id}/cancel`, { body: {}, admin, ...options });
const finishReq = (admin, id, options = {}) =>
  req('POST', `/api/admin/reservations/${id}/finish`, { body: {}, admin, ...options });
const sendAt = (ledger, request, time = NOW_AT) => send(ledger, request, { at: time });
const allEvents = (state) => rows(state, 'SELECT * FROM events ORDER BY id');
const snapshot = (state) => ({ reservations: reservations(state), events: allEvents(state) });

describe('MNG-3 機器ごとの予約の一覧', () => {
  test('MNG-3 機器 A の予約済・利用中だけを開始時刻の順に返し、ほかの機器と過去の予約は出ない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 2, startAt: at(13), endAt: at(14), status: 'reserved' }); // 1 教員の予約済
      insertReservation(state, { userId: 1, startAt: at(11), endAt: at(12), status: 'reserved' }); // 2 生徒の予約済
      insertReservation(state, { userId: 1, startAt: at(9, 30), endAt: at(10, 30), status: 'in_use', walkIn: 1 }); // 3
      insertReservation(state, { deviceId: 2, startAt: at(11), endAt: at(12), status: 'reserved' }); // 4 機器 B
      for (const status of PAST_STATES) insertReservation(state, { startAt: at(15), endAt: at(16), status });

      const result = await sendAt(ledger, listReq(admin, 1));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_admin=/);
      expect(result.body.data.reservations.map((r) => r.id)).toEqual([3, 2, 1]);
    });
  });

  test('MNG-3 1つは id・start・end・status・role・student_id・name だけ。student_id はそろえた値、name は現在の値', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      state.storage.sql.exec("INSERT INTO devices (name, created_at) VALUES ('3Dプリンタ1', 0)");
      const registered = await send(
        ledger,
        req('POST', '/api/me/register', { body: { role: 'teacher', student_id: 'Ｔ-Suzuki', name: '鈴木' }, user }),
      );
      expect(registered.status).toBe(200);
      const userId = registered.body.data.id;
      insertReservation(state, { userId, startAt: at(11), endAt: at(12), status: 'reserved' });
      const changed = await send(
        ledger,
        req('POST', '/api/me/change', { body: { role: 'teacher', student_id: 't-suzuki', name: '鈴木 花子' }, user }),
      );
      expect(changed.status).toBe(200);

      const result = await sendAt(ledger, listReq(admin, 1));
      expect(result.body.data).toEqual({
        reservations: [
          {
            id: 1,
            start: `${DAY}T11:00`,
            end: `${DAY}T12:00`,
            status: 'reserved',
            role: 'teacher',
            student_id: 't-suzuki',
            name: '鈴木 花子',
          },
        ],
      });
    });
  });

  test('MNG-3 予約がなければ reservations は空の配列', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      expect((await sendAt(ledger, listReq(admin, 1))).body.data).toEqual({ reservations: [] });
    });
  });

  test('MNG-3 削除した機器・ない番号は NOT_FOUND_DEVICE（404）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      state.storage.sql.exec('UPDATE devices SET deleted_at = 1 WHERE id = 2');
      for (const id of [2, 99]) {
        const result = await sendAt(ledger, listReq(admin, id));
        expect(result.status).toBe(404);
        expect(codeOf(result)).toBe('NOT_FOUND_DEVICE');
      }
    });
  });

  test('RSV-21 猶予を過ぎた予約済・終了時刻を過ぎた利用中は、反映されて一覧に出ない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      insertReservation(state, { startAt: at(9), endAt: at(10), status: 'in_use' });
      expect((await sendAt(ledger, listReq(admin, 1))).body.data.reservations).toEqual([]);
      expect(reservations(state).map((r) => r.status)).toEqual(['no_show', 'finished']);
    });
  });

  test('MNG-3 一覧の SQL は reservations_device_status を使う', async () => {
    await withLedger(async (ledger, state) => {
      const plan = rows(state, `EXPLAIN QUERY PLAN ${SQL_ADMIN_DEVICE_RESERVATIONS}`, 1)
        .map((r) => r.detail)
        .join('\n');
      expect(plan).toContain('reservations_device_status');
    });
  });
});

describe('MNG-3 管理者による取消', () => {
  test('MNG-3 予約済を取り消すと admin_cancelled・admin_action になり、時刻は変わらず、記録が1行できる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });

      const result = await sendAt(ledger, cancelReq(admin, 1));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_admin=/);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: `${DAY}T11:00`,
        end: `${DAY}T12:00`,
        status: 'admin_cancelled',
      });
      expect(reservations(state)[0]).toMatchObject({
        status: 'admin_cancelled',
        cause: 'admin_action',
        start_at: at(11),
        end_at: at(12),
      });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({
        at: NOW_AT,
        actor_kind: 'admin',
        actor_admin_id: 1,
        admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
      });
      expect(JSON.parse(status[0].detail)).toEqual({ from: 'reserved', to: 'admin_cancelled', cause: 'admin_action' });
    });
  });

  test('MNG-3 取り消した直後に、同じ時間帯を別の人が確保でき、取り消された人の件数から外れる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec("INSERT INTO settings (key, value, effective_at) VALUES ('max_count', 1, 0)");
      insertReservation(state, { userId: 1, startAt: at(11), endAt: at(12), status: 'reserved' });
      expect(codeOf(await sendAt(ledger, reserveReq(user, body('13:00', '14:00'))))).toBe('RULE_COUNT');

      expect((await sendAt(ledger, cancelReq(admin, 1))).status).toBe(200);
      expect((await sendAt(ledger, reserveReq(user, body('11:00', '12:00', { who: TEACHER })))).status).toBe(200);
      expect((await sendAt(ledger, reserveReq(user, body('13:00', '14:00')))).status).toBe(200);
    });
  });

  test('MNG-3 開始時刻を過ぎて猶予の中の予約済は取り消せる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 50), endAt: at(11), status: 'reserved' });
      expect((await sendAt(ledger, cancelReq(admin, 1))).status).toBe(200);
      expect(reservations(state)[0].status).toBe('admin_cancelled');
    });
  });

  test('MNG-3 RSV-22 開始＋猶予がちょうど nowMin の予約済は無断不使用になり、取消は STATE_NOT_RESERVED（409）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      const result = await sendAt(ledger, cancelReq(admin, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_RESERVED');
      expect(reservations(state)[0].status).toBe('no_show');
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: T10 });
    });
  });

  test.each(['in_use', 'cancelled', 'admin_cancelled'])(
    'MNG-3 %s の取消は STATE_NOT_RESERVED で、表と記録が変わらない',
    async (status) => {
      await withLedger(async (ledger, state) => {
        const { admin } = await setup(ledger);
        seed(state);
        insertReservation(state, { startAt: at(9, 30), endAt: at(11), status });
        const before = snapshot(state);
        const result = await sendAt(ledger, cancelReq(admin, 1));
        expect(result.status).toBe(409);
        expect(codeOf(result)).toBe('STATE_NOT_RESERVED');
        expect(snapshot(state)).toEqual(before);
      });
    },
  );

  test('MNG-3 2回目の管理者による取消は STATE_NOT_RESERVED。ない番号は NOT_FOUND_RESERVATION（404）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      expect((await sendAt(ledger, cancelReq(admin, 1))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, cancelReq(admin, 1)))).toBe('STATE_NOT_RESERVED');
      const missing = await sendAt(ledger, cancelReq(admin, 99));
      expect(missing.status).toBe(404);
      expect(codeOf(missing)).toBe('NOT_FOUND_RESERVATION');
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

describe('MNG-3 管理者による終了', () => {
  test('MNG-3 TIM-4 利用中 [9:00, 11:00) を終了させると admin_finished・admin_action・end_at 10:00 になり、記録が1行できる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });

      const result = await sendAt(ledger, finishReq(admin, 1));
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_admin=/);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: `${DAY}T09:00`,
        end: `${DAY}T10:00`,
        status: 'admin_finished',
      });
      expect(reservations(state)[0]).toMatchObject({
        status: 'admin_finished',
        cause: 'admin_action',
        start_at: at(9),
        end_at: at(10),
        walk_in: 0,
      });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ at: NOW_AT, actor_kind: 'admin', actor_admin_id: 1, admin_id: null, user_id: 1 });
      expect(JSON.parse(status[0].detail)).toEqual({
        from: 'in_use',
        to: 'admin_finished',
        cause: 'admin_action',
        end_at: { before: at(11), after: at(10) },
      });
    });
  });

  test('MNG-3 終了させた直後に [10:00, 11:00) を別の人が予約なしの利用で使え、予約状況に admin_finished で出る', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      expect((await sendAt(ledger, finishReq(admin, 1))).status).toBe(200);

      const walkIn = await sendAt(
        ledger,
        req('POST', '/api/walk-ins', { body: { ...TEACHER, device_id: 1, end: `${DAY}T11:00` }, user }),
      );
      expect(walkIn.status).toBe(200);
      const day = await sendAt(ledger, dayReq(user));
      expect(day.body.data.slots.map((slot) => [slot.start, slot.end, slot.status])).toEqual([
        [`${DAY}T09:00`, `${DAY}T10:00`, 'admin_finished'],
        [`${DAY}T10:00`, `${DAY}T11:00`, 'in_use'],
      ]);
    });
  });

  test('MNG-3 終了させた直後に [10:00, 11:00) を別の人が確保できる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      expect((await sendAt(ledger, finishReq(admin, 1))).status).toBe(200);
      expect((await sendAt(ledger, reserveReq(user, body('10:00', '11:00', { who: TEACHER })))).status).toBe(200);
    });
  });

  test('MNG-3 RSV-22 終了時刻がちょうど 10:00 の利用中は自動で終了になり、管理者による終了は STATE_NOT_IN_USE（409）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(10), status: 'in_use' });
      const result = await sendAt(ledger, finishReq(admin, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('STATE_NOT_IN_USE');
      expect(reservations(state)[0]).toMatchObject({ status: 'finished', end_at: at(10) });
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0].actor_kind).toBe('auto');
    });
  });

  test('TIM-7 10:00:10 に予約なしの利用を始め、10:00:50 に管理者が終了させると start_at = end_at = 10:00', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      const walkIn = await sendAt(
        ledger,
        req('POST', '/api/walk-ins', { body: { ...STUDENT, device_id: 1, end: `${DAY}T11:00` }, user }),
        T10 + 10_000,
      );
      expect(walkIn.status).toBe(200);
      const result = await sendAt(ledger, finishReq(admin, walkIn.body.data.id), T10 + 50_000);
      expect(result.status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ status: 'admin_finished', start_at: T10, end_at: T10, walk_in: 1 });
    });
  });

  test('MNG-3 予約済・2回目の管理者による終了は STATE_NOT_IN_USE。ない番号は NOT_FOUND_RESERVATION', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use', deviceId: 2 });
      const before = snapshot(state);
      expect(codeOf(await sendAt(ledger, finishReq(admin, 1)))).toBe('STATE_NOT_IN_USE');
      expect(snapshot(state)).toEqual(before);
      expect((await sendAt(ledger, finishReq(admin, 2))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, finishReq(admin, 2)))).toBe('STATE_NOT_IN_USE');
      expect(codeOf(await sendAt(ledger, finishReq(admin, 99)))).toBe('NOT_FOUND_RESERVATION');
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

describe('RSV-23 ほぼ同時の操作', () => {
  test('RSV-23 管理者による取消と本人の利用開始を同時に送ると、1つが成功し、もう1つが STATE_NOT_RESERVED', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      const results = await Promise.all([
        sendAt(ledger, cancelReq(admin, 1)),
        sendAt(ledger, req('POST', '/api/reservations/1/begin', { body: STUDENT, user })),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'STATE_NOT_RESERVED'].sort());
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });

  test('RSV-23 管理者による終了と本人の利用終了を同時に送ると、1つが STATE_NOT_IN_USE', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      const results = await Promise.all([
        sendAt(ledger, finishReq(admin, 1)),
        sendAt(ledger, req('POST', '/api/reservations/1/finish', { body: STUDENT, user })),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'STATE_NOT_IN_USE'].sort());
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

describe('RSV-21 断ったときの自動の変化', () => {
  test.each([
    ['一覧', (admin) => listReq(admin, 99), 'NOT_FOUND_DEVICE'],
    ['取消', (admin) => cancelReq(admin, 99), 'NOT_FOUND_RESERVATION'],
    ['終了', (admin) => finishReq(admin, 99), 'NOT_FOUND_RESERVATION'],
  ])('RSV-21 %s を段 2 で断っても、反映した自動の変化が残る', async (_, makeReq, code) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(10), status: 'in_use' });
      expect(codeOf(await sendAt(ledger, makeReq(admin)))).toBe(code);
      expect(reservations(state)[0].status).toBe('finished');
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

describe('ADM-1 予約の管理の API の認証', () => {
  const all = [
    ['一覧', (cookies) => req('GET', '/api/admin/devices/1/reservations', cookies)],
    ['取消', (cookies) => req('POST', '/api/admin/reservations/1/cancel', { body: {}, ...cookies })],
    ['終了', (cookies) => req('POST', '/api/admin/reservations/1/finish', { body: {}, ...cookies })],
  ];

  test.each(all)('ADM-1 %s は利用者の Cookie だけでは AUTH_REQUIRED', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      const result = await sendAt(ledger, makeReq({ user }));
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_REQUIRED');
    });
  });

  test.each(all)('ADM-1 %s は管理者の証明を解いた後は AUTH_REVOKED', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      expect((await sendAt(ledger, req('POST', '/api/admin/logout', { body: {}, admin }))).status).toBe(200);
      const before = reservations(state);
      expect(codeOf(await sendAt(ledger, makeReq({ admin })))).toBe('AUTH_REVOKED');
      expect(reservations(state)).toEqual(before);
    });
  });
});

describe('API 予約の管理の要求の形', () => {
  const posts = [
    ['取消', cancelReq],
    ['終了', finishReq],
  ];

  test.each(posts)('API %s で Origin がないと AUTH_ORIGIN', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const before = snapshot(state);
      expect(codeOf(await sendAt(ledger, makeReq(admin, 1, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(snapshot(state)).toEqual(before);
    });
  });

  test.each(posts)('API %s で本文が壊れていると INPUT_BODY', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(11), endAt: at(12), status: 'reserved' });
      const broken = makeReq(admin, 1);
      const result = await sendAt(ledger, new Request(broken.url, { method: 'POST', headers: broken.headers, body: '{' }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_BODY');
    });
  });

  test('API 一覧（GET）は Origin を確かめない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      expect((await sendAt(ledger, listReq(admin, 1, { origin: null }))).status).toBe(200);
    });
  });

  test('API {id} が 0・01・abc なら NOT_FOUND_API', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      for (const id of ['0', '01', 'abc']) {
        expect(codeOf(await sendAt(ledger, listReq(admin, id)))).toBe('NOT_FOUND_API');
        expect(codeOf(await sendAt(ledger, cancelReq(admin, id)))).toBe('NOT_FOUND_API');
        expect(codeOf(await sendAt(ledger, finishReq(admin, id)))).toBe('NOT_FOUND_API');
      }
    });
  });

  test('API 終了の本文に end を入れても無視され、end_at は nowMin', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: at(11), status: 'in_use' });
      const result = await sendAt(
        ledger,
        req('POST', '/api/admin/reservations/1/finish', { body: { end: `${DAY}T10:30` }, admin }),
      );
      expect(result.status).toBe(200);
      expect(reservations(state)[0].end_at).toBe(at(10));
    });
  });
});

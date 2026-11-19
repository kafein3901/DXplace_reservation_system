// 自動の変化の反映と書き込み（api.md 3.5・7）。テスト用の経路で、各 API と同じ形に transactionSync の中で反映する
import { describe, expect, test } from 'vitest';
import { applyAutoTransitions } from '../../src/api/auto.js';
import { ok, refuse } from '../../src/api/respond.js';
import { MIN, T10, fixedClock, insertReservation, request, rows, seedDeviceAndUser, withLedger } from './helpers.js';

function reflectThen(after) {
  return ({ storage, nowMin }) =>
    storage.transactionSync(() => {
      applyAutoTransitions(storage.sql, nowMin);
      return after(storage);
    });
}

const ROUTES = [
  { method: 'POST', path: '/api/test/auto', auth: 'public', wrap: false, handler: reflectThen(() => ok({})) },
  { method: 'GET', path: '/api/test/auto', auth: 'public', wrap: false, handler: reflectThen(() => ok({})) },
  { method: 'POST', path: '/api/test/auto-refuse', auth: 'public', wrap: false, handler: reflectThen(() => refuse('RULE_TEST')) },
  {
    method: 'POST',
    path: '/api/test/auto-throw',
    auth: 'public',
    wrap: false,
    handler: reflectThen(() => {
      throw new Error('テストの例外');
    }),
  },
];

function call(ledger, at, path = '/api/test/auto', method = 'POST') {
  return ledger.handle(request(method, path, method === 'POST' ? { body: {} } : {}), fixedClock(at), ROUTES);
}

function reservationsOf(state) {
  return rows(state, 'SELECT id, start_at, end_at, status, cause, walk_in FROM reservations ORDER BY id');
}

function eventsOf(state) {
  return rows(state, 'SELECT * FROM events ORDER BY id').map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
}

describe('RSV-13 猶予を過ぎた予約済は、見た時点で無断不使用になる', () => {
  test('RSV-13 状態だけが no_show になり、時刻は変わらない。記録は自動・ルール上の時刻・from と to だけ', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      await call(ledger, T10 + 40 * MIN);

      expect(reservationsOf(state)).toEqual([
        { id: 1, start_at: T10, end_at: T10 + 60 * MIN, status: 'no_show', cause: null, walk_in: 0 },
      ]);
      expect(eventsOf(state)).toEqual([
        {
          id: 1,
          at: T10 + 15 * MIN,
          actor_kind: 'auto',
          actor_admin_id: null,
          kind: 'reservation_status',
          reservation_id: 1,
          device_id: 1,
          user_id: 1,
          admin_id: null,
          detail: { from: 'reserved', to: 'no_show' },
        },
      ]);
    });
  });

  test('RSV-13 数値の履歴の表の猶予を使う（猶予 30 分なら 10:15 ではまだ予約済）', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      state.storage.sql.exec("INSERT INTO settings (key, value, effective_at) VALUES ('grace_minutes', 30, 0)");
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      await call(ledger, T10 + 15 * MIN);
      expect(reservationsOf(state)[0].status).toBe('reserved');

      await call(ledger, T10 + 30 * MIN);
      expect(reservationsOf(state)[0].status).toBe('no_show');
      expect(eventsOf(state)[0].at).toBe(T10 + 30 * MIN);
    });
  });
});

describe('RSV-19 終了時刻を過ぎた利用中は、見た時点で終了になる', () => {
  test('RSV-19 finished になり、終了時刻はもとのまま。記録の時刻は終了時刻', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'in_use', walkIn: 1 });

      await call(ledger, T10 + 90 * MIN);

      expect(reservationsOf(state)).toEqual([
        { id: 1, start_at: T10, end_at: T10 + 60 * MIN, status: 'finished', cause: null, walk_in: 1 },
      ]);
      const [event] = eventsOf(state);
      expect(event.at).toBe(T10 + 60 * MIN);
      expect(event.actor_kind).toBe('auto');
      expect(event.detail).toEqual({ from: 'in_use', to: 'finished' });
    });
  });
});

describe('RSV-22 同じ時刻では、自動の変化が操作より先に起きる', () => {
  test('RSV-22 猶予の終わり（10:15）と同じ分の 10:15:30 に届いた要求では、先に無断不使用になっている', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      await call(ledger, T10 + 15 * MIN - 1); // 10:14:59.999
      expect(reservationsOf(state)[0].status).toBe('reserved');
      expect(eventsOf(state)).toEqual([]);

      await call(ledger, T10 + 15 * MIN + 30_000); // 10:15:30
      expect(reservationsOf(state)[0].status).toBe('no_show');
    });
  });
});

describe('RSV-21 自動の変化は、定期処理がなくても見た時点で正しく反映される', () => {
  test('RSV-21 同じ時刻の変化は予約の番号の順に、違う時刻は起きる時刻の順に記録される', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' }); // 1：10:25
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' }); // 2：10:15
      insertReservation(state, { startAt: T10 - 60 * MIN, endAt: T10 + 15 * MIN, status: 'in_use' }); // 3：10:15
      insertReservation(state, { startAt: T10 - 60 * MIN, endAt: T10 + 5 * MIN, status: 'in_use' }); // 4：10:05

      await call(ledger, T10 + 30 * MIN);

      expect(eventsOf(state).map((e) => [e.reservation_id, e.at, e.detail.to])).toEqual([
        [4, T10 + 5 * MIN, 'finished'],
        [2, T10 + 15 * MIN, 'no_show'],
        [3, T10 + 15 * MIN, 'finished'],
        [1, T10 + 25 * MIN, 'no_show'],
      ]);
    });
  });

  test('RSV-21 読むだけの API（GET）でも反映して書き込む', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      await call(ledger, T10 + 15 * MIN, '/api/test/auto', 'GET');

      expect(reservationsOf(state)[0].status).toBe('no_show');
      expect(eventsOf(state)).toHaveLength(1);
    });
  });

  test('RSV-21 一度反映した変化は、次の要求で二重に書かれない', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      await call(ledger, T10 + 15 * MIN);
      await call(ledger, T10 + 20 * MIN);

      expect(eventsOf(state)).toHaveLength(1);
    });
  });

  test('RSV-21 時間帯を確保していない予約と、まだ起きない予約には何もしない', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'cancelled' });
      insertReservation(state, { startAt: T10 + 60 * MIN, endAt: T10 + 120 * MIN, status: 'reserved' });

      await call(ledger, T10 + 30 * MIN);

      expect(reservationsOf(state).map((r) => r.status)).toEqual(['cancelled', 'reserved']);
      expect(eventsOf(state)).toEqual([]);
    });
  });

  test('RSV-21 反映した変化は、その要求が後で断られても残る', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      const response = await call(ledger, T10 + 15 * MIN, '/api/test/auto-refuse');

      expect(response.status).toBe(409);
      expect(reservationsOf(state)[0].status).toBe('no_show');
      expect(eventsOf(state)).toHaveLength(1);
    });
  });

  test('RSV-21 反映の後で例外が起きたら、反映も取り消される', async () => {
    await withLedger(async (ledger, state) => {
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' });

      const response = await call(ledger, T10 + 15 * MIN, '/api/test/auto-throw');

      expect(response.status).toBe(500);
      expect(reservationsOf(state)[0].status).toBe('reserved');
      expect(eventsOf(state)).toEqual([]);
    });
  });
});

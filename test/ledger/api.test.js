// 共通の流れ（api.md 3・4・7）。特定の API に頼らず、テスト用の経路の表を handle に渡して確かめる
import { exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { ok, refuse } from '../../src/api/respond.js';
import { MIN, ORIGIN, T10, fixedClock, request, rows, withLedger } from './helpers.js';

// 受け取ったものを返すだけの処理
function echo(context) {
  return ok({ params: context.params, body: context.body, now: context.now, nowMin: context.nowMin });
}

const ROUTES = [
  { method: 'POST', path: '/api/test/echo', auth: 'public', wrap: false, handler: echo },
  { method: 'GET', path: '/api/test/echo', auth: 'public', wrap: false, handler: echo },
  { method: 'POST', path: '/api/test/items/{id}/echo', auth: 'public', wrap: false, handler: echo },
  { method: 'POST', path: '/api/test/refuse', auth: 'public', wrap: false, handler: () => refuse('RULE_TEST') },
  {
    // 書き込んでから例外を投げる
    method: 'POST',
    path: '/api/test/throw',
    auth: 'public',
    wrap: false,
    handler: ({ storage }) =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO devices (name, created_at) VALUES ('書き込まれないはず', 0)");
        throw new Error('テストの例外');
      }),
  },
  {
    // 包む処理（PBKDF2 を使う操作の形）。await を挟んでから例外を投げる
    method: 'POST',
    path: '/api/test/wrapped-throw',
    auth: 'public',
    wrap: true,
    handler: async () => {
      await crypto.subtle.digest('SHA-256', new Uint8Array(1));
      throw new Error('テストの例外');
    },
  },
  {
    method: 'POST',
    path: '/api/test/wrapped',
    auth: 'public',
    wrap: true,
    handler: async (context) => {
      await crypto.subtle.digest('SHA-256', new Uint8Array(1));
      return echo(context);
    },
  },
];

async function json(response) {
  return { status: response.status, body: await response.json() };
}

describe('API 経路（共1）', () => {
  test('API ない経路は NOT_FOUND_API（404）', async () => {
    await withLedger(async (ledger) => {
      expect(await json(await ledger.handle(request('POST', '/api/test/none', { body: {} }), fixedClock(T10), ROUTES))).toEqual({
        status: 404,
        body: { ok: false, error: { code: 'NOT_FOUND_API' } },
      });
    });
  });

  test('API メソッドが違えば NOT_FOUND_API', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('GET', '/api/test/refuse'), fixedClock(T10), ROUTES);
      expect((await json(response)).body.error.code).toBe('NOT_FOUND_API');
    });
  });

  test('API 本番の経路の表を渡さなければ、テスト用の経路はない', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/echo', { body: {} }), fixedClock(T10));
      expect((await json(response)).body.error.code).toBe('NOT_FOUND_API');
    });
  });

  test('API {id} が正の整数なら数値で渡す', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/items/12/echo', { body: {} }), fixedClock(T10), ROUTES);
      expect((await json(response)).body.data.params).toEqual({ id: 12 });
    });
  });

  test.each(['0', '01', '-1', '1.5', 'abc', '1e3', '%31', ''])('API {id} が「%s」なら NOT_FOUND_API', async (id) => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', `/api/test/items/${id}/echo`, { body: {} }), fixedClock(T10), ROUTES);
      expect(await json(response)).toEqual({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND_API' } } });
    });
  });
});

describe('API Origin（共2）', () => {
  test('API POST で Origin がなければ AUTH_ORIGIN（401）', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/echo', { body: {}, headers: {} }), fixedClock(T10), ROUTES);
      expect(await json(response)).toEqual({ status: 401, body: { ok: false, error: { code: 'AUTH_ORIGIN' } } });
    });
  });

  test.each(['https://evil.example.test', 'http://dxplace.example.test', `${ORIGIN}/`, 'null'])(
    'API POST で Origin が「%s」なら AUTH_ORIGIN',
    async (origin) => {
      await withLedger(async (ledger) => {
        const response = await ledger.handle(request('POST', '/api/test/echo', { body: {}, headers: { Origin: origin } }), fixedClock(T10), ROUTES);
        expect((await json(response)).body.error.code).toBe('AUTH_ORIGIN');
      });
    },
  );

  test('API GET は Origin を確かめない', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('GET', '/api/test/echo', { headers: {} }), fixedClock(T10), ROUTES);
      expect((await json(response)).body.ok).toBe(true);
    });
  });

  test('API Origin は本文より先に確かめる', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/echo', { body: 'not json', headers: {} }), fixedClock(T10), ROUTES);
      expect((await json(response)).body.error.code).toBe('AUTH_ORIGIN');
    });
  });
});

describe('API 本文（共4）', () => {
  test.each([
    ['JSON でない', 'a=1'],
    ['配列', '[1]'],
    ['null', 'null'],
    ['16 KiB を超える', JSON.stringify({ a: 'x'.repeat(16 * 1024) })],
  ])('API 本文が%sなら INPUT_BODY（400）', async (_, body) => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/echo', { body }), fixedClock(T10), ROUTES);
      expect(await json(response)).toEqual({ status: 400, body: { ok: false, error: { code: 'INPUT_BODY' } } });
    });
  });

  test('API 知らない項目があっても受け付け、そのまま渡す', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/echo', { body: { unknown: 1 } }), fixedClock(T10), ROUTES);
      expect((await json(response)).body.data.body).toEqual({ unknown: 1 });
    });
  });

  test('API GET には本文を渡さない', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('GET', '/api/test/echo'), fixedClock(T10), ROUTES);
      expect((await json(response)).body.data.body).toBeNull();
    });
  });
});

describe('API ヘッダ（api.md 1）', () => {
  test.each([
    ['成功', 'POST', '/api/test/echo', 200],
    ['断る', 'POST', '/api/test/refuse', 409],
    ['経路がない', 'GET', '/api/test/none', 404],
    ['例外', 'POST', '/api/test/throw', 500],
  ])('API %sでも Cache-Control: no-store と JSON の Content-Type が付く', async (_, method, path, status) => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request(method, path, method === 'POST' ? { body: {} } : {}), fixedClock(T10), ROUTES);
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });
  });

  test('API 断るときは頭で決まる HTTP（RULE_ は 409）とコードを返す', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/refuse', { body: {} }), fixedClock(T10), ROUTES);
      expect(await json(response)).toEqual({ status: 409, body: { ok: false, error: { code: 'RULE_TEST' } } });
    });
  });
});

describe('API 例外（api.md 1）', () => {
  test('API 処理の途中で例外が起きると 500 と { ok: false } を返し、表に何も書かれていない', async () => {
    await withLedger(async (ledger, state) => {
      const response = await ledger.handle(request('POST', '/api/test/throw', { body: {} }), fixedClock(T10), ROUTES);
      expect(await json(response)).toEqual({ status: 500, body: { ok: false } });
      expect(rows(state, 'SELECT COUNT(*) AS n FROM devices')[0].n).toBe(0);
    });
  });

  test('API 包む処理で例外が起きても 500 を返し、台帳はその後も要求を受ける', async () => {
    await withLedger(async (ledger) => {
      const failed = await ledger.handle(request('POST', '/api/test/wrapped-throw', { body: {} }), fixedClock(T10), ROUTES);
      expect(await json(failed)).toEqual({ status: 500, body: { ok: false } });
      const next = await ledger.handle(request('POST', '/api/test/echo', { body: {} }), fixedClock(T10), ROUTES);
      expect((await json(next)).body.ok).toBe(true);
    });
  });

  test('API 包む処理は、await を挟んでも結果を返す', async () => {
    await withLedger(async (ledger) => {
      const response = await ledger.handle(request('POST', '/api/test/wrapped', { body: { a: 1 } }), fixedClock(T10), ROUTES);
      expect((await json(response)).body.data.body).toEqual({ a: 1 });
    });
  });
});

describe('API 時計（time-and-concurrency.md 2）', () => {
  test('API 1つの要求で clock() は1回だけ呼ばれ、now と秒を切り捨てた nowMin を渡す（TIM-4）', async () => {
    await withLedger(async (ledger) => {
      const clock = fixedClock(T10 + 59_999);
      const response = await ledger.handle(request('POST', '/api/test/echo', { body: {} }), clock, ROUTES);
      expect(clock.calls).toBe(1);
      const { data } = (await json(response)).body;
      expect(data.now).toBe(T10 + 59_999);
      expect(data.nowMin).toBe(T10);
    });
  });

  test('API 包む処理でも clock() は1回だけ', async () => {
    await withLedger(async (ledger) => {
      const clock = fixedClock(T10 + MIN);
      await ledger.handle(request('POST', '/api/test/wrapped', { body: {} }), clock, ROUTES);
      expect(clock.calls).toBe(1);
    });
  });

  test('API 共通の確かめる順で断るときも clock() は1回だけ', async () => {
    await withLedger(async (ledger) => {
      const clock = fixedClock(T10);
      await ledger.handle(request('POST', '/api/test/echo', { body: 'x' }), clock, ROUTES);
      expect(clock.calls).toBe(1);
    });
  });
});

describe('API Worker（api.md 3.1）', () => {
  test('API パスが /api/ で始まらなければ、Worker が NOT_FOUND_API を返す', async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/index.html`));
    expect(await json(response)).toEqual({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND_API' } } });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('API /api/ の要求は台帳に渡す（経路の表がまだ空なので NOT_FOUND_API）', async () => {
    const response = await exports.default.fetch(request('POST', '/api/anything', { body: {} }));
    expect(await json(response)).toEqual({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND_API' } } });
  });
});

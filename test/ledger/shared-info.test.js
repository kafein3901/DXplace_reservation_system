// 共有された情報の設定・変更（api.md 8.9・8.10）
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, seedDeviceAndUser, withLedger } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_ATTRIBUTES = 'Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict';

// 速い計算の関数に差し替える（PBKDF2 はこの機能の対象ではない）
const routes = buildRoutes({ derivePassword: (password, salt) => sha256(`${password}:${[...salt].join(',')}`) });

function adminRequest(method, path, { body, cookie, origin = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': '192.0.2.1' };
  if (origin !== null) headers.Origin = origin;
  if (cookie !== undefined) headers.Cookie = `__Host-dxp_admin=${cookie}`;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const setReq = (cookie, options = {}) => adminRequest('POST', '/api/admin/shared-info', { body: {}, cookie, ...options });
const meReq = (cookie) => adminRequest('GET', '/api/admin/me', { cookie });

async function send(ledger, req, { at = T10 } = {}) {
  const response = await ledger.handle(req, fixedClock(at), routes);
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('Set-Cookie') };
}

const codeOf = (result) => result.body.error?.code;

// 管理者を作って認証し、証明の値を返す
async function adminToken(ledger, loginId) {
  const created = await send(
    ledger,
    new Request(`${ORIGIN}/api/maint/admins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
      body: JSON.stringify({ login_id: loginId, display_name: '田中 太郎', password: PASSWORD }),
    }),
  );
  expect(created.status).toBe(200);
  const login = await send(ledger, adminRequest('POST', '/api/admin/login', { body: { login_id: loginId, password: PASSWORD } }));
  expect(login.status).toBe(200);
  return /^__Host-dxp_admin=([^;]*);/.exec(login.setCookie)[1];
}

const sharedInfos = (state) => rows(state, 'SELECT id, hash, created_at FROM shared_infos ORDER BY id');
const setEvents = (state) => rows(state, "SELECT * FROM events WHERE kind = 'shared_info_set' ORDER BY id");
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('ADM-3 共有された情報の設定・変更（POST /api/admin/shared-info）', () => {
  test('ADM-3 未設定の台帳で呼ぶと1行でき、応答の value は43文字の base64url で、その SHA-256 が hash と等しい', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      expect(sharedInfos(state)).toHaveLength(0);

      const result = await send(ledger, setReq(token), { at: T10 + 5 * MIN + 1234 });
      expect(result.status).toBe(200);
      expect(Object.keys(result.body.data)).toEqual(['value']);
      expect(result.body.data.value).toMatch(TOKEN_PATTERN);

      const [row] = sharedInfos(state);
      expect(sharedInfos(state)).toHaveLength(1);
      expect(hex(row.hash)).toBe(hex(await sha256(result.body.data.value)));
      // 記録の時刻は切り捨てない（TIM-7）
      expect(row.created_at).toBe(T10 + 5 * MIN + 1234);
    });
  });

  test('ADM-3 2回目は id が1つ大きい行が足され、値もハッシュも1回目と違う。1回目の行は残る', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      const first = await send(ledger, setReq(token));
      const second = await send(ledger, setReq(token));
      expect(second.status).toBe(200);
      expect(second.body.data.value).not.toBe(first.body.data.value);

      const [a, b] = sharedInfos(state);
      expect(sharedInfos(state)).toHaveLength(2);
      expect(b.id).toBe(a.id + 1);
      expect(hex(a.hash)).toBe(hex(await sha256(first.body.data.value)));
      expect(hex(b.hash)).toBe(hex(await sha256(second.body.data.value)));
    });
  });

  test('ADM-3 呼ぶ前後で、予約済・利用中の予約の行が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      seedDeviceAndUser(state);
      // どちらも T10 では自動の変化の対象にならない
      insertReservation(state, { startAt: T10 + 60 * MIN, endAt: T10 + 120 * MIN, status: 'reserved' });
      insertReservation(state, { startAt: T10 - 30 * MIN, endAt: T10 + 30 * MIN, status: 'in_use' });
      const before = rows(state, 'SELECT * FROM reservations ORDER BY id');

      expect((await send(ledger, setReq(token))).status).toBe(200);
      expect(rows(state, 'SELECT * FROM reservations ORDER BY id')).toEqual(before);
    });
  });

  test('ADM-3 呼んだ管理者もほかの管理者も、その後の me が通る。応答に同じ値の Set-Cookie が付く', async () => {
    await withLedger(async (ledger, state) => {
      const a = await adminToken(ledger, 'tanaka');
      const b = await adminToken(ledger, 'sato');
      const sessions = rows(state, 'SELECT * FROM admin_sessions ORDER BY id');

      const result = await send(ledger, setReq(a));
      expect(result.setCookie).toBe(`__Host-dxp_admin=${a}; ${COOKIE_ATTRIBUTES}`);
      expect((await send(ledger, meReq(a))).status).toBe(200);
      expect((await send(ledger, meReq(b))).status).toBe(200);
      expect(rows(state, 'SELECT * FROM admin_sessions ORDER BY id')).toEqual(sessions);
    });
  });
});

describe('ADM-2 共有された情報の設定に要る管理者の証明', () => {
  test('ADM-2 Cookie がないと AUTH_REQUIRED、解いた証明では AUTH_REVOKED で、行が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      const eventCount = rows(state, 'SELECT * FROM events').length;

      expect(codeOf(await send(ledger, setReq(undefined)))).toBe('AUTH_REQUIRED');
      await send(ledger, adminRequest('POST', '/api/admin/logout', { body: {}, cookie: token }));
      const revoked = await send(ledger, setReq(token));
      expect(codeOf(revoked)).toBe('AUTH_REVOKED');
      expect(revoked.setCookie).toBeNull();

      expect(sharedInfos(state)).toHaveLength(0);
      // logout の記録だけが増える
      expect(rows(state, 'SELECT * FROM events')).toHaveLength(eventCount + 1);
      expect(setEvents(state)).toHaveLength(0);
    });
  });
});

describe('API 共有された情報の設定の確かめる順', () => {
  test('API Origin がないと AUTH_ORIGIN。本文が壊れていて証明もないと AUTH_REQUIRED。証明が有効で本文が壊れていると INPUT_BODY。どれも行が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');

      expect(codeOf(await send(ledger, setReq(token, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(codeOf(await send(ledger, setReq(undefined, { body: '{' })))).toBe('AUTH_REQUIRED');
      const broken = await send(ledger, setReq(token, { body: '{' }));
      expect(codeOf(broken)).toBe('INPUT_BODY');

      expect(sharedInfos(state)).toHaveLength(0);
      expect(setEvents(state)).toHaveLength(0);
    });
  });
});

describe('LOG-4 共有された情報の設定の記録', () => {
  test('LOG-4 成功すると shared_info_set の行が actor_admin_id 付きででき、detail は version だけ。値もハッシュも入っていない', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      const result = await send(ledger, setReq(token), { at: T10 + 1234 });
      const [row] = sharedInfos(state);

      const events = setEvents(state);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        at: T10 + 1234,
        actor_kind: 'admin',
        actor_admin_id: 1,
        reservation_id: null,
        device_id: null,
        user_id: null,
        admin_id: null,
      });
      expect(JSON.parse(events[0].detail)).toEqual({ version: row.id });

      const dump = JSON.stringify(rows(state, 'SELECT * FROM events'));
      for (const secret of [result.body.data.value, hex(row.hash)]) expect(dump).not.toContain(secret);
      for (const value of Object.values(events[0])) expect(value instanceof ArrayBuffer).toBe(false);
    });
  });
});

describe('SEC-4 共有された情報の設定で例外が起きたとき', () => {
  afterEach(() => vi.restoreAllMocks());

  test('SEC-4 記録の書き込みで例外が起きると 500 で、console.error に値が出ず、行も増えない', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      // 記録の表をなくして、行を足した後の書き込みで例外を起こす
      state.storage.sql.exec('ALTER TABLE events RENAME TO events_moved');
      const errors = [];
      vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')));

      const result = await send(ledger, setReq(token));
      expect(result.status).toBe(500);
      expect(result.body.data).toBeUndefined();
      expect(errors.length).toBeGreaterThan(0);
      // 値は43文字の base64url。出力にその形の並びがない（Cookie の値も同じ形なので、両方が出ていないことになる）
      for (const line of errors) expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(sharedInfos(state)).toHaveLength(0);
    });
  });
});

describe('RSV-21 共有された情報の設定と自動の変化', () => {
  test('RSV-21 開始時刻＋猶予を過ぎた予約済の予約がある台帳で呼ぶと、無断不使用になる', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      seedDeviceAndUser(state);
      insertReservation(state, { startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });

      expect((await send(ledger, setReq(token), { at: T10 + 30 * MIN })).status).toBe(200);
      expect(rows(state, 'SELECT status FROM reservations').map((r) => r.status)).toEqual(['no_show']);
    });
  });
});

describe('RSV-23 同時の設定', () => {
  test('RSV-23 2つ同時に送ると、どちらも成功して2行でき、2つの値は違い、2行のハッシュがそれぞれの値に当たる', async () => {
    await withLedger(async (ledger, state) => {
      const token = await adminToken(ledger, 'tanaka');
      const results = await Promise.all([send(ledger, setReq(token)), send(ledger, setReq(token))]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const [v1, v2] = results.map((r) => r.body.data.value);
      expect(v1).not.toBe(v2);

      const infos = sharedInfos(state);
      expect(infos).toHaveLength(2);
      // 1つずつ処理され、記録の版も行の順に並ぶ。どちらの応答が後に処理されたかは外から見分けられないので、
      // 2行のハッシュが2つの値にそれぞれ当たることを確かめる（後の行が現在の値になるのは schema.md 2.6 の決まり）
      const versions = setEvents(state).map((e) => JSON.parse(e.detail).version);
      expect(versions).toEqual([infos[0].id, infos[1].id]);
      const hashes = await Promise.all([v1, v2].map(async (v) => hex(await sha256(v))));
      expect(hashes).toContain(hex(infos[1].hash));
      expect(hashes).toContain(hex(infos[0].hash));
    });
  });
});

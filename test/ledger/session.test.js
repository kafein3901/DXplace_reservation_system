// 利用の開始と利用者の証明（api.md 8.11〜8.14）
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ok, refuse } from '../../src/api/respond.js';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, seedDeviceAndUser, withLedger } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';
const IP = '192.0.2.1';
const COOKIE_ATTRIBUTES = 'Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict';

// 速い計算の関数に差し替える（PBKDF2 はこの機能の対象ではない）。
// 利用者の API はまだないので、共3（api.md 8.12）を確かめるテスト用の経路を足す（api.md 3.2）。
// 本文の fail が真なら、共3 を通った後の段で断る
const routes = [
  ...buildRoutes({ derivePassword: (password, salt) => sha256(`${password}:${[...salt].join(',')}`) }),
  {
    method: 'POST',
    path: '/api/test/user',
    auth: 'user',
    wrap: false,
    handler: ({ body }) => (body.fail ? refuse('RULE_TEST') : ok({ passed: true })),
  },
];

// cookie は利用者の Cookie の値、admin は管理者の Cookie の値
function req(method, path, { body, cookie, admin, origin = ORIGIN, ip = IP } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  const cookies = [];
  if (cookie !== undefined) cookies.push(`__Host-dxp_user=${cookie}`);
  if (admin !== undefined) cookies.push(`__Host-dxp_admin=${admin}`);
  if (cookies.length > 0) headers.Cookie = cookies.join('; ');
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const startReq = (k, options = {}) => req('POST', '/api/session', { body: { k }, ...options });
const statusReq = (cookie) => req('GET', '/api/session', { cookie });
const userApiReq = (cookie, options = {}) => req('POST', '/api/test/user', { body: {}, cookie, ...options });

async function send(ledger, request, { at = T10 } = {}) {
  const response = await ledger.handle(request, fixedClock(at), routes);
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('Set-Cookie') };
}

const codeOf = (result) => result.body.error?.code;
const userTokenOf = (result) => /^__Host-dxp_user=([^;]*);/.exec(result.setCookie)[1];
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

// 管理者を作って認証し、証明の値を返す
async function adminToken(ledger, loginId = 'tanaka') {
  const created = await send(
    ledger,
    new Request(`${ORIGIN}/api/maint/admins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
      body: JSON.stringify({ login_id: loginId, display_name: '田中 太郎', password: PASSWORD }),
    }),
  );
  expect(created.status).toBe(200);
  const login = await send(ledger, req('POST', '/api/admin/login', { body: { login_id: loginId, password: PASSWORD } }));
  expect(login.status).toBe(200);
  return /^__Host-dxp_admin=([^;]*);/.exec(login.setCookie)[1];
}

// 共有された情報を設定し、値を返す（api.md 8.9）
async function setSharedInfo(ledger, admin) {
  const result = await send(ledger, req('POST', '/api/admin/shared-info', { body: {}, admin }));
  expect(result.status).toBe(200);
  return result.body.data.value;
}

// 管理者を作り、共有された情報を設定し、利用を始める
async function setup(ledger) {
  const admin = await adminToken(ledger);
  const k = await setSharedInfo(ledger, admin);
  const started = await send(ledger, startReq(k));
  expect(started.status).toBe(200);
  return { admin, k, user: userTokenOf(started) };
}

const userSessions = (state) => rows(state, 'SELECT * FROM user_sessions ORDER BY id');
const failures = (state) => rows(state, "SELECT * FROM auth_failures WHERE entry = 'shared_info' ORDER BY id");

function insertFailures(state, count, { client = IP, window = T10 } = {}) {
  state.storage.sql.exec(
    `INSERT INTO auth_failures (entry, client, window_start, failures, unknown_id_failures, wrong_password_failures,
       last_login_id, first_at, last_at)
     VALUES ('shared_info', ?, ?, ?, 0, 0, NULL, ?, ?)`,
    client,
    window,
    count,
    window,
    window,
  );
}

describe('USR-2 利用の開始（POST /api/session）', () => {
  test('USR-2 設定で返った値で呼ぶと、現在の版の行が1つでき、属性付きの Set-Cookie が付き、GET が active: true', async () => {
    await withLedger(async (ledger, state) => {
      const admin = await adminToken(ledger);
      const k = await setSharedInfo(ledger, admin);

      const result = await send(ledger, startReq(k), { at: T10 + 1234 });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, data: {} });
      const token = userTokenOf(result);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.setCookie).toBe(`__Host-dxp_user=${token}; ${COOKIE_ATTRIBUTES}`);

      const [current] = rows(state, 'SELECT id FROM shared_infos ORDER BY id DESC LIMIT 1');
      const sessions = userSessions(state);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].shared_info_id).toBe(current.id);
      // 記録の時刻は切り捨てない（TIM-7）
      expect(sessions[0].created_at).toBe(T10 + 1234);

      const status = await send(ledger, statusReq(token));
      expect(status.body).toEqual({ ok: true, data: { active: true } });
      expect(status.setCookie).toBe(`__Host-dxp_user=${token}; ${COOKIE_ATTRIBUTES}`);
    });
  });

  test.each([
    ['同じ値', (k) => ({ k })],
    ['違う値', () => ({ k: 'x'.repeat(43) })],
    ['形の違う値', () => ({ k: 'short' })],
    ['壊れた本文', () => '{'],
  ])('USR-2 有効な Cookie を持ったまま %s で送っても成功し、行も失敗も増えず、Set-Cookie は受け取った値', async (_, makeBody) => {
    await withLedger(async (ledger, state) => {
      const { k, user } = await setup(ledger);
      const sessions = userSessions(state);

      const result = await send(ledger, req('POST', '/api/session', { body: makeBody(k), cookie: user }));
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, data: {} });
      expect(result.setCookie).toBe(`__Host-dxp_user=${user}; ${COOKIE_ATTRIBUTES}`);
      expect(userSessions(state)).toEqual(sessions);
      expect(failures(state)).toHaveLength(0);
    });
  });

  test('USR-2 未設定の台帳では AUTH_SHARED_INFO_UNSET（401）で、失敗の行ができない', async () => {
    await withLedger(async (ledger, state) => {
      const result = await send(ledger, startReq('x'.repeat(43)));
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_SHARED_INFO_UNSET');
      expect(result.setCookie).toBeNull();
      expect(rows(state, 'SELECT * FROM auth_failures')).toHaveLength(0);
      expect(userSessions(state)).toHaveLength(0);
    });
  });
});

describe('ADM-3 共有された情報の変更と利用者の証明', () => {
  test('ADM-3 設定し直すと、前の版の証明は GET で active: false, AUTH_REVOKED、利用者の API で AUTH_REVOKED。Set-Cookie は付かない', async () => {
    await withLedger(async (ledger) => {
      const { admin, user } = await setup(ledger);
      await setSharedInfo(ledger, admin);

      const status = await send(ledger, statusReq(user));
      expect(status.body).toEqual({ ok: true, data: { active: false, reason: 'AUTH_REVOKED' } });
      expect(status.setCookie).toBeNull();

      const api = await send(ledger, userApiReq(user));
      expect(codeOf(api)).toBe('AUTH_REVOKED');
      expect(api.setCookie).toBeNull();
    });
  });

  test('ADM-3 設定し直した後、前の値は AUTH_SHARED_INFO_WRONG、新しい値なら新しい行ができ前の行は残る。管理者の証明は止まらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, k: oldK, user } = await setup(ledger);
      const newK = await setSharedInfo(ledger, admin);

      expect(codeOf(await send(ledger, startReq(oldK)))).toBe('AUTH_SHARED_INFO_WRONG');

      // 止められた証明はないものと同じに扱い、新しい行を足して Cookie を上書きする（api.md 8.11）
      const result = await send(ledger, startReq(newK, { cookie: user }));
      expect(result.status).toBe(200);
      const newUser = userTokenOf(result);
      expect(newUser).not.toBe(user);

      const sessions = userSessions(state);
      const versions = rows(state, 'SELECT id FROM shared_infos ORDER BY id').map((r) => r.id);
      expect(sessions.map((s) => s.shared_info_id)).toEqual(versions);
      expect((await send(ledger, statusReq(newUser))).body.data).toEqual({ active: true });
      expect((await send(ledger, req('GET', '/api/admin/me', { admin }))).status).toBe(200);
    });
  });
});

describe('USR-2 利用者の証明（api.md 8.12・8.13）', () => {
  test.each([
    ['Cookie がない', () => undefined],
    ['形が違う（42文字）', () => 'a'.repeat(42)],
    ['表にない値', () => 'a'.repeat(43)],
  ])('USR-2 %s と、GET は active: false, AUTH_REQUIRED、利用者の API は AUTH_REQUIRED', async (_, makeCookie) => {
    await withLedger(async (ledger) => {
      await setup(ledger);
      const cookie = makeCookie();

      const status = await send(ledger, statusReq(cookie));
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ ok: true, data: { active: false, reason: 'AUTH_REQUIRED' } });
      expect(status.setCookie).toBeNull();

      const api = await send(ledger, userApiReq(cookie));
      expect(codeOf(api)).toBe('AUTH_REQUIRED');
      expect(api.setCookie).toBeNull();
    });
  });

  test('USR-2 未設定の台帳では GET の reason は AUTH_REQUIRED', async () => {
    await withLedger(async (ledger) => {
      expect((await send(ledger, statusReq(undefined))).body.data).toEqual({ active: false, reason: 'AUTH_REQUIRED' });
    });
  });

  test('USR-2 共3 を通った利用者の API の応答には、成功でも後の段で断っても、同じ値の Set-Cookie が付く', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      const expected = `__Host-dxp_user=${user}; ${COOKIE_ATTRIBUTES}`;

      const passed = await send(ledger, userApiReq(user));
      expect(passed.body).toEqual({ ok: true, data: { passed: true } });
      expect(passed.setCookie).toBe(expected);

      const refused = await send(ledger, userApiReq(user, { body: { fail: true } }));
      expect(codeOf(refused)).toBe('RULE_TEST');
      expect(refused.setCookie).toBe(expected);

      const broken = await send(ledger, userApiReq(user, { body: '{' }));
      expect(codeOf(broken)).toBe('INPUT_BODY');
      expect(broken.setCookie).toBe(expected);
    });
  });

  test('API 本文が壊れていて利用者の証明もないと AUTH_REQUIRED（認証が先）', async () => {
    await withLedger(async (ledger) => {
      await setup(ledger);
      expect(codeOf(await send(ledger, userApiReq(undefined, { body: '{' })))).toBe('AUTH_REQUIRED');
    });
  });
});

describe('ADM-1 利用者と管理者の証明を分ける', () => {
  test('ADM-1 利用者の API は管理者の Cookie だけでは AUTH_REQUIRED、管理者の API は利用者の Cookie だけでは AUTH_REQUIRED', async () => {
    await withLedger(async (ledger) => {
      const { admin, user } = await setup(ledger);
      expect(codeOf(await send(ledger, userApiReq(undefined, { admin })))).toBe('AUTH_REQUIRED');
      expect((await send(ledger, req('GET', '/api/session', { admin }))).body.data).toEqual({
        active: false,
        reason: 'AUTH_REQUIRED',
      });
      expect(codeOf(await send(ledger, req('GET', '/api/admin/me', { cookie: user })))).toBe('AUTH_REQUIRED');
    });
  });
});

describe('SEC-3 利用の開始の試行の上限', () => {
  test.each([
    ['値が違う', 'x'.repeat(43)],
    ['形が違う', 'short'],
    ['空の文字列', ''],
  ])('SEC-3 %s と AUTH_SHARED_INFO_WRONG で、shared_info の失敗が1増える', async (_, k) => {
    await withLedger(async (ledger, state) => {
      await setup(ledger);
      const result = await send(ledger, startReq(k), { at: T10 + 1234 });
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_SHARED_INFO_WRONG');
      expect(result.setCookie).toBeNull();

      expect(failures(state)).toHaveLength(1);
      expect(failures(state)[0]).toMatchObject({
        client: IP,
        window_start: T10,
        failures: 1,
        unknown_id_failures: 0,
        wrong_password_failures: 0,
        last_login_id: null,
        first_at: T10 + 1234,
        last_at: T10 + 1234,
      });
      expect(codeOf(await send(ledger, startReq(k)))).toBe('AUTH_SHARED_INFO_WRONG');
      expect(failures(state)[0].failures).toBe(2);
    });
  });

  test.each([
    ['本文が壊れている', { body: '{' }, 'INPUT_BODY'],
    ['k がない', { body: {} }, 'INPUT_BODY'],
    ['k が文字列でない', { body: { k: 123 } }, 'INPUT_BODY'],
    ['Origin がない', { body: { k: 'x'.repeat(43) }, origin: null }, 'AUTH_ORIGIN'],
  ])('SEC-3 %s ときは %s で、失敗が増えない', async (_, options, code) => {
    await withLedger(async (ledger, state) => {
      await setup(ledger);
      expect(codeOf(await send(ledger, req('POST', '/api/session', options)))).toBe(code);
      expect(failures(state)).toHaveLength(0);
    });
  });

  test('SEC-3 200回失敗した後は、正しい値でも、本文が壊れていても LIMIT_ATTEMPTS（429）で、行が変わらない。次の10分の区切りでは通る', async () => {
    await withLedger(async (ledger, state) => {
      const { k } = await setup(ledger);
      insertFailures(state, 200);
      const before = failures(state);

      const limited = await send(ledger, startReq(k));
      expect(limited.status).toBe(429);
      expect(codeOf(limited)).toBe('LIMIT_ATTEMPTS');
      expect(codeOf(await send(ledger, req('POST', '/api/session', { body: '{' })))).toBe('LIMIT_ATTEMPTS');
      expect(codeOf(await send(ledger, startReq('x'.repeat(43))))).toBe('LIMIT_ATTEMPTS');
      expect(failures(state)).toEqual(before);

      expect((await send(ledger, startReq(k), { at: T10 + 10 * MIN })).status).toBe(200);
    });
  });

  test('SEC-3 199回の失敗までは正しい値が通る', async () => {
    await withLedger(async (ledger, state) => {
      const { k } = await setup(ledger);
      insertFailures(state, 199);
      expect((await send(ledger, startReq(k))).status).toBe(200);
    });
  });

  test('SEC-3 上限に達しても、別の IP と、IPv6 の別の /64 は止まらない', async () => {
    await withLedger(async (ledger, state) => {
      const { k } = await setup(ledger);
      insertFailures(state, 200);
      insertFailures(state, 200, { client: '2001:0db8:0000:0001::/64' });

      expect((await send(ledger, startReq(k, { ip: '192.0.2.2' }))).status).toBe(200);
      expect(codeOf(await send(ledger, startReq(k, { ip: '2001:db8:0:1::5' })))).toBe('LIMIT_ATTEMPTS');
      expect((await send(ledger, startReq(k, { ip: '2001:db8:0:2::5' }))).status).toBe(200);
    });
  });

  test('SEC-3 上限に達した相手からでも、有効な証明を持つ端末の POST は成功する', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      insertFailures(state, 200);
      const result = await send(ledger, startReq('x'.repeat(43), { cookie: user }));
      expect(result.status).toBe(200);
      expect(result.setCookie).toBe(`__Host-dxp_user=${user}; ${COOKIE_ATTRIBUTES}`);
    });
  });
});

describe('RSV-23 同時の利用の開始', () => {
  test('RSV-23 199回失敗した相手から違う値を2つ同時に送ると、1つ目で上限に達し、2つ目は LIMIT_ATTEMPTS', async () => {
    await withLedger(async (ledger, state) => {
      await setup(ledger);
      insertFailures(state, 199);
      const results = await Promise.all([
        send(ledger, startReq('x'.repeat(43))),
        send(ledger, startReq('y'.repeat(43))),
      ]);
      expect(results.map(codeOf).sort()).toEqual(['AUTH_SHARED_INFO_WRONG', 'LIMIT_ATTEMPTS']);
      expect(failures(state)[0].failures).toBe(200);
    });
  });
});

describe('SEC-4 利用の開始で例外が起きたとき', () => {
  afterEach(() => vi.restoreAllMocks());

  test('SEC-4 証明の行を足すところで例外が起きると 500 で、console.error に送った値が出ず、行も増えない', async () => {
    await withLedger(async (ledger, state) => {
      const admin = await adminToken(ledger);
      const k = await setSharedInfo(ledger, admin);
      state.storage.sql.exec('ALTER TABLE user_sessions RENAME TO user_sessions_moved');
      const errors = [];
      vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')));

      const result = await send(ledger, startReq(k));
      expect(result.status).toBe(500);
      expect(result.body).toEqual({ ok: false });
      expect(result.setCookie).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
      // 送った値・新しい証明の値はどちらも43文字の base64url。出力にその形の並びがない
      for (const line of errors) {
        expect(line).not.toContain(k);
        expect(line).not.toMatch(/[A-Za-z0-9_-]{43}/);
      }
      expect(rows(state, 'SELECT * FROM user_sessions_moved')).toHaveLength(0);
    });
  });
});

describe('LOG-4 利用の開始の記録', () => {
  test('LOG-4 成功しても events に行ができない。どの表にも共有された情報の値・証明の値が入らず、token_hash は証明の値の SHA-256', async () => {
    await withLedger(async (ledger, state) => {
      const admin = await adminToken(ledger);
      const k = await setSharedInfo(ledger, admin);
      // 失敗の行も作っておく
      await send(ledger, startReq('x'.repeat(43)));
      const eventCount = rows(state, 'SELECT * FROM events').length;

      const result = await send(ledger, startReq(k));
      const user = userTokenOf(result);
      expect(rows(state, 'SELECT * FROM events')).toHaveLength(eventCount);

      const [session] = userSessions(state);
      expect(hex(session.token_hash)).toBe(hex(await sha256(user)));

      const dump = JSON.stringify([
        rows(state, 'SELECT * FROM events'),
        failures(state),
        userSessions(state).map((s) => ({ ...s, token_hash: hex(s.token_hash) })),
      ]);
      for (const secret of [k, user, hex(await sha256(k))]) expect(dump).not.toContain(secret);
    });
  });
});

describe('RSV-21 利用の開始と自動の変化', () => {
  const AT = T10 + 30 * MIN;
  const statuses = (state) => rows(state, 'SELECT status FROM reservations ORDER BY id').map((r) => r.status);
  const addDue = (state) => insertReservation(state, { startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });

  test('RSV-21 失敗と active: false では変わらず、利用の開始の成功・有効な証明での POST・active: true の GET で無断不使用になる', async () => {
    await withLedger(async (ledger, state) => {
      const admin = await adminToken(ledger);
      const k = await setSharedInfo(ledger, admin);
      seedDeviceAndUser(state);

      addDue(state);
      expect(codeOf(await send(ledger, startReq('x'.repeat(43)), { at: AT }))).toBe('AUTH_SHARED_INFO_WRONG');
      expect((await send(ledger, statusReq(undefined), { at: AT })).body.data.active).toBe(false);
      expect(statuses(state)).toEqual(['reserved']);

      const started = await send(ledger, startReq(k), { at: AT });
      expect(started.status).toBe(200);
      expect(statuses(state)).toEqual(['no_show']);
      const user = userTokenOf(started);

      addDue(state);
      expect((await send(ledger, startReq(k, { cookie: user }), { at: AT })).status).toBe(200);
      expect(statuses(state)).toEqual(['no_show', 'no_show']);

      addDue(state);
      expect((await send(ledger, statusReq(user), { at: AT })).body.data.active).toBe(true);
      expect(statuses(state)).toEqual(['no_show', 'no_show', 'no_show']);
    });
  });
});

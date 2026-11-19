// 管理者の認証（api.md 8.4〜8.8）と、保守用の API から回した観点（api.md 7 の「順」、8.3 の2行目）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, seedDeviceAndUser, withLedger } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';
const IP = '192.0.2.1';
const COOKIE_ATTRIBUTES = 'Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict';

// 速い計算の関数に差し替え、呼ばれた回数を数える（api.md 8.8「PBKDF2 が1回呼ばれる」）。
// 保守用の API の作成も同じ関数で計算するので、認証で結果が一致する
function countingRoutes({ delay = 0 } = {}) {
  const derive = async (password, salt) => {
    derive.calls += 1;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return sha256(`${password}:${[...salt].join(',')}`);
  };
  derive.calls = 0;
  return { routes: buildRoutes({ derivePassword: derive }), derive };
}

function maint(path, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.MAINT_KEY}`, 'CF-Connecting-IP': IP },
    body: JSON.stringify(body),
  });
}

// 管理者の画面からの要求。既定は同じサイトの Origin
function adminRequest(method, path, { body, cookie, ip = IP, origin = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (cookie !== undefined) headers.Cookie = `__Host-dxp_admin=${cookie}`;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const loginReq = (loginId, password = PASSWORD, options = {}) =>
  adminRequest('POST', '/api/admin/login', { body: { login_id: loginId, password }, ...options });
const meReq = (cookie) => adminRequest('GET', '/api/admin/me', { cookie });
const logoutReq = (cookie, options = {}) => adminRequest('POST', '/api/admin/logout', { body: {}, cookie, ...options });

async function send(ledger, req, { at = T10, routes } = {}) {
  const response = await ledger.handle(req, fixedClock(at), routes);
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('Set-Cookie') };
}

const codeOf = (result) => result.body.error?.code;

// Set-Cookie から証明の値を取り出す
function tokenOf(result) {
  return /^__Host-dxp_admin=([^;]*);/.exec(result.setCookie)[1];
}

async function createAdmin(ledger, routes, loginId, displayName = '田中 太郎') {
  const result = await send(ledger, maint('/api/maint/admins', { login_id: loginId, display_name: displayName, password: PASSWORD }), {
    routes,
  });
  expect(result.status).toBe(200);
  return result.body.data;
}

async function loginToken(ledger, routes, loginId, options) {
  const result = await send(ledger, loginReq(loginId), { routes, ...options });
  expect(result.status).toBe(200);
  return tokenOf(result);
}

function loginFailures(state) {
  return rows(state, "SELECT * FROM auth_failures WHERE entry = 'admin_login' ORDER BY id");
}

describe('ADM-2 管理者の認証（POST /api/admin/login）', () => {
  test('ADM-2 作った管理者で認証すると証明の行ができ、Set-Cookie が付き、その Cookie で me が通る', async () => {
    await withLedger(async (ledger, state) => {
      // 本番と同じ経路の表（本物の PBKDF2）
      await send(ledger, maint('/api/maint/admins', { login_id: 'tanaka', display_name: '田中 太郎', password: PASSWORD }));
      const result = await send(ledger, loginReq('tanaka'), { at: T10 + 5_123 });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, data: { id: 1, login_id: 'tanaka', display_name: '田中 太郎' } });

      const token = tokenOf(result);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.setCookie).toBe(`__Host-dxp_admin=${token}; ${COOKIE_ATTRIBUTES}`);

      const [session] = rows(state, 'SELECT * FROM admin_sessions');
      expect(session).toMatchObject({ id: 1, admin_id: 1, password_version: 1, created_at: T10 + 5_123, ended_at: null });
      expect(new Uint8Array(session.token_hash)).toEqual(await sha256(token));

      const me = await send(ledger, meReq(token));
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ ok: true, data: { id: 1, login_id: 'tanaka', display_name: '田中 太郎' } });
    });
  });

  test('ADM-2 証明の版は管理者の現在の版', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      state.storage.sql.exec('UPDATE admins SET password_version = 3');
      await loginToken(ledger, routes, 'tanaka');
      expect(rows(state, 'SELECT password_version FROM admin_sessions')).toEqual([{ password_version: 3 }]);
    });
  });

  test.each([['TANAKA'], ['ＴＡＮＡＫＡ']])('ADM-2 %s で認証しても通る', async (loginId) => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const result = await send(ledger, loginReq(loginId), { routes });
      expect(result.status).toBe(200);
      expect(result.body.data.login_id).toBe('tanaka');
    });
  });

  test.each([
    ['ID がない', 'suzuki', PASSWORD],
    ['ID の形式に合わない', '1-bad', PASSWORD],
    ['パスワードが違う', 'tanaka', 'Wrong-Horse-Battery-01'],
    ['パスワードの大文字・小文字が違う', 'tanaka', PASSWORD.toLowerCase()],
    ['パスワードが14文字', 'tanaka', 'Correct-Horse-'],
    ['パスワードに空白が入る', 'tanaka', 'Correct Horse Battery 01'],
  ])('ADM-2 %s ときは AUTH_ADMIN_FAILED（401）で、応答の本文が同じ', async (_, loginId, password) => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const result = await send(ledger, loginReq(loginId, password), { routes });
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ ok: false, error: { code: 'AUTH_ADMIN_FAILED' } });
      expect(result.setCookie).toBeNull();
      expect(rows(state, 'SELECT id FROM admin_sessions')).toHaveLength(0);
    });
  });

  test('ADM-2 削除した管理者は正しいパスワードでも AUTH_ADMIN_FAILED（unknown_id に数える）', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      state.storage.sql.exec('UPDATE admins SET deleted_at = 1');
      expect(codeOf(await send(ledger, loginReq('tanaka'), { routes }))).toBe('AUTH_ADMIN_FAILED');
      expect(loginFailures(state)[0]).toMatchObject({ unknown_id_failures: 1, wrong_password_failures: 0 });
    });
  });

  test('ADM-2 ID がない・形式に合わない・削除したときも、ある ID と同じく PBKDF2 が1回呼ばれる', async () => {
    await withLedger(async (ledger, state) => {
      const { routes, derive } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      await createAdmin(ledger, routes, 'sato');
      state.storage.sql.exec("UPDATE admins SET deleted_at = 1 WHERE login_id = 'sato'");
      for (const loginId of ['tanaka', 'suzuki', '1-bad', 'sato']) {
        derive.calls = 0;
        await send(ledger, loginReq(loginId, 'Wrong-Horse-Battery-01'), { routes });
        expect(derive.calls).toBe(1);
      }
    });
  });

  test('ADM-2 INPUT_BODY・LIMIT_ATTEMPTS・AUTH_ORIGIN では PBKDF2 が呼ばれない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes, derive } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      derive.calls = 0;

      expect(codeOf(await send(ledger, adminRequest('POST', '/api/admin/login', { body: '{' }), { routes }))).toBe(
        'INPUT_BODY',
      );
      expect(codeOf(await send(ledger, loginReq('tanaka', PASSWORD, { origin: null }), { routes }))).toBe('AUTH_ORIGIN');
      state.storage.sql.exec(
        `INSERT INTO auth_failures (entry, client, window_start, failures, unknown_id_failures, wrong_password_failures,
           last_login_id, first_at, last_at)
         VALUES ('admin_login', ?, ?, 10, 0, 10, 'tanaka', ?, ?)`,
        IP,
        T10,
        T10,
        T10,
      );
      expect(codeOf(await send(ledger, loginReq('tanaka'), { routes }))).toBe('LIMIT_ATTEMPTS');
      expect(derive.calls).toBe(0);
    });
  });

  test('ADM-2 有効な Cookie を持ったまま認証しても、新しい証明ができ、古い証明も残る', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const first = await loginToken(ledger, routes, 'tanaka');
      const result = await send(ledger, loginReq('tanaka', PASSWORD, { cookie: first }), { routes });
      expect(result.status).toBe(200);
      expect(tokenOf(result)).not.toBe(first);
      expect(rows(state, 'SELECT id FROM admin_sessions')).toHaveLength(2);
      expect((await send(ledger, meReq(first), { routes })).status).toBe(200);
    });
  });
});

describe('ADM-2 管理者の証明（api.md 8.5）', () => {
  test.each([
    ['Cookie がない', undefined],
    ['形が違う（42文字）', 'a'.repeat(42)],
    ['表にない値', 'a'.repeat(43)],
  ])('ADM-2 %s ときは AUTH_REQUIRED で、Set-Cookie が付かない', async (_, cookie) => {
    await withLedger(async (ledger) => {
      const result = await send(ledger, meReq(cookie));
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_REQUIRED');
      expect(result.setCookie).toBeNull();
    });
  });

  test('ADM-2 保守用の API でパスワードを設定し直すと、その管理者のすべての証明が AUTH_REVOKED。ほかの管理者は止まらない', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      await createAdmin(ledger, routes, 'sato');
      const a1 = await loginToken(ledger, routes, 'tanaka');
      const a2 = await loginToken(ledger, routes, 'tanaka');
      const b = await loginToken(ledger, routes, 'sato');

      const reset = await send(ledger, maint('/api/maint/admins/1/reset-password', { password: 'Another-Password-0002' }), {
        routes,
      });
      expect(reset.status).toBe(200);

      for (const token of [a1, a2]) {
        const result = await send(ledger, meReq(token), { routes });
        expect(codeOf(result)).toBe('AUTH_REVOKED');
        expect(result.setCookie).toBeNull();
      }
      expect((await send(ledger, meReq(b), { routes })).status).toBe(200);
    });
  });

  test('ADM-2 deleted_at をテストが入れても AUTH_REVOKED。ほかの管理者は止まらない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      await createAdmin(ledger, routes, 'sato');
      const a = await loginToken(ledger, routes, 'tanaka');
      const b = await loginToken(ledger, routes, 'sato');
      state.storage.sql.exec("UPDATE admins SET deleted_at = 1 WHERE login_id = 'tanaka'");
      expect(codeOf(await send(ledger, meReq(a), { routes }))).toBe('AUTH_REVOKED');
      expect((await send(ledger, meReq(b), { routes })).status).toBe(200);
    });
  });

  test('ADM-2 共3 を通った応答には同じ値の Set-Cookie が付く（後の段で断るときも）', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const token = await loginToken(ledger, routes, 'tanaka');
      const expected = `__Host-dxp_admin=${token}; ${COOKIE_ATTRIBUTES}`;

      expect((await send(ledger, meReq(token), { routes })).setCookie).toBe(expected);
      // 共4 で断る応答（認証の後）
      const broken = await send(ledger, adminRequest('POST', '/api/admin/logout', { body: '{', cookie: token }), { routes });
      expect(codeOf(broken)).toBe('INPUT_BODY');
      expect(broken.setCookie).toBe(expected);
    });
  });

  test('API 本文が壊れていて証明もないときは AUTH_REQUIRED（認証が先。api.md 7）', async () => {
    await withLedger(async (ledger) => {
      const result = await send(ledger, adminRequest('POST', '/api/admin/logout', { body: '{' }));
      expect(codeOf(result)).toBe('AUTH_REQUIRED');
    });
  });
});

describe('ADM-2 認証を解く（POST /api/admin/logout）', () => {
  test('ADM-2 logout の後、同じ値で me を呼ぶと AUTH_REVOKED。Max-Age=0 の Set-Cookie が付き、ほかの証明は止まらない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const a = await loginToken(ledger, routes, 'tanaka');
      const other = await loginToken(ledger, routes, 'tanaka');

      const result = await send(ledger, logoutReq(a), { at: T10 + MIN, routes });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, data: {} });
      expect(result.setCookie).toBe(`__Host-dxp_admin=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`);
      expect(rows(state, 'SELECT ended_at FROM admin_sessions ORDER BY id')).toEqual([{ ended_at: T10 + MIN }, { ended_at: null }]);

      expect(codeOf(await send(ledger, meReq(a), { routes }))).toBe('AUTH_REVOKED');
      expect(codeOf(await send(ledger, logoutReq(a), { routes }))).toBe('AUTH_REVOKED');
      expect((await send(ledger, meReq(other), { routes })).status).toBe(200);
    });
  });
});

describe('SEC-3 管理者の認証の失敗と試行の上限', () => {
  test('SEC-3 失敗すると admin_login の行が増え、理由ごとの列と last_login_id が書かれる', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');

      await send(ledger, loginReq('ＳＵＺＵＫＩ'), { at: T10 + 1_234, routes });
      expect(loginFailures(state)).toEqual([
        {
          id: 1,
          entry: 'admin_login',
          client: IP,
          window_start: T10,
          failures: 1,
          unknown_id_failures: 1,
          wrong_password_failures: 0,
          last_login_id: 'suzuki',
          first_at: T10 + 1_234,
          last_at: T10 + 1_234,
        },
      ]);

      await send(ledger, loginReq('tanaka', 'Wrong-Horse-Battery-01'), { at: T10 + 2_000, routes });
      expect(loginFailures(state)[0]).toMatchObject({
        failures: 2,
        unknown_id_failures: 1,
        wrong_password_failures: 1,
        last_login_id: 'tanaka',
        last_at: T10 + 2_000,
      });

      // ID の欄にパスワードを打ち間違えたような、形式に合わない値は残さない（SEC-4）
      await send(ledger, loginReq('Correct+Horse+Battery!01'), { routes });
      expect(loginFailures(state)[0]).toMatchObject({ failures: 3, unknown_id_failures: 2, last_login_id: '(invalid)' });
    });
  });

  test('SEC-3 10回失敗した後は正しい値でも LIMIT_ATTEMPTS（429）で、行が変わらない。別の IP と次の区切りは通る', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      for (let i = 0; i < 10; i++) {
        expect(codeOf(await send(ledger, loginReq('tanaka', 'Wrong-Horse-Battery-01'), { routes }))).toBe('AUTH_ADMIN_FAILED');
      }
      const before = loginFailures(state);
      expect(before[0].failures).toBe(10);

      const limited = await send(ledger, loginReq('tanaka'), { at: T10 + 9 * MIN, routes });
      expect(limited.status).toBe(429);
      expect(codeOf(limited)).toBe('LIMIT_ATTEMPTS');
      expect(loginFailures(state)).toEqual(before);

      expect((await send(ledger, loginReq('tanaka', PASSWORD, { ip: '192.0.2.2' }), { routes })).status).toBe(200);
      expect((await send(ledger, loginReq('tanaka'), { at: T10 + 10 * MIN, routes })).status).toBe(200);
    });
  });

  test('SEC-3 成功しても失敗の数は戻らない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      await send(ledger, loginReq('tanaka', 'Wrong-Horse-Battery-01'), { routes });
      await loginToken(ledger, routes, 'tanaka');
      expect(loginFailures(state)[0].failures).toBe(1);
    });
  });

  test('SEC-3 上限を超えた相手には本文が壊れていても LIMIT_ATTEMPTS。上限の前なら INPUT_BODY で、失敗は増えない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      const broken = () => adminRequest('POST', '/api/admin/login', { body: '{' });
      const missing = () => adminRequest('POST', '/api/admin/login', { body: { login_id: 'tanaka' } });

      expect(codeOf(await send(ledger, broken(), { routes }))).toBe('INPUT_BODY');
      expect(codeOf(await send(ledger, missing(), { routes }))).toBe('INPUT_BODY');
      expect(loginFailures(state)).toHaveLength(0);

      for (let i = 0; i < 10; i++) await send(ledger, loginReq('suzuki'), { routes });
      expect(codeOf(await send(ledger, broken(), { routes }))).toBe('LIMIT_ATTEMPTS');
    });
  });

  test('SEC-3 login・logout で Origin がない、違うと AUTH_ORIGIN。me（GET）は確かめない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const token = await loginToken(ledger, routes, 'tanaka');

      expect(codeOf(await send(ledger, loginReq('tanaka', PASSWORD, { origin: null }), { routes }))).toBe('AUTH_ORIGIN');
      expect(codeOf(await send(ledger, loginReq('tanaka', PASSWORD, { origin: 'https://evil.example' }), { routes }))).toBe(
        'AUTH_ORIGIN',
      );
      expect(codeOf(await send(ledger, logoutReq(token, { origin: null }), { routes }))).toBe('AUTH_ORIGIN');
      expect(loginFailures(state)).toHaveLength(0);
      expect(rows(state, 'SELECT ended_at FROM admin_sessions')).toEqual([{ ended_at: null }]);

      const me = adminRequest('GET', '/api/admin/me', { cookie: token, origin: null });
      expect((await send(ledger, me, { routes })).status).toBe(200);
    });
  });
});

describe('RSV-23 同時の認証', () => {
  test('RSV-23 9回失敗した相手から2つ同時に送ると、1つ目の失敗で上限に達し、2つ目は LIMIT_ATTEMPTS', async () => {
    await withLedger(async (ledger, state) => {
      // 計算の間に割り込みが起きうるよう、計算に時間をかける
      const { routes } = countingRoutes({ delay: 20 });
      await createAdmin(ledger, routes, 'tanaka');
      for (let i = 0; i < 9; i++) await send(ledger, loginReq('suzuki'), { routes });

      const results = await Promise.all([
        send(ledger, loginReq('suzuki'), { routes }),
        send(ledger, loginReq('tanaka'), { routes }),
      ]);
      expect(results.map(codeOf)).toEqual(['AUTH_ADMIN_FAILED', 'LIMIT_ATTEMPTS']);
      expect(loginFailures(state)[0].failures).toBe(10);
    });
  });
});

describe('LOG-4 管理者の認証の記録', () => {
  test('LOG-4 login で admin_login、logout で admin_logout が actor_admin_id 付きででき、detail は ip だけ', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const ipv6 = '2001:db8:1:2:3:4:5:6';
      const token = await loginToken(ledger, routes, 'tanaka', {});
      await send(ledger, logoutReq(token, { ip: ipv6 }), { at: T10 + MIN, routes });

      const events = rows(state, "SELECT * FROM events WHERE kind IN ('admin_login', 'admin_logout') ORDER BY id");
      expect(events.map((e) => ({ ...e, detail: JSON.parse(e.detail) }))).toEqual([
        {
          id: 2,
          at: T10,
          actor_kind: 'admin',
          actor_admin_id: 1,
          kind: 'admin_login',
          reservation_id: null,
          device_id: null,
          user_id: null,
          admin_id: 1,
          detail: { ip: IP },
        },
        {
          id: 3,
          at: T10 + MIN,
          actor_kind: 'admin',
          actor_admin_id: 1,
          kind: 'admin_logout',
          reservation_id: null,
          device_id: null,
          user_id: null,
          admin_id: 1,
          // IPv6 を /64 にまとめない
          detail: { ip: ipv6 },
        },
      ]);
    });
  });

  test('LOG-4 CF-Connecting-IP がないときの ip は unknown', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const req = new Request(`${ORIGIN}/api/admin/login`, {
        method: 'POST',
        headers: { Origin: ORIGIN },
        body: JSON.stringify({ login_id: 'tanaka', password: PASSWORD }),
      });
      expect((await send(ledger, req, { routes })).status).toBe(200);
      expect(rows(state, "SELECT detail FROM events WHERE kind = 'admin_login'")).toEqual([{ detail: '{"ip":"unknown"}' }]);
    });
  });

  test('LOG-4 events・auth_failures のどの列にも、パスワード・証明の値・そのハッシュが入っていない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      const wrong = 'Wrong-Horse-Battery-01';
      await send(ledger, loginReq('tanaka', wrong), { routes });
      await send(ledger, loginReq(wrong), { routes });
      const token = await loginToken(ledger, routes, 'tanaka');
      await send(ledger, logoutReq(token), { routes });

      const tokenHashHex = [...(await sha256(token))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const dump = JSON.stringify([...rows(state, 'SELECT * FROM events'), ...rows(state, 'SELECT * FROM auth_failures')]);
      for (const secret of [PASSWORD, wrong, token, tokenHashHex]) expect(dump).not.toContain(secret);
      // BLOB の列がない（ハッシュを持たない）ことも確かめる
      for (const row of [...rows(state, 'SELECT * FROM events'), ...rows(state, 'SELECT * FROM auth_failures')]) {
        for (const value of Object.values(row)) expect(value instanceof ArrayBuffer).toBe(false);
      }
    });
  });
});

describe('RSV-21 管理者の認証と自動の変化', () => {
  test('RSV-21 認証の成功と me で無断不使用が反映される。認証の失敗では変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await createAdmin(ledger, routes, 'tanaka');
      seedDeviceAndUser(state);
      // 作成の時刻（T10）より後に猶予を過ぎる予約済
      insertReservation(state, { startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });
      insertReservation(state, { startAt: T10 + 20 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });
      const status = () => rows(state, 'SELECT status FROM reservations ORDER BY id').map((r) => r.status);

      await send(ledger, loginReq('tanaka', 'Wrong-Horse-Battery-01'), { at: T10 + 30 * MIN, routes });
      expect(status()).toEqual(['reserved', 'reserved']);

      const token = await loginToken(ledger, routes, 'tanaka', { at: T10 + 30 * MIN });
      expect(status()).toEqual(['no_show', 'reserved']);

      await send(ledger, meReq(token), { at: T10 + 40 * MIN, routes });
      expect(status()).toEqual(['no_show', 'no_show']);
    });
  });
});

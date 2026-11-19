// 保守用の API（api.md 6.1・8.1〜8.3）と、失敗の記録の上限（api.md 7）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { PBKDF2_ITERATIONS, equalBytes, pbkdf2, sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, seedDeviceAndUser, withLedger } from './helpers.js';

const KEY = env.MAINT_KEY;
const PASSWORD = 'Correct-Horse-Battery-01';
const IP = '192.0.2.1';

// 保守用の API の要求。既定は正しい鍵・Origin なし（curl と同じ）
function maint(path, body, { key = KEY, ip = IP, headers = {} } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers };
  if (key !== null) h.Authorization = `Bearer ${key}`;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const CREATE = '/api/maint/admins';
const reset = (id) => `/api/maint/admins/${id}/reset-password`;
const admin = (loginId, displayName = '田中 太郎') => ({ login_id: loginId, display_name: displayName, password: PASSWORD });

// 速い計算の関数に差し替え、呼ばれた回数を数える（api.md 8.3「PBKDF2 は、断る要求では呼ばれない」）
function countingRoutes() {
  const derive = async (password, salt) => {
    derive.calls += 1;
    return sha256(`${password}:${[...salt].join(',')}`);
  };
  derive.calls = 0;
  return { routes: buildRoutes({ derivePassword: derive }), derive };
}

async function send(ledger, req, { at = T10, routes } = {}) {
  const response = await ledger.handle(req, fixedClock(at), routes);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const codeOf = (result) => result.body.error?.code;

function failures(state) {
  return rows(state, 'SELECT * FROM auth_failures ORDER BY id');
}

function deleteAdmin(state, id) {
  state.storage.sql.exec('UPDATE admins SET deleted_at = 1 WHERE id = ?', id);
}

describe('ADM-2 管理者の作成（POST /api/maint/admins）', () => {
  test('ADM-2 作成すると admins に1行でき、応答の data がその値になる', async () => {
    await withLedger(async (ledger, state) => {
      // 本番と同じ経路の表（本物の PBKDF2）
      const result = await send(ledger, maint(CREATE, admin('ＴａｎａＫＡ', '  田中 太郎　')));
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, data: { id: 1, login_id: 'tanaka', display_name: '田中 太郎' } });

      const [row] = rows(state, 'SELECT * FROM admins');
      expect(row).toMatchObject({
        id: 1,
        login_id: 'tanaka',
        display_name: '田中 太郎',
        password_iterations: PBKDF2_ITERATIONS,
        password_version: 1,
        created_at: T10,
        deleted_at: null,
      });
      expect(row.password_salt.byteLength).toBe(16);
      const expected = await pbkdf2(PASSWORD, new Uint8Array(row.password_salt), PBKDF2_ITERATIONS);
      expect(equalBytes(row.password_hash, expected)).toBe(true);
    });
  });

  test.each([['tanaka'], ['ＴＡＮＡＫＡ']])('ADM-2 Tanaka で作った後に %s で作ると RULE_ADMIN_ID_DUPLICATE', async (second) => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      expect((await send(ledger, maint(CREATE, admin('Tanaka')), { routes })).status).toBe(200);
      const result = await send(ledger, maint(CREATE, admin(second)), { routes });
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_ADMIN_ID_DUPLICATE');
      expect(rows(state, 'SELECT id FROM admins')).toHaveLength(1);
    });
  });

  test('ADM-2 削除した管理者の ID でも RULE_ADMIN_ID_DUPLICATE', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      deleteAdmin(state, 1);
      expect(codeOf(await send(ledger, maint(CREATE, admin('tanaka')), { routes }))).toBe('RULE_ADMIN_ID_DUPLICATE');
    });
  });

  test.each([
    ['本文が JSON でない', '{'],
    ['項目がない', { login_id: 'tanaka', password: PASSWORD }],
    ['項目が文字列でない', { login_id: 'tanaka', display_name: 1, password: PASSWORD }],
  ])('ADM-2 %s ときは INPUT_BODY', async (_, body) => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      expect(codeOf(await send(ledger, maint(CREATE, body), { routes }))).toBe('INPUT_BODY');
    });
  });

  test('ADM-2 入力の形式は ID → 名前 → パスワードの順に確かめる', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      const bad = { login_id: '1', display_name: '', password: 'short' };
      expect(codeOf(await send(ledger, maint(CREATE, bad), { routes }))).toBe('INPUT_LOGIN_ID');
      expect(codeOf(await send(ledger, maint(CREATE, { ...bad, login_id: 'tanaka' }), { routes }))).toBe('INPUT_NAME');
      expect(
        codeOf(await send(ledger, maint(CREATE, { ...bad, login_id: 'tanaka', display_name: '田中' }), { routes })),
      ).toBe('INPUT_PASSWORD');
    });
  });
});

describe('ADM-2 パスワードの設定し直し（POST /api/maint/admins/{id}/reset-password）', () => {
  test('ADM-2 設定し直すと版が1増え、ハッシュとソルトが変わる', async () => {
    await withLedger(async (ledger, state) => {
      await send(ledger, maint(CREATE, admin('tanaka')));
      const [before] = rows(state, 'SELECT * FROM admins');

      const result = await send(ledger, maint(reset(1), { password: 'Another-Password-0002' }), { at: T10 + MIN });
      expect(result.body).toEqual({ ok: true, data: { id: 1, login_id: 'tanaka', display_name: '田中 太郎' } });

      const [after] = rows(state, 'SELECT * FROM admins');
      expect(after.password_version).toBe(2);
      expect(after.password_iterations).toBe(PBKDF2_ITERATIONS);
      expect(equalBytes(after.password_hash, before.password_hash)).toBe(false);
      expect(equalBytes(after.password_salt, before.password_salt)).toBe(false);
      const expected = await pbkdf2('Another-Password-0002', new Uint8Array(after.password_salt), PBKDF2_ITERATIONS);
      expect(equalBytes(after.password_hash, expected)).toBe(true);
      // 変えない列
      expect(after).toMatchObject({ login_id: 'tanaka', display_name: '田中 太郎', created_at: T10, deleted_at: null });
    });
  });

  test('ADM-2 ない番号、削除した管理者の番号は NOT_FOUND_ADMIN', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      const missing = await send(ledger, maint(reset(2), { password: PASSWORD }), { routes });
      expect(missing.status).toBe(404);
      expect(codeOf(missing)).toBe('NOT_FOUND_ADMIN');

      deleteAdmin(state, 1);
      expect(codeOf(await send(ledger, maint(reset(1), { password: PASSWORD }), { routes }))).toBe('NOT_FOUND_ADMIN');
    });
  });

  test.each([['0'], ['01'], ['abc']])('ADM-2 {id} が %s なら NOT_FOUND_API', async (id) => {
    await withLedger(async (ledger) => {
      expect(codeOf(await send(ledger, maint(reset(id), { password: PASSWORD })))).toBe('NOT_FOUND_API');
    });
  });

  test('ADM-2 入力の形式（INPUT_PASSWORD）は対象の存在（NOT_FOUND_ADMIN）より先', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      expect(codeOf(await send(ledger, maint(reset(9), { password: 'short' }), { routes }))).toBe('INPUT_PASSWORD');
      expect(codeOf(await send(ledger, maint(reset(9), {}), { routes }))).toBe('INPUT_BODY');
    });
  });
});

describe('ADM-2 保守用の鍵が未設定（AUTH_MAINT_DISABLED）', () => {
  test.each([
    ['ない', undefined],
    ['42文字', 'k'.repeat(42)],
  ])('ADM-2 MAINT_KEY が%sときは AUTH_MAINT_DISABLED で、auth_failures に行が増えない', async (_, value) => {
    await withLedger(async (ledger, state) => {
      const { routes, derive } = countingRoutes();
      ledger.env = { ...ledger.env, MAINT_KEY: value };
      const result = await send(ledger, maint(CREATE, admin('tanaka'), { key: value ?? 'x' }), { routes });
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_MAINT_DISABLED');
      expect(failures(state)).toHaveLength(0);
      expect(derive.calls).toBe(0);
    });
  });

  test('ADM-2 MAINT_KEY が43文字なら通る', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      const key = 'k'.repeat(43);
      ledger.env = { ...ledger.env, MAINT_KEY: key };
      expect((await send(ledger, maint(CREATE, admin('tanaka'), { key }), { routes })).status).toBe(200);
    });
  });
});

describe('SEC-3 保守用の鍵と試行の上限', () => {
  test.each([
    ['鍵が違う', { key: `${KEY.slice(0, -1)}X` }],
    ['ヘッダがない', { key: null }],
    ['Bearer が小文字', { key: null, headers: { Authorization: `bearer ${KEY}` } }],
    ['Bearer の後の空白が2つ', { key: null, headers: { Authorization: `Bearer  ${KEY}` } }],
    ['Basic の形', { key: null, headers: { Authorization: `Basic ${KEY}` } }],
  ])('SEC-3 %s ときは AUTH_MAINT_KEY_INVALID で、失敗が1増える', async (_, options) => {
    await withLedger(async (ledger, state) => {
      const { routes, derive } = countingRoutes();
      const at = T10 + 30_123; // 記録の時刻は秒を切り捨てない
      const result = await send(ledger, maint(CREATE, admin('tanaka'), options), { at, routes });
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_MAINT_KEY_INVALID');
      expect(failures(state)).toEqual([
        {
          id: 1,
          entry: 'maint',
          client: IP,
          window_start: T10,
          failures: 1,
          unknown_id_failures: 0,
          wrong_password_failures: 0,
          last_login_id: null,
          first_at: at,
          last_at: at,
        },
      ]);
      expect(derive.calls).toBe(0);
    });
  });

  test('SEC-3 5回失敗した後は、正しい鍵でも LIMIT_ATTEMPTS で、失敗の行は変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes, derive } = countingRoutes();
      const wrong = { key: 'w'.repeat(43) };
      for (let i = 0; i < 5; i++) {
        expect(codeOf(await send(ledger, maint(CREATE, admin('tanaka'), wrong), { at: T10 + i * MIN, routes }))).toBe(
          'AUTH_MAINT_KEY_INVALID',
        );
      }
      const before = failures(state);
      expect(before[0]).toMatchObject({ failures: 5, first_at: T10, last_at: T10 + 4 * MIN });

      const limited = await send(ledger, maint(CREATE, admin('tanaka')), { at: T10 + 9 * MIN, routes });
      expect(limited.status).toBe(429);
      expect(codeOf(limited)).toBe('LIMIT_ATTEMPTS');
      expect(codeOf(await send(ledger, maint(CREATE, admin('tanaka'), wrong), { at: T10 + 9 * MIN, routes }))).toBe(
        'LIMIT_ATTEMPTS',
      );
      expect(failures(state)).toEqual(before);
      expect(rows(state, 'SELECT id FROM admins')).toHaveLength(0);
      expect(derive.calls).toBe(0);

      // 別の IP は止まらない
      expect((await send(ledger, maint(CREATE, admin('tanaka'), { ip: '192.0.2.2' }), { at: T10 + 9 * MIN, routes })).status).toBe(200);
      // 次の10分の区切りでは通る
      expect((await send(ledger, maint(CREATE, admin('suzuki')), { at: T10 + 10 * MIN, routes })).status).toBe(200);
    });
  });

  test('SEC-3 IPv6 は /64 でまとめて数え、別の /64 は止まらない', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      const wrong = (ip) => ({ key: 'w'.repeat(43), ip });
      for (let i = 0; i < 5; i++) {
        await send(ledger, maint(CREATE, admin('tanaka'), wrong(`2001:db8:1:2::${i + 1}`)), { routes });
      }
      expect(codeOf(await send(ledger, maint(CREATE, admin('tanaka'), { ip: '2001:db8:1:2::99' }), { routes }))).toBe(
        'LIMIT_ATTEMPTS',
      );
      expect((await send(ledger, maint(CREATE, admin('tanaka'), { ip: '2001:db8:1:3::1' }), { routes })).status).toBe(200);
    });
  });

  test('SEC-3 鍵が通った後の誤り（INPUT_*、NOT_FOUND_ADMIN、RULE_ADMIN_ID_DUPLICATE）では失敗が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      const results = [
        await send(ledger, maint(CREATE, '{'), { routes }),
        await send(ledger, maint(CREATE, { ...admin('tanaka'), login_id: '1' }), { routes }),
        await send(ledger, maint(CREATE, admin('tanaka')), { routes }),
        await send(ledger, maint(reset(5), { password: PASSWORD }), { routes }),
      ];
      expect(results.map(codeOf)).toEqual(['INPUT_BODY', 'INPUT_LOGIN_ID', 'RULE_ADMIN_ID_DUPLICATE', 'NOT_FOUND_ADMIN']);
      expect(failures(state)).toHaveLength(0);
    });
  });

  test('SEC-3 本文が壊れていて鍵も違うときは AUTH_MAINT_KEY_INVALID（鍵が先）', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      expect(codeOf(await send(ledger, maint(CREATE, '{', { key: 'w'.repeat(43) }), { routes }))).toBe(
        'AUTH_MAINT_KEY_INVALID',
      );
    });
  });

  test('SEC-3 Origin がなくても、違っても断らない', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      expect((await send(ledger, maint(CREATE, admin('tanaka')), { routes })).status).toBe(200);
      const other = maint(CREATE, admin('suzuki'), { headers: { Origin: 'https://evil.example' } });
      expect((await send(ledger, other, { routes })).status).toBe(200);
    });
  });
});

describe('RSV-23 同時の作成', () => {
  test('RSV-23 同じ ID の作成を2つ同時に送ると、片方が成功し、もう片方が RULE_ADMIN_ID_DUPLICATE', async () => {
    await withLedger(async (ledger, state) => {
      // 計算の間に割り込みが起きうるよう、計算に時間をかける
      const derive = async (password, salt) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return sha256(`${password}:${[...salt].join(',')}`);
      };
      const routes = buildRoutes({ derivePassword: derive });
      const results = await Promise.all([
        send(ledger, maint(CREATE, admin('tanaka')), { routes }),
        send(ledger, maint(CREATE, admin('TANAKA')), { routes }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.map(codeOf).filter(Boolean)).toEqual(['RULE_ADMIN_ID_DUPLICATE']);
      expect(rows(state, 'SELECT id FROM admins')).toHaveLength(1);
    });
  });
});

describe('LOG-4 保守用の API の記録', () => {
  test('LOG-4 成功すると actor_kind = maint の行が1つでき、detail は login_id・display_name だけ', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await send(ledger, maint(CREATE, admin('tanaka')), { at: T10 + 30_123, routes });
      await send(ledger, maint(reset(1), { password: 'Another-Password-0002' }), { at: T10 + MIN, routes });

      const events = rows(state, 'SELECT * FROM events ORDER BY id');
      expect(events.map((e) => ({ ...e, detail: JSON.parse(e.detail) }))).toEqual([
        {
          id: 1,
          at: T10 + 30_123,
          actor_kind: 'maint',
          actor_admin_id: null,
          kind: 'admin_created',
          reservation_id: null,
          device_id: null,
          user_id: null,
          admin_id: 1,
          detail: { login_id: 'tanaka', display_name: '田中 太郎' },
        },
        {
          id: 2,
          at: T10 + MIN,
          actor_kind: 'maint',
          actor_admin_id: null,
          kind: 'admin_password_reset',
          reservation_id: null,
          device_id: null,
          user_id: null,
          admin_id: 1,
          detail: { login_id: 'tanaka', display_name: '田中 太郎' },
        },
      ]);
    });
  });

  test('LOG-4 events・auth_failures のどの列にも、パスワード・鍵の値が入っていない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      await send(ledger, maint(reset(1), { password: 'Another-Password-0002' }), { routes });
      await send(ledger, maint(CREATE, admin('suzuki'), { key: 'WrongKeyValue'.padEnd(43, 'z') }), { routes });

      const dump = JSON.stringify([...rows(state, 'SELECT * FROM events'), ...failures(state)]);
      expect(failures(state)).toHaveLength(1);
      for (const secret of [PASSWORD, 'Another-Password-0002', KEY, 'WrongKeyValue']) {
        expect(dump).not.toContain(secret);
      }
    });
  });
});

describe('API 保守用の API の本文と書き込み', () => {
  test('API 先頭に BOM の付いた UTF-8 の本文を読める', async () => {
    await withLedger(async (ledger) => {
      const { routes } = countingRoutes();
      const result = await send(ledger, maint(CREATE, `﻿${JSON.stringify(admin('tanaka'))}`), { routes });
      expect(result.status).toBe(200);
      expect(result.body.data.login_id).toBe('tanaka');
    });
  });

  test('API 断る要求では admins・events に何も書かれず、PBKDF2 も呼ばれない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes, derive } = countingRoutes();
      const refused = [
        maint(CREATE, admin('tanaka'), { key: null }),
        maint(CREATE, '{'),
        maint(CREATE, { ...admin('tanaka'), password: 'short' }),
        maint(reset(1), { password: PASSWORD }),
      ];
      for (const req of refused) expect((await send(ledger, req, { routes })).body.ok).toBe(false);
      expect(rows(state, 'SELECT id FROM admins')).toHaveLength(0);
      expect(rows(state, 'SELECT id FROM events')).toHaveLength(0);
      expect(derive.calls).toBe(0);

      // 成功する要求では1回だけ呼ばれる
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      expect(derive.calls).toBe(1);
    });
  });

  test('RSV-21 成功した要求は自動の変化を反映し、断った要求は反映しない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      seedDeviceAndUser(state);
      // 猶予（15分）を過ぎた予約済
      insertReservation(state, { startAt: T10 - 60 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });

      await send(ledger, maint(CREATE, { ...admin('tanaka'), password: 'short' }), { routes });
      expect(rows(state, 'SELECT status FROM reservations')).toEqual([{ status: 'reserved' }]);

      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      expect(rows(state, 'SELECT status FROM reservations')).toEqual([{ status: 'no_show' }]);
      expect(rows(state, 'SELECT kind FROM events ORDER BY id')).toEqual([{ kind: 'reservation_status' }, { kind: 'admin_created' }]);
    });
  });
});

describe('LOG-5 失敗の記録の上限（api.md 7、schema.md 2.10）', () => {
  test('LOG-5 行を足して番号が 10,000 のときは消えず、10,001 になると番号 1 の行が消える。ほかの表は変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { routes } = countingRoutes();
      await send(ledger, maint(CREATE, admin('tanaka')), { routes });
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
         INSERT INTO auth_failures
           (entry, client, window_start, failures, unknown_id_failures, wrong_password_failures, last_login_id,
            first_at, last_at)
         SELECT 'maint', 'seed-' || i, 0, 1, 0, 0, NULL, 0, 0 FROM n`,
      );
      const wrong = (ip) => maint(CREATE, admin('suzuki'), { key: 'w'.repeat(43), ip });

      await send(ledger, wrong('198.51.100.1'), { routes });
      expect(rows(state, 'SELECT MIN(id) AS min, MAX(id) AS max, COUNT(*) AS n FROM auth_failures')).toEqual([
        { min: 1, max: 10000, n: 10000 },
      ]);

      await send(ledger, wrong('198.51.100.2'), { routes });
      expect(rows(state, 'SELECT MIN(id) AS min, MAX(id) AS max, COUNT(*) AS n FROM auth_failures')).toEqual([
        { min: 2, max: 10001, n: 10000 },
      ]);

      // 同じ行を増やすときは消さない
      await send(ledger, wrong('198.51.100.2'), { routes });
      expect(rows(state, 'SELECT MIN(id) AS min, COUNT(*) AS n FROM auth_failures')).toEqual([{ min: 2, n: 10000 }]);

      expect(rows(state, 'SELECT COUNT(*) AS n FROM admins')).toEqual([{ n: 1 }]);
      expect(rows(state, 'SELECT COUNT(*) AS n FROM events')).toEqual([{ n: 1 }]);
    });
  });
});

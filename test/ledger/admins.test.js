// 管理者の画面からの管理者のアカウント（api.md 8.44〜8.48。ADM-2, ADM-1, RSV-23, RSV-21, LOG-2, LOG-4）。
// 時計は 10:00:30（nowMin = 10:00）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { PBKDF2_ITERATIONS, sha256 } from '../../src/lib/hash.js';
import { ORIGIN, fixedClock, insertReservation, rows, withLedger } from './helpers.js';
import { at, req, seed } from './reservation-helpers.js';

const NOW_AT = at(10) + 30_000;
const PASSWORD = 'Correct-Horse-Battery-01';
const NEW_PASSWORD = 'Brand-New-Horse-Battery-09';

// 速い計算の関数に差し替え、呼ばれた回数を数える（api.md 8.48「PBKDF2 は、断る要求では呼ばれない」）
function countingRoutes() {
  const derive = async (password, salt) => {
    derive.calls += 1;
    return sha256(`${password}:${[...salt].join(',')}`);
  };
  derive.calls = 0;
  return { routes: buildRoutes({ derivePassword: derive }), derive };
}

const LIST = '/api/admin/admins';
const resetPath = (id) => `/api/admin/admins/${id}/reset-password`;
const deletePath = (id) => `/api/admin/admins/${id}/delete`;
const account = (loginId, displayName = '佐藤 花子', password = PASSWORD) => ({
  login_id: loginId,
  display_name: displayName,
  password,
});

const codeOf = (result) => result.body.error?.code;
const adminRows = (state) => rows(state, 'SELECT * FROM admins ORDER BY id');
const allEvents = (state) => rows(state, 'SELECT * FROM events ORDER BY id');
const eventsOf = (state, kind) => rows(state, 'SELECT * FROM events WHERE kind = ? ORDER BY id', kind);
const cookieOf = (setCookie) => /^__Host-dxp_admin=([^;]*);/.exec(setCookie)[1];

// 1つの台帳に、数える経路の表で要求を送る道具をまとめる
function harness(ledger) {
  const { routes, derive } = countingRoutes();
  async function send(request, time = NOW_AT) {
    const response = await ledger.handle(request, fixedClock(time), routes);
    return { status: response.status, body: await response.json(), setCookie: response.headers.get('Set-Cookie') };
  }
  // 保守用の API で管理者を作る
  async function maintCreate(loginId, displayName = '田中 太郎') {
    const result = await send(
      new Request(`${ORIGIN}/api/maint/admins`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
        body: JSON.stringify(account(loginId, displayName)),
      }),
    );
    expect(result.status).toBe(200);
    return result.body.data.id;
  }
  async function login(loginId, password = PASSWORD) {
    return send(req('POST', '/api/admin/login', { body: { login_id: loginId, password } }));
  }
  // 認証して Cookie の値を返す
  async function cookie(loginId, password = PASSWORD) {
    const result = await login(loginId, password);
    expect(result.status).toBe(200);
    return cookieOf(result.setCookie);
  }
  const me = (admin) => send(req('GET', '/api/admin/me', { admin }));
  const list = (admin, options = {}) => send(req('GET', LIST, { admin, ...options }));
  const create = (admin, payload, options = {}) => send(req('POST', LIST, { body: payload, admin, ...options }));
  const reset = (admin, id, payload = { password: NEW_PASSWORD }, options = {}) =>
    send(req('POST', resetPath(id), { body: payload, admin, ...options }));
  const remove = (admin, id, options = {}) => send(req('POST', deletePath(id), { body: {}, admin, ...options }));
  return { send, derive, maintCreate, login, cookie, me, list, create, reset, remove };
}

// 管理者 1: tanaka（認証済み）、2: sato（認証済み）
async function twoAdmins(ledger) {
  const h = harness(ledger);
  await h.maintCreate('tanaka', '田中 太郎');
  await h.maintCreate('sato', '佐藤 花子');
  return { h, tanaka: await h.cookie('tanaka'), sato: await h.cookie('sato') };
}

describe('ADM-2 管理者の画面からの作成（POST /api/admin/admins）', () => {
  test('ADM-2 作成すると admins に1行でき、応答の data がその値になる。作った管理者で認証でき、作った側の証明はそのまま', async () => {
    await withLedger(async (ledger, state) => {
      const h = harness(ledger);
      await h.maintCreate('tanaka');
      const tanaka = await h.cookie('tanaka');

      const result = await h.create(tanaka, account('ＳａＴＯ', '  佐藤 花子　'));
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, data: { id: 2, login_id: 'sato', display_name: '佐藤 花子' } });
      // 作った側の期限を延ばす。作られた側の証明は作らない
      expect(result.setCookie).toMatch(new RegExp(`^__Host-dxp_admin=${tanaka}; Max-Age=[1-9]`));
      expect(rows(state, 'SELECT * FROM admin_sessions')).toHaveLength(1);

      const row = adminRows(state)[1];
      expect(row).toMatchObject({
        id: 2,
        login_id: 'sato',
        display_name: '佐藤 花子',
        password_iterations: PBKDF2_ITERATIONS,
        password_version: 1,
        created_at: NOW_AT,
        deleted_at: null,
      });
      expect(row.password_salt.byteLength).toBe(16);

      expect((await h.login('sato')).status).toBe(200);
      expect((await h.me(tanaka)).status).toBe(200);
    });
  });

  test('ADM-2 削除した管理者の ID（全角・大文字で送ったものを含む）での作成は RULE_ADMIN_ID_DUPLICATE で、行が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka } = await twoAdmins(ledger);
      expect((await h.remove(tanaka, 2)).status).toBe(200);

      for (const loginId of ['sato', 'ＳＡＴＯ']) {
        const result = await h.create(tanaka, account(loginId));
        expect(result.status).toBe(409);
        expect(codeOf(result)).toBe('RULE_ADMIN_ID_DUPLICATE');
      }
      // 削除していない管理者の ID も同じ
      expect(codeOf(await h.create(tanaka, account('Tanaka')))).toBe('RULE_ADMIN_ID_DUPLICATE');
      expect(adminRows(state)).toHaveLength(2);
    });
  });

  test.each([
    ['ID', account('1abc'), 'INPUT_LOGIN_ID'],
    ['名前', account('sato', '   '), 'INPUT_NAME'],
    ['パスワード', account('sato', '佐藤', 'short'), 'INPUT_PASSWORD'],
    ['ID と名前とパスワード', account('ab', '', 'short'), 'INPUT_LOGIN_ID'],
    ['名前とパスワード', account('sato', '', 'short'), 'INPUT_NAME'],
  ])('ADM-2 %s の形式の誤りは %s ではなく決まった順の最初のもの（400）', async (_, payload, code) => {
    await withLedger(async (ledger, state) => {
      const h = harness(ledger);
      await h.maintCreate('tanaka');
      const tanaka = await h.cookie('tanaka');
      const result = await h.create(tanaka, payload);
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe(code);
      expect(adminRows(state)).toHaveLength(1);
    });
  });
});

describe('ADM-2 管理者の一覧（GET /api/admin/admins）', () => {
  test('ADM-2 削除していない管理者だけが番号の順に出る。削除した管理者は出ない', async () => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      await h.maintCreate('suzuki', '鈴木 一郎');

      const before = await h.list(tanaka);
      expect(before.status).toBe(200);
      expect(before.setCookie).toMatch(/^__Host-dxp_admin=/);
      expect(before.body.data).toEqual({
        admins: [
          { id: 1, login_id: 'tanaka', display_name: '田中 太郎' },
          { id: 2, login_id: 'sato', display_name: '佐藤 花子' },
          { id: 3, login_id: 'suzuki', display_name: '鈴木 一郎' },
        ],
      });

      await h.remove(tanaka, 2);
      expect((await h.list(tanaka)).body.data.admins.map((a) => a.id)).toEqual([1, 3]);
    });
  });
});

describe('ADM-2 パスワードの設定し直し（POST /api/admin/admins/{id}/reset-password）', () => {
  test('ADM-2 ほかの管理者を設定し直すと版が1増え、新しいパスワードで認証でき、対象の証明だけがすべて止まる', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka, sato } = await twoAdmins(ledger);
      await h.maintCreate('suzuki', '鈴木 一郎');
      const suzuki = await h.cookie('suzuki');
      const sato2 = await h.cookie('sato'); // sato のほかの端末
      const before = adminRows(state)[1];

      const result = await h.reset(tanaka, 2);
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ id: 2, login_id: 'sato', display_name: '佐藤 花子' });
      expect(result.setCookie).toMatch(new RegExp(`^__Host-dxp_admin=${tanaka};`));

      const after = adminRows(state)[1];
      expect(after.password_version).toBe(before.password_version + 1);
      expect(new Uint8Array(after.password_hash)).not.toEqual(new Uint8Array(before.password_hash));
      expect(new Uint8Array(after.password_salt)).not.toEqual(new Uint8Array(before.password_salt));

      expect(codeOf(await h.me(sato))).toBe('AUTH_REVOKED');
      expect(codeOf(await h.me(sato2))).toBe('AUTH_REVOKED');
      expect((await h.me(tanaka)).status).toBe(200);
      expect((await h.me(suzuki)).status).toBe(200);

      expect((await h.login('sato', NEW_PASSWORD)).status).toBe(200);
      expect(codeOf(await h.login('sato', PASSWORD))).toBe('AUTH_ADMIN_FAILED');
    });
  });

  test('ADM-2 自分自身の設定し直しは RULE_ADMIN_SELF_RESET（409）で、何も変わらない。保守用の API では設定し直せる', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka } = await twoAdmins(ledger);
      const before = adminRows(state)[0];
      const eventCount = allEvents(state).length;

      const result = await h.reset(tanaka, 1);
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_ADMIN_SELF_RESET');
      expect(adminRows(state)[0]).toEqual(before);
      expect(allEvents(state)).toHaveLength(eventCount);
      expect((await h.me(tanaka)).status).toBe(200);

      const byMaint = await h.send(
        new Request(`${ORIGIN}/api/maint/admins/1/reset-password`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
          body: JSON.stringify({ password: NEW_PASSWORD }),
        }),
      );
      expect(byMaint.status).toBe(200);
      expect(adminRows(state)[0].password_version).toBe(before.password_version + 1);
    });
  });
});

describe('ADM-2 ない管理者と {id} の形', () => {
  test('ADM-2 ない番号・削除した管理者への設定し直しと削除は NOT_FOUND_ADMIN（404）', async () => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      await h.maintCreate('suzuki', '鈴木 一郎');
      await h.remove(tanaka, 3);

      for (const id of [3, 99]) {
        const reset = await h.reset(tanaka, id);
        expect(reset.status).toBe(404);
        expect(codeOf(reset)).toBe('NOT_FOUND_ADMIN');
        const removed = await h.remove(tanaka, id);
        expect(removed.status).toBe(404);
        expect(codeOf(removed)).toBe('NOT_FOUND_ADMIN');
      }
    });
  });

  test.each(['0', '01', 'abc'])('ADM-2 {id} が %s なら NOT_FOUND_API', async (id) => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      expect(codeOf(await h.send(req('POST', resetPath(id), { body: { password: NEW_PASSWORD }, admin: tanaka })))).toBe(
        'NOT_FOUND_API',
      );
      expect(codeOf(await h.send(req('POST', deletePath(id), { body: {}, admin: tanaka })))).toBe('NOT_FOUND_API');
    });
  });
});

describe('ADM-2 管理者の削除（POST /api/admin/admins/{id}/delete）', () => {
  test('ADM-2 LOG-2 ほかの管理者を削除すると deleted_at が入り行は残る。その証明は止まり、認証もできない。応答は期限を延ばす', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka, sato } = await twoAdmins(ledger);

      const result = await h.remove(tanaka, 2);
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ id: 2, login_id: 'sato', display_name: '佐藤 花子' });
      expect(result.setCookie).toMatch(new RegExp(`^__Host-dxp_admin=${tanaka}; Max-Age=[1-9]`));

      const rowsAfter = adminRows(state);
      expect(rowsAfter).toHaveLength(2);
      expect(rowsAfter[1].deleted_at).toBe(NOW_AT); // 秒を切り捨てない（TIM-5）
      expect(codeOf(await h.me(sato))).toBe('AUTH_REVOKED');
      expect(codeOf(await h.login('sato'))).toBe('AUTH_ADMIN_FAILED');
      expect((await h.me(tanaka)).status).toBe(200);
    });
  });

  test('ADM-2 自分自身を削除すると成功し、Max-Age=0 の Set-Cookie が付く。同じ Cookie もほかの端末の証明も AUTH_REVOKED', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka, sato } = await twoAdmins(ledger);
      const tanaka2 = await h.cookie('tanaka');

      const result = await h.remove(tanaka, 1);
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_admin=; Max-Age=0;/);
      expect(adminRows(state)[0].deleted_at).toBe(NOW_AT);

      expect(codeOf(await h.me(tanaka))).toBe('AUTH_REVOKED');
      expect(codeOf(await h.me(tanaka2))).toBe('AUTH_REVOKED');
      expect((await h.me(sato)).status).toBe(200);
    });
  });

  test('ADM-2 管理者が1人なら自分自身の削除は RULE_ADMIN_LAST（409）で、何も書かない', async () => {
    await withLedger(async (ledger, state) => {
      const h = harness(ledger);
      await h.maintCreate('tanaka');
      const tanaka = await h.cookie('tanaka');
      const eventCount = allEvents(state).length;

      const result = await h.remove(tanaka, 1);
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_ADMIN_LAST');
      expect(adminRows(state)[0].deleted_at).toBeNull();
      expect(allEvents(state)).toHaveLength(eventCount);
      expect((await h.me(tanaka)).status).toBe(200);
    });
  });

  test('ADM-2 2人のうち1人を削除した後、残った1人の削除も RULE_ADMIN_LAST', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka } = await twoAdmins(ledger);
      expect((await h.remove(tanaka, 2)).status).toBe(200);
      expect(codeOf(await h.remove(tanaka, 1))).toBe('RULE_ADMIN_LAST');
      expect(adminRows(state)[0].deleted_at).toBeNull();
    });
  });
});

describe('RSV-23 ほぼ同時の操作', () => {
  test('RSV-23 2人が互いを同時に削除すると、1つは成功し、もう1つは AUTH_REVOKED。管理者は1人以上残る', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka, sato } = await twoAdmins(ledger);
      const results = await Promise.all([h.remove(tanaka, 2), h.remove(sato, 1)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(results.map(codeOf).filter(Boolean)).toEqual(['AUTH_REVOKED']);
      expect(adminRows(state).filter((a) => a.deleted_at === null)).toHaveLength(1);
    });
  });

  test('RSV-23 2人が同時に自分自身を削除すると、1つは成功し、もう1つは RULE_ADMIN_LAST', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka, sato } = await twoAdmins(ledger);
      const results = await Promise.all([h.remove(tanaka, 1), h.remove(sato, 2)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.map(codeOf).filter(Boolean)).toEqual(['RULE_ADMIN_LAST']);
      expect(adminRows(state).filter((a) => a.deleted_at === null)).toHaveLength(1);
    });
  });

  test('RSV-23 同じ ID の作成を管理者の画面と保守用の API から同時に送ると、片方が成功し、もう片方が RULE_ADMIN_ID_DUPLICATE', async () => {
    await withLedger(async (ledger, state) => {
      const h = harness(ledger);
      await h.maintCreate('tanaka');
      const tanaka = await h.cookie('tanaka');
      const byMaint = new Request(`${ORIGIN}/api/maint/admins`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
        body: JSON.stringify(account('sato')),
      });
      const results = await Promise.all([h.create(tanaka, account('sato')), h.send(byMaint)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.map(codeOf).filter(Boolean)).toEqual(['RULE_ADMIN_ID_DUPLICATE']);
      expect(adminRows(state)).toHaveLength(2);
    });
  });
});

describe('LOG-4 記録', () => {
  test('LOG-4 作成・設定し直し・削除の記録に操作した管理者と対象が入り、detail は login_id・display_name だけ。パスワードは入らない', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka } = await twoAdmins(ledger);
      await h.create(tanaka, account('suzuki', '鈴木 一郎'));
      await h.reset(tanaka, 2);
      await h.remove(tanaka, 3);
      await h.remove(tanaka, 1);

      const common = { at: NOW_AT, actor_kind: 'admin', actor_admin_id: 1, reservation_id: null, device_id: null, user_id: null };
      const created = eventsOf(state, 'admin_created').filter((e) => e.actor_kind === 'admin');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ ...common, admin_id: 3 });
      expect(JSON.parse(created[0].detail)).toEqual({ login_id: 'suzuki', display_name: '鈴木 一郎' });

      const resets = eventsOf(state, 'admin_password_reset');
      expect(resets).toHaveLength(1);
      expect(resets[0]).toMatchObject({ ...common, admin_id: 2 });
      expect(JSON.parse(resets[0].detail)).toEqual({ login_id: 'sato', display_name: '佐藤 花子' });

      const deletes = eventsOf(state, 'admin_deleted');
      expect(deletes).toHaveLength(2);
      expect(deletes[0]).toMatchObject({ ...common, admin_id: 3 });
      expect(JSON.parse(deletes[0].detail)).toEqual({ login_id: 'suzuki', display_name: '鈴木 一郎' });
      // 自分自身の削除では actor_admin_id と admin_id が同じ
      expect(deletes[1]).toMatchObject({ ...common, admin_id: 1 });

      // どの列にもパスワードが入っていない。ハッシュ・ソルト（バイト列）を持つ列もない
      const text = JSON.stringify(allEvents(state));
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(NEW_PASSWORD);
      for (const event of allEvents(state)) {
        for (const value of Object.values(event)) expect(value instanceof ArrayBuffer).toBe(false);
      }
    });
  });
});

describe('ADM-1 API 共通の確かめ', () => {
  test('ADM-1 4つの API とも、利用者の Cookie だけでは AUTH_REQUIRED', async () => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      const shared = await h.send(req('POST', '/api/admin/shared-info', { body: {}, admin: tanaka }));
      const started = await h.send(req('POST', '/api/session', { body: { k: shared.body.data.value } }));
      const user = /^__Host-dxp_user=([^;]*);/.exec(started.setCookie)[1];

      const results = [
        await h.send(req('GET', LIST, { user })),
        await h.send(req('POST', LIST, { body: account('suzuki'), user })),
        await h.send(req('POST', resetPath(2), { body: { password: NEW_PASSWORD }, user })),
        await h.send(req('POST', deletePath(2), { body: {}, user })),
      ];
      expect(results.map(codeOf)).toEqual(['AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED']);
    });
  });

  test('API 作成・設定し直し・削除で Origin がないと AUTH_ORIGIN。一覧は Origin を確かめない', async () => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      const noOrigin = { origin: null };
      expect(codeOf(await h.create(tanaka, account('suzuki'), noOrigin))).toBe('AUTH_ORIGIN');
      expect(codeOf(await h.reset(tanaka, 2, { password: NEW_PASSWORD }, noOrigin))).toBe('AUTH_ORIGIN');
      expect(codeOf(await h.remove(tanaka, 2, noOrigin))).toBe('AUTH_ORIGIN');
      expect((await h.list(tanaka, noOrigin)).status).toBe(200);
    });
  });

  test.each([
    ['壊れた本文', '{', '{'],
    ['項目がない', {}, {}],
    ['文字列でない', { login_id: 1, display_name: 2, password: 3 }, { password: 3 }],
    ['一部の項目がない', { login_id: 'suzuki', password: PASSWORD }, { pass: NEW_PASSWORD }],
  ])('API 証明が有効で本文が %s なら INPUT_BODY', async (_, createBody, resetBody) => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      expect(codeOf(await h.send(req('POST', LIST, { body: createBody, admin: tanaka })))).toBe('INPUT_BODY');
      expect(codeOf(await h.send(req('POST', resetPath(2), { body: resetBody, admin: tanaka })))).toBe('INPUT_BODY');
    });
  });

  test('API 削除で本文が壊れていると INPUT_BODY', async () => {
    await withLedger(async (ledger, state) => {
      const { h, tanaka } = await twoAdmins(ledger);
      expect(codeOf(await h.send(req('POST', deletePath(2), { body: '{', admin: tanaka })))).toBe('INPUT_BODY');
      expect(adminRows(state)[1].deleted_at).toBeNull();
    });
  });

  test('API PBKDF2 は、作成・設定し直しで断る要求では呼ばれない', async () => {
    await withLedger(async (ledger) => {
      const { h, tanaka } = await twoAdmins(ledger);
      await h.remove(tanaka, 2); // 削除した管理者（NOT_FOUND_ADMIN 用）
      const refused = [
        () => h.create(tanaka, account('1abc')), // INPUT_LOGIN_ID
        () => h.create(tanaka, account('suzuki', '')), // INPUT_NAME
        () => h.create(tanaka, account('suzuki', '鈴木', 'short')), // INPUT_PASSWORD
        () => h.create(tanaka, account('sato')), // RULE_ADMIN_ID_DUPLICATE
        () => h.reset(tanaka, 3, { password: 'short' }), // INPUT_PASSWORD
        () => h.reset(tanaka, 2), // NOT_FOUND_ADMIN
        () => h.reset(tanaka, 1), // RULE_ADMIN_SELF_RESET
        () => h.create(undefined, account('suzuki')), // AUTH_REQUIRED
        () => h.create(tanaka, account('suzuki'), { origin: null }), // AUTH_ORIGIN
        () => h.send(req('POST', LIST, { body: '{', admin: tanaka })), // INPUT_BODY
        () => h.send(req('POST', '/api/admin/admins/0/reset-password', { body: { password: NEW_PASSWORD }, admin: tanaka })),
      ];
      for (const call of refused) {
        const before = h.derive.calls;
        const result = await call();
        expect(result.body.ok).toBe(false);
        expect(h.derive.calls).toBe(before);
      }
      // 受け付ける要求では1回
      const before = h.derive.calls;
      expect((await h.create(tanaka, account('suzuki'))).status).toBe(200);
      expect(h.derive.calls).toBe(before + 1);
    });
  });
});

describe('RSV-21 見た時点で自動の変化が反映される', () => {
  // 開始 9:45・猶予 15分の予約済は、10:00 に無断不使用になる
  async function withDue(fn) {
    await withLedger(async (ledger, state) => {
      const ctx = await twoAdmins(ledger);
      seed(state);
      const id = insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      const statusNow = () => rows(state, 'SELECT status FROM reservations WHERE id = ?', id)[0].status;
      await fn({ ...ctx, state, statusNow });
    });
  }

  test.each([
    ['一覧', ({ h, tanaka }) => h.list(tanaka)],
    ['作成の成功', ({ h, tanaka }) => h.create(tanaka, account('suzuki'))],
    ['設定し直しの成功', ({ h, tanaka }) => h.reset(tanaka, 2)],
    ['削除の成功', ({ h, tanaka }) => h.remove(tanaka, 2)],
    [
      'RULE_ADMIN_LAST で断った削除',
      async ({ h, tanaka, state }) => {
        state.storage.sql.exec('UPDATE admins SET deleted_at = 1 WHERE id = 2');
        const result = await h.remove(tanaka, 1);
        expect(codeOf(result)).toBe('RULE_ADMIN_LAST');
        return result;
      },
    ],
  ])('RSV-21 %s で無断不使用になる', async (_, call) => {
    await withDue(async (ctx) => {
      await call(ctx);
      expect(ctx.statusNow()).toBe('no_show');
    });
  });

  test.each([
    ['作成の段 1', ({ h, tanaka }) => h.create(tanaka, account('1abc'))],
    ['作成の段 8', ({ h, tanaka }) => h.create(tanaka, account('sato'))],
    ['設定し直しの段 1', ({ h, tanaka }) => h.reset(tanaka, 2, { password: 'short' })],
    ['設定し直しの段 2', ({ h, tanaka }) => h.reset(tanaka, 99)],
    ['設定し直しの段 8', ({ h, tanaka }) => h.reset(tanaka, 1)],
  ])('RSV-21 %s で断ったときは変わらない', async (_, call) => {
    await withDue(async (ctx) => {
      const result = await call(ctx);
      expect(result.body.ok).toBe(false);
      expect(ctx.statusNow()).toBe('reserved');
    });
  });
});

// 機器（api.md 8.18〜8.23）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, withLedger } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';

// 速い計算の関数に差し替える（PBKDF2 はこの機能の対象ではない）
const routes = buildRoutes({ derivePassword: (password, salt) => sha256(`${password}:${[...salt].join(',')}`) });

function req(method, path, { body, user, admin, origin = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': '192.0.2.1' };
  if (origin !== null) headers.Origin = origin;
  const cookies = [];
  if (user !== undefined) cookies.push(`__Host-dxp_user=${user}`);
  if (admin !== undefined) cookies.push(`__Host-dxp_admin=${admin}`);
  if (cookies.length > 0) headers.Cookie = cookies.join('; ');
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const adminListReq = (admin) => req('GET', '/api/admin/devices', { admin });
const userListReq = (user) => req('GET', '/api/devices', { user });
const createReq = (admin, body, options = {}) => req('POST', '/api/admin/devices', { body, admin, ...options });
const renameReq = (admin, id, body, options = {}) =>
  req('POST', `/api/admin/devices/${id}/rename`, { body, admin, ...options });
const deleteReq = (admin, id, options = {}) => req('POST', `/api/admin/devices/${id}/delete`, { body: {}, admin, ...options });

async function send(ledger, request, { at = T10 } = {}) {
  const response = await ledger.handle(request, fixedClock(at), routes);
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('Set-Cookie') };
}

const codeOf = (result) => result.body.error?.code;

// 管理者を作って認証し、共有された情報を設定し、利用を始める
async function setup(ledger) {
  const created = await send(
    ledger,
    new Request(`${ORIGIN}/api/maint/admins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
      body: JSON.stringify({ login_id: 'tanaka', display_name: '田中 太郎', password: PASSWORD }),
    }),
  );
  expect(created.status).toBe(200);
  const login = await send(ledger, req('POST', '/api/admin/login', { body: { login_id: 'tanaka', password: PASSWORD } }));
  const admin = /^__Host-dxp_admin=([^;]*);/.exec(login.setCookie)[1];
  const shared = await send(ledger, req('POST', '/api/admin/shared-info', { body: {}, admin }));
  const started = await send(ledger, req('POST', '/api/session', { body: { k: shared.body.data.value } }));
  const user = /^__Host-dxp_user=([^;]*);/.exec(started.setCookie)[1];
  return { admin, user, adminId: created.body.data.id };
}

async function create(ledger, admin, name) {
  const result = await send(ledger, createReq(admin, { name }));
  expect(result.status).toBe(200);
  return result.body.data.id;
}

const devices = (state) => rows(state, 'SELECT * FROM devices ORDER BY id');
const deviceEvents = (state) =>
  rows(state, "SELECT * FROM events WHERE kind IN ('device_created', 'device_renamed', 'device_deleted', 'reservation_status') ORDER BY id");
const reservations = (state) => rows(state, 'SELECT * FROM reservations ORDER BY id');

function seedUser(state) {
  state.storage.sql.exec(
    "INSERT INTO users (role, student_id, name, cohort, created_at) VALUES ('student', '12345678', '山田', 12, 0)",
  );
  return 1;
}

describe('MNG-1 機器の追加と一覧', () => {
  test('MNG-1 追加すると devices に1行でき、応答がその値になり、2つの一覧に番号の順で出る', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      const first = await send(ledger, createReq(admin, { name: '  3Dプリンタ1　' }), { at: T10 + 1234 });
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({ id: 1, name: '3Dプリンタ1' });
      await create(ledger, admin, 'PC1');

      expect(devices(state)).toEqual([
        { id: 1, name: '3Dプリンタ1', created_at: T10 + 1234, deleted_at: null },
        { id: 2, name: 'PC1', created_at: T10, deleted_at: null },
      ]);
      const expected = [
        { id: 1, name: '3Dプリンタ1' },
        { id: 2, name: 'PC1' },
      ];
      const adminList = await send(ledger, adminListReq(admin));
      expect(adminList.status).toBe(200);
      expect(adminList.body.data).toEqual({ devices: expected });
      const userList = await send(ledger, userListReq(user));
      expect(userList.status).toBe(200);
      expect(userList.body.data.devices).toEqual(expected);
    });
  });

  test('MNG-1 機器が1つもなければ2つの一覧は空の配列', async () => {
    await withLedger(async (ledger) => {
      const { admin, user } = await setup(ledger);
      expect((await send(ledger, adminListReq(admin))).body.data).toEqual({ devices: [] });
      expect((await send(ledger, userListReq(user))).body.data.devices).toEqual([]);
    });
  });

  test('MNG-1 2つの一覧の応答は Cookie の期限を延ばす', async () => {
    await withLedger(async (ledger) => {
      const { admin, user } = await setup(ledger);
      expect((await send(ledger, adminListReq(admin))).setCookie).toMatch(/^__Host-dxp_admin=/);
      expect((await send(ledger, userListReq(user))).setCookie).toMatch(/^__Host-dxp_user=/);
    });
  });

  test('MNG-1 同じ名前（前後の空白だけ違うものを含む）の追加は RULE_DEVICE_NAME_DUPLICATE で、行が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      for (const name of ['PC1', ' PC1 ']) {
        const result = await send(ledger, createReq(admin, { name }));
        expect(result.status).toBe(409);
        expect(codeOf(result)).toBe('RULE_DEVICE_NAME_DUPLICATE');
      }
      expect(devices(state)).toHaveLength(1);
      expect(deviceEvents(state)).toHaveLength(1);
    });
  });

  test('MNG-1 大文字と小文字、全角と半角だけが違う名前は追加できる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      await create(ledger, admin, 'pc1');
      await create(ledger, admin, 'ＰＣ１');
      expect(devices(state).map((d) => d.name)).toEqual(['PC1', 'pc1', 'ＰＣ１']);
    });
  });

  test.each([
    ['空白だけ', ' 　 '],
    ['31文字', 'あ'.repeat(31)],
    ['改行入り', 'PC\n1'],
  ])('MNG-1 追加の名前が %s なら INPUT_DEVICE_NAME で、表が変わらない', async (_, name) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const result = await send(ledger, createReq(admin, { name }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_DEVICE_NAME');
      expect(devices(state)).toHaveLength(0);
      expect(deviceEvents(state)).toHaveLength(0);
    });
  });

  test('MNG-1 削除した機器と同じ名前は追加できる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const id = await create(ledger, admin, 'PC1');
      expect((await send(ledger, deleteReq(admin, id))).status).toBe(200);
      expect(await create(ledger, admin, 'PC1')).toBe(2);
      expect(devices(state).map((d) => [d.name, d.deleted_at === null])).toEqual([
        ['PC1', false],
        ['PC1', true],
      ]);
    });
  });
});

describe('TIM-1 利用者の機器の一覧の now', () => {
  test('TIM-1 差し替えた時計の時刻の秒を切り捨てた日本時間（UTC 15:00:59 → 翌日の 00:00）', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      const at = Date.UTC(2026, 10, 20, 15, 0, 59);
      const result = await send(ledger, userListReq(user), { at });
      expect(result.body.data.now).toBe('2026-11-21T00:00');
    });
  });

  test('TIM-1 管理者の一覧には now を入れない', async () => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      expect((await send(ledger, adminListReq(admin))).body.data).not.toHaveProperty('now');
    });
  });
});

describe('MNG-1 機器の名前の変更', () => {
  test('MNG-1 名前を変えると行が上書きされ、device_renamed の before・after が前後の名前', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const id = await create(ledger, admin, 'PC1');
      const result = await send(ledger, renameReq(admin, id, { name: ' PC-1 ' }));
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ id, name: 'PC-1' });
      expect(devices(state)[0].name).toBe('PC-1');
      const renamed = deviceEvents(state).filter((e) => e.kind === 'device_renamed');
      expect(renamed).toHaveLength(1);
      expect(renamed[0].device_id).toBe(id);
      expect(JSON.parse(renamed[0].detail)).toEqual({ before: { name: 'PC1' }, after: { name: 'PC-1' } });
    });
  });

  test('MNG-1 ほかの機器の名前への変更は RULE_DEVICE_NAME_DUPLICATE で、名前は変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      const id = await create(ledger, admin, 'PC2');
      const result = await send(ledger, renameReq(admin, id, { name: 'PC1' }));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_DEVICE_NAME_DUPLICATE');
      expect(devices(state).map((d) => d.name)).toEqual(['PC1', 'PC2']);
    });
  });

  test('MNG-1 今と同じ名前への変更は成功し、events が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const id = await create(ledger, admin, 'PC1');
      const before = deviceEvents(state).length;
      const result = await send(ledger, renameReq(admin, id, { name: ' PC1' }));
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ id, name: 'PC1' });
      expect(deviceEvents(state)).toHaveLength(before);
    });
  });

  test('MNG-1 削除した機器の名前に変えられる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const old = await create(ledger, admin, 'PC1');
      await send(ledger, deleteReq(admin, old));
      const id = await create(ledger, admin, 'PC2');
      expect((await send(ledger, renameReq(admin, id, { name: 'PC1' }))).status).toBe(200);
      expect(devices(state).map((d) => d.name)).toEqual(['PC1', 'PC1']);
    });
  });

  test('MNG-1 名前の変更でも名前が31文字なら INPUT_DEVICE_NAME で、表が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const id = await create(ledger, admin, 'PC1');
      const result = await send(ledger, renameReq(admin, id, { name: 'あ'.repeat(31) }));
      expect(codeOf(result)).toBe('INPUT_DEVICE_NAME');
      expect(devices(state)[0].name).toBe('PC1');
    });
  });
});

describe('MNG-1 ない機器・削除した機器', () => {
  test('MNG-1 ない番号の名前の変更・削除は NOT_FOUND_DEVICE（404）', async () => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      for (const request of [renameReq(admin, 9, { name: 'PC1' }), deleteReq(admin, 9)]) {
        const result = await send(ledger, request);
        expect(result.status).toBe(404);
        expect(codeOf(result)).toBe('NOT_FOUND_DEVICE');
      }
    });
  });

  test('MNG-1 削除した機器の名前の変更・削除は NOT_FOUND_DEVICE で、名前は削除の時点のまま', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const id = await create(ledger, admin, 'PC1');
      await send(ledger, deleteReq(admin, id));
      expect(codeOf(await send(ledger, renameReq(admin, id, { name: 'PC2' })))).toBe('NOT_FOUND_DEVICE');
      expect(codeOf(await send(ledger, deleteReq(admin, id)))).toBe('NOT_FOUND_DEVICE');
      expect(devices(state)[0].name).toBe('PC1');
    });
  });

  test('MNG-1 {id} が正の整数の形でなければ NOT_FOUND_API', async () => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      for (const id of ['0', '01', 'a', '-1']) {
        expect(codeOf(await send(ledger, renameReq(admin, id, { name: 'PC1' })))).toBe('NOT_FOUND_API');
        expect(codeOf(await send(ledger, deleteReq(admin, id)))).toBe('NOT_FOUND_API');
      }
    });
  });

  test('MNG-1 削除した機器は2つの一覧に出ない。devices の行は残り、name は削除の時点の名前', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      const id = await create(ledger, admin, 'PC1');
      await create(ledger, admin, 'PC2');
      const result = await send(ledger, deleteReq(admin, id), { at: T10 + 5 * MIN + 789 });
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ id, name: 'PC1' });
      expect((await send(ledger, adminListReq(admin))).body.data.devices).toEqual([{ id: 2, name: 'PC2' }]);
      expect((await send(ledger, userListReq(user))).body.data.devices).toEqual([{ id: 2, name: 'PC2' }]);
      expect(devices(state)[0]).toEqual({ id, name: 'PC1', created_at: T10, deleted_at: T10 + 5 * MIN + 789 });
    });
  });
});

describe('MNG-2 機器の削除と予約', () => {
  // 機器1（削除する）と機器2（ほか）、利用者1
  async function prepare(ledger, state) {
    const { admin, adminId } = await setup(ledger);
    await create(ledger, admin, '削除用');
    await create(ledger, admin, 'ほか');
    seedUser(state);
    return { admin, adminId };
  }

  test('MNG-2 予約済が2件なら2件とも admin_cancelled・device_deleted になり、時刻・ほかの予約は変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await prepare(ledger, state);
      const r1 = insertReservation(state, { deviceId: 1, startAt: T10 + 60 * MIN, endAt: T10 + 120 * MIN, status: 'reserved' });
      const r2 = insertReservation(state, { deviceId: 1, startAt: T10 + 180 * MIN, endAt: T10 + 240 * MIN, status: 'reserved' });
      const other = insertReservation(state, { deviceId: 2, startAt: T10 + 60 * MIN, endAt: T10 + 120 * MIN, status: 'reserved' });
      const done = insertReservation(state, { deviceId: 1, startAt: T10 - 120 * MIN, endAt: T10 - 60 * MIN, status: 'finished' });
      const cancelled = insertReservation(state, { deviceId: 1, startAt: T10 + 60 * MIN, endAt: T10 + 90 * MIN, status: 'cancelled' });

      expect((await send(ledger, deleteReq(admin, 1))).status).toBe(200);

      const byId = new Map(reservations(state).map((r) => [r.id, r]));
      for (const id of [r1, r2]) {
        expect(byId.get(id)).toMatchObject({ status: 'admin_cancelled', cause: 'device_deleted' });
      }
      expect(byId.get(r1)).toMatchObject({ start_at: T10 + 60 * MIN, end_at: T10 + 120 * MIN });
      expect(byId.get(r2)).toMatchObject({ start_at: T10 + 180 * MIN, end_at: T10 + 240 * MIN });
      expect(byId.get(other)).toMatchObject({ status: 'reserved', cause: null });
      expect(byId.get(done)).toMatchObject({ status: 'finished', cause: null });
      expect(byId.get(cancelled)).toMatchObject({ status: 'cancelled', cause: null });
    });
  });

  test('MNG-2 利用中の予約がある機器の削除は RULE_DEVICE_IN_USE で、機器も予約済も変わらず events が増えない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await prepare(ledger, state);
      insertReservation(state, { deviceId: 1, startAt: T10 - 10 * MIN, endAt: T10 + 30 * MIN, status: 'in_use' });
      insertReservation(state, { deviceId: 1, startAt: T10 + 60 * MIN, endAt: T10 + 120 * MIN, status: 'reserved' });
      const before = rows(state, 'SELECT COUNT(*) AS n FROM events')[0].n;

      const result = await send(ledger, deleteReq(admin, 1));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_DEVICE_IN_USE');
      expect(devices(state)[0].deleted_at).toBeNull();
      expect(reservations(state).map((r) => r.status)).toEqual(['in_use', 'reserved']);
      expect(rows(state, 'SELECT COUNT(*) AS n FROM events')[0].n).toBe(before);
    });
  });

  test('MNG-2 終了時刻がちょうど nowMin の利用中は削除の前に終了になり（自動・終了時刻）、削除できる（RSV-22）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await prepare(ledger, state);
      const id = insertReservation(state, { deviceId: 1, startAt: T10 - 60 * MIN, endAt: T10, status: 'in_use' });
      expect((await send(ledger, deleteReq(admin, 1), { at: T10 + 30_000 })).status).toBe(200);
      expect(reservations(state)[0].status).toBe('finished');
      const auto = rows(state, "SELECT * FROM events WHERE actor_kind = 'auto' AND reservation_id = ?", id);
      expect(auto).toHaveLength(1);
      expect(auto[0].at).toBe(T10);
      expect(JSON.parse(auto[0].detail)).toEqual({ from: 'in_use', to: 'finished' });
    });
  });

  test('MNG-2 開始時刻＋猶予を過ぎた予約済は削除の前に無断不使用になり、管理者による取消にならない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await prepare(ledger, state);
      insertReservation(state, { deviceId: 1, startAt: T10 - 60 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });
      expect((await send(ledger, deleteReq(admin, 1))).status).toBe(200);
      expect(reservations(state)[0]).toMatchObject({ status: 'no_show', cause: null });
      expect(rows(state, "SELECT * FROM events WHERE kind = 'reservation_status' AND actor_kind = 'admin'")).toHaveLength(0);
    });
  });
});

describe('LOG-3 LOG-4 機器の操作の記録', () => {
  test('LOG-3 削除の記録は device_deleted が先で、取消ごとに reservation_status が番号の順に1行ずつ入る', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, adminId } = await setup(ledger);
      await create(ledger, admin, '削除用');
      seedUser(state);
      const r1 = insertReservation(state, { deviceId: 1, startAt: T10 + 60 * MIN, endAt: T10 + 120 * MIN, status: 'reserved' });
      const r2 = insertReservation(state, { deviceId: 1, startAt: T10 + 180 * MIN, endAt: T10 + 240 * MIN, status: 'reserved' });
      const at = T10 + 12_345;
      await send(ledger, deleteReq(admin, 1), { at });

      const events = deviceEvents(state).filter((e) => e.kind !== 'device_created');
      expect(events.map((e) => e.kind)).toEqual(['device_deleted', 'reservation_status', 'reservation_status']);
      expect(events[0]).toMatchObject({ at, actor_kind: 'admin', actor_admin_id: adminId, device_id: 1, reservation_id: null, user_id: null });
      expect(JSON.parse(events[0].detail)).toEqual({ name: '削除用' });
      for (const [event, id] of [
        [events[1], r1],
        [events[2], r2],
      ]) {
        expect(event).toMatchObject({ at, actor_kind: 'admin', actor_admin_id: adminId, reservation_id: id, device_id: 1, user_id: 1 });
        expect(JSON.parse(event.detail)).toEqual({ from: 'reserved', to: 'admin_cancelled', cause: 'device_deleted' });
      }
    });
  });

  test('LOG-4 追加・名前の変更・削除の記録に actor_kind = admin と actor_admin_id が入り、at は秒を切り捨てない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, adminId } = await setup(ledger);
      await send(ledger, createReq(admin, { name: 'PC1' }), { at: T10 + 1_001 });
      await send(ledger, renameReq(admin, 1, { name: 'PC-1' }), { at: T10 + 2_002 });
      await send(ledger, deleteReq(admin, 1), { at: T10 + 3_003 });

      const events = deviceEvents(state);
      expect(events.map((e) => [e.kind, e.at, e.actor_kind, e.actor_admin_id, e.device_id])).toEqual([
        ['device_created', T10 + 1_001, 'admin', adminId, 1],
        ['device_renamed', T10 + 2_002, 'admin', adminId, 1],
        ['device_deleted', T10 + 3_003, 'admin', adminId, 1],
      ]);
      expect(JSON.parse(events[0].detail)).toEqual({ name: 'PC1' });
      expect(JSON.parse(events[2].detail)).toEqual({ name: 'PC-1' });
    });
  });
});

describe('RSV-23 同時の追加', () => {
  test('RSV-23 同じ名前の追加を2つ同時に送ると、1つは成功し、もう1つは RULE_DEVICE_NAME_DUPLICATE。行は1つ', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const results = await Promise.all([
        send(ledger, createReq(admin, { name: 'PC1' })),
        send(ledger, createReq(admin, { name: 'PC1' })),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'RULE_DEVICE_NAME_DUPLICATE'].sort());
      expect(devices(state)).toHaveLength(1);
    });
  });
});

describe('ADM-1 機器の API の認証の種類', () => {
  test('ADM-1 GET /api/devices は管理者の Cookie だけでは AUTH_REQUIRED', async () => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      const result = await send(ledger, req('GET', '/api/devices', { admin }));
      expect(result.status).toBe(401);
      expect(codeOf(result)).toBe('AUTH_REQUIRED');
    });
  });

  test('ADM-1 機器の管理者の API は利用者の Cookie だけでは AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      for (const request of [
        req('GET', '/api/admin/devices', { user }),
        req('POST', '/api/admin/devices', { body: { name: 'PC2' }, user }),
        req('POST', '/api/admin/devices/1/rename', { body: { name: 'PC2' }, user }),
        req('POST', '/api/admin/devices/1/delete', { body: {}, user }),
      ]) {
        expect(codeOf(await send(ledger, request))).toBe('AUTH_REQUIRED');
      }
      expect(devices(state)).toEqual([expect.objectContaining({ name: 'PC1', deleted_at: null })]);
    });
  });
});

describe('API 機器の API の共通の確かめ', () => {
  const posts = [
    ['追加', (admin, options) => createReq(admin, { name: 'PC2' }, options)],
    ['名前の変更', (admin, options) => renameReq(admin, 1, { name: 'PC2' }, options)],
    ['削除', (admin, options) => deleteReq(admin, 1, options)],
  ];

  test.each(posts)('API %s で Origin がないと AUTH_ORIGIN', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      expect(codeOf(await send(ledger, makeReq(admin, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(devices(state)).toEqual([expect.objectContaining({ name: 'PC1', deleted_at: null })]);
    });
  });

  test.each(posts)('API %s で証明が有効で本文が壊れていると INPUT_BODY', async (_, makeReq) => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      const broken = makeReq(admin, {});
      const request = new Request(broken.url, { method: 'POST', headers: broken.headers, body: '{"name":' });
      const result = await send(ledger, request);
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_BODY');
    });
  });

  test.each([
    ['ない', {}],
    ['数値', { name: 1 }],
    ['null', { name: null }],
  ])('API 追加・名前の変更で name が %s なら INPUT_BODY', async (_, body) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      await create(ledger, admin, 'PC1');
      expect(codeOf(await send(ledger, createReq(admin, body)))).toBe('INPUT_BODY');
      expect(codeOf(await send(ledger, renameReq(admin, 1, body)))).toBe('INPUT_BODY');
      expect(devices(state).map((d) => d.name)).toEqual(['PC1']);
    });
  });

  test('API 2つの一覧（GET）は Origin を確かめない', async () => {
    await withLedger(async (ledger) => {
      const { admin, user } = await setup(ledger);
      expect((await send(ledger, req('GET', '/api/admin/devices', { admin, origin: null }))).status).toBe(200);
      expect((await send(ledger, req('GET', '/api/devices', { user, origin: null }))).status).toBe(200);
    });
  });
});

describe('RSV-21 機器の API と自動の変化', () => {
  const AT = T10 + 30 * MIN;
  const statuses = (state) => rows(state, 'SELECT status FROM reservations ORDER BY id').map((r) => r.status);

  // 機器1「PC1」に、開始時刻＋猶予を過ぎた予約済の予約を足す
  async function prepare(ledger, state) {
    const session = await setup(ledger);
    await create(ledger, session.admin, 'PC1');
    seedUser(state);
    insertReservation(state, { deviceId: 1, startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });
    return session;
  }

  test.each([
    ['管理者の一覧', ({ admin }) => adminListReq(admin), 200],
    ['利用者の一覧', ({ user }) => userListReq(user), 200],
    ['追加の成功', ({ admin }) => createReq(admin, { name: 'PC2' }), 200],
    ['RULE_DEVICE_NAME_DUPLICATE で断った追加', ({ admin }) => createReq(admin, { name: 'PC1' }), 409],
  ])('RSV-21 %s で無断不使用になる', async (_, makeReq, status) => {
    await withLedger(async (ledger, state) => {
      const session = await prepare(ledger, state);
      expect((await send(ledger, makeReq(session), { at: AT })).status).toBe(status);
      expect(statuses(state)).toEqual(['no_show']);
    });
  });

  test('RSV-21 INPUT_DEVICE_NAME で断ったときは変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await prepare(ledger, state);
      expect(codeOf(await send(ledger, createReq(admin, { name: ' ' }), { at: AT }))).toBe('INPUT_DEVICE_NAME');
      expect(statuses(state)).toEqual(['reserved']);
    });
  });
});

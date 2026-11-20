// 数値の変更（api.md 8.41〜8.43。RSV-25, RSV-26, RSV-22, RSV-23, RSV-21, LOG-4, ADM-1）。
// 時計は 10:00:30（nowMin = 10:00）、数値は初期値（件数 3、猶予 15分、長さ 1440分）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { ORIGIN, insertReservation, rows, withLedger } from './helpers.js';
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

const NOW_AT = at(10) + 30_000;
const INITIAL = { max_count: 3, grace_minutes: 15, max_length_minutes: 1440 };
const MINUTE_MAX = Math.floor(Number.MAX_SAFE_INTEGER / 60000);

const getReq = (admin, options = {}) => req('GET', '/api/admin/settings', { admin, ...options });
const postReq = (admin, payload, options = {}) => req('POST', '/api/admin/settings', { body: payload, admin, ...options });
const beginReq = (user, id) => req('POST', `/api/reservations/${id}/begin`, { body: STUDENT, user });
const sendAt = (ledger, request, time = NOW_AT) => send(ledger, request, { at: time });
const settingRows = (state) => rows(state, 'SELECT * FROM settings ORDER BY id');
const allEvents = (state) => rows(state, 'SELECT * FROM events ORDER BY id');
const snapshot = (state) => ({ settings: settingRows(state), events: allEvents(state), reservations: reservations(state) });
const statusOf = (state, id) => reservations(state).find((r) => r.id === id).status;

// 2人目の管理者を作って認証し、Cookie の値を返す
async function secondAdmin(ledger) {
  const password = 'Second-Horse-Battery-02';
  const created = await send(
    ledger,
    new Request(`${ORIGIN}/api/maint/admins`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MAINT_KEY}` },
      body: JSON.stringify({ login_id: 'sato', display_name: '佐藤', password }),
    }),
  );
  expect(created.status).toBe(200);
  const login = await send(ledger, req('POST', '/api/admin/login', { body: { login_id: 'sato', password } }));
  return { id: created.body.data.id, cookie: /^__Host-dxp_admin=([^;]*);/.exec(login.setCookie)[1] };
}

describe('RSV-25 数値の現在の値と変更', () => {
  test('RSV-25 初期データだけなら GET が 3・15・1440。max_count を 5 にすると応答と次の GET が 5 で、settings に 10:00 の行が1行足される', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);

      const initial = await sendAt(ledger, getReq(admin));
      expect(initial.status).toBe(200);
      expect(initial.setCookie).toMatch(/^__Host-dxp_admin=/);
      expect(initial.body.data).toEqual(INITIAL);
      const before = settingRows(state);

      const changed = await sendAt(ledger, postReq(admin, { key: 'max_count', value: 5 }));
      expect(changed.status).toBe(200);
      expect(changed.setCookie).toMatch(/^__Host-dxp_admin=/);
      expect(changed.body.data).toEqual({ ...INITIAL, max_count: 5 });
      expect((await sendAt(ledger, getReq(admin))).body.data).toEqual({ ...INITIAL, max_count: 5 });

      const after = settingRows(state);
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)).toMatchObject({ key: 'max_count', value: 5, effective_at: at(10) });
    });
  });

  test('RSV-25 LOG-4 変更の記録が1行で、管理者・切り捨てない時刻・detail を持ち、番号の列は NULL', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      await sendAt(ledger, postReq(admin, { key: 'max_count', value: 5 }));

      const changed = events(state, 'setting_changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        at: NOW_AT,
        actor_kind: 'admin',
        actor_admin_id: 1,
        reservation_id: null,
        device_id: null,
        user_id: null,
        admin_id: null,
      });
      expect(JSON.parse(changed[0].detail)).toEqual({ key: 'max_count', before: 3, after: 5, effective_at: at(10) });
    });
  });

  test('RSV-25 今と同じ値への変更は成功し、settings と events が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const before = snapshot(state);

      const result = await sendAt(ledger, postReq(admin, { key: 'grace_minutes', value: 15 }));
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual(INITIAL);
      expect(snapshot(state)).toEqual(before);
    });
  });

  test('RSV-25 3件を確保している利用者がいるとき max_count を 1 にしても3件とも残り、その利用者は RULE_COUNT、予約のない利用者は1件だけ確保できる', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      for (const hour of [11, 12, 13]) insertReservation(state, { startAt: at(hour), endAt: at(hour + 1), status: 'reserved' });

      expect((await sendAt(ledger, postReq(admin, { key: 'max_count', value: 1 }))).status).toBe(200);
      expect(reservations(state).map((r) => r.status)).toEqual(['reserved', 'reserved', 'reserved']);

      expect(codeOf(await sendAt(ledger, reserveReq(user, body('15:00', '16:00'))))).toBe('RULE_COUNT');
      expect((await sendAt(ledger, reserveReq(user, body('16:00', '17:00', { who: TEACHER })))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, reserveReq(user, body('17:00', '18:00', { who: TEACHER }))))).toBe('RULE_COUNT');
    });
  });

  test('RSV-25 120分の予約済は max_length_minutes を 60 にしても残り、開始時刻ちょうどに利用開始できる。新しい確保は61分で RULE_LENGTH、60分は成功', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      seed(state);
      const id = insertReservation(state, { startAt: at(11), endAt: at(13), status: 'reserved' });

      expect((await sendAt(ledger, postReq(admin, { key: 'max_length_minutes', value: 60 }))).status).toBe(200);
      expect(statusOf(state, id)).toBe('reserved');

      expect(codeOf(await sendAt(ledger, reserveReq(user, body('14:00', '15:01'))))).toBe('RULE_LENGTH');
      expect((await sendAt(ledger, reserveReq(user, body('14:00', '15:00')))).status).toBe(200);

      const begun = await sendAt(ledger, beginReq(user, id), at(11));
      expect(begun.status).toBe(200);
      expect(reservations(state).find((r) => r.id === id)).toMatchObject({ status: 'in_use', start_at: at(11), end_at: at(13) });
    });
  });
});

describe('RSV-26 猶予の変更は、開始時刻が変更の時刻以降の予約だけに効く', () => {
  test('RSV-26 開始 9:58 の予約済は、10:00 に猶予を 5分にしても、10:03・10:12 では予約済、10:13 で無断不使用（記録は自動・10:13）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      const id = insertReservation(state, { startAt: at(9, 58), endAt: at(11), status: 'reserved' });

      expect((await sendAt(ledger, postReq(admin, { key: 'grace_minutes', value: 5 }))).status).toBe(200);
      await sendAt(ledger, getReq(admin), at(10, 3));
      expect(statusOf(state, id)).toBe('reserved');
      await sendAt(ledger, getReq(admin), at(10, 12));
      expect(statusOf(state, id)).toBe('reserved');
      await sendAt(ledger, getReq(admin), at(10, 13));
      expect(statusOf(state, id)).toBe('no_show');
      expect(events(state, 'reservation_status')).toEqual([
        expect.objectContaining({ actor_kind: 'auto', at: at(10, 13), reservation_id: id }),
      ]);
    });
  });

  test('RSV-26 10:00 に猶予を 5分にすると、開始 10:00 ちょうどの予約済は 10:05、開始 10:01 の予約済は 10:06 で無断不使用', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      const first = insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      const second = insertReservation(state, { deviceId: 2, startAt: at(10, 1), endAt: at(11), status: 'reserved' });

      expect((await sendAt(ledger, postReq(admin, { key: 'grace_minutes', value: 5 }))).status).toBe(200);
      await sendAt(ledger, getReq(admin), at(10, 4));
      expect([statusOf(state, first), statusOf(state, second)]).toEqual(['reserved', 'reserved']);
      await sendAt(ledger, getReq(admin), at(10, 5));
      expect([statusOf(state, first), statusOf(state, second)]).toEqual(['no_show', 'reserved']);
      await sendAt(ledger, getReq(admin), at(10, 6));
      expect(statusOf(state, second)).toBe('no_show');

      const auto = events(state, 'reservation_status');
      expect(auto.map((e) => [e.reservation_id, e.actor_kind, e.at])).toEqual([
        [first, 'auto', at(10, 5)],
        [second, 'auto', at(10, 6)],
      ]);
    });
  });

  test('RSV-26 同じ分に 15 → 5 → 20 と変えると、10:00 の行が2つ足され GET が 20。開始 10:00 の予約済の猶予は 20分。記録は2行で、2行目の before が 5', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      const id = insertReservation(state, { startAt: at(10), endAt: at(11), status: 'reserved' });
      const before = settingRows(state).length;

      await sendAt(ledger, postReq(admin, { key: 'grace_minutes', value: 5 }));
      const last = await sendAt(ledger, postReq(admin, { key: 'grace_minutes', value: 20 }));
      expect(last.body.data).toEqual({ ...INITIAL, grace_minutes: 20 });

      const added = settingRows(state).slice(before);
      expect(added.map((r) => [r.key, r.value, r.effective_at])).toEqual([
        ['grace_minutes', 5, at(10)],
        ['grace_minutes', 20, at(10)],
      ]);
      expect((await sendAt(ledger, getReq(admin))).body.data.grace_minutes).toBe(20);

      await sendAt(ledger, getReq(admin), at(10, 19));
      expect(statusOf(state, id)).toBe('reserved');
      await sendAt(ledger, getReq(admin), at(10, 20));
      expect(statusOf(state, id)).toBe('no_show');

      const changed = events(state, 'setting_changed').map((e) => JSON.parse(e.detail));
      expect(changed).toEqual([
        { key: 'grace_minutes', before: 15, after: 5, effective_at: at(10) },
        { key: 'grace_minutes', before: 5, after: 20, effective_at: at(10) },
      ]);
    });
  });
});

describe('RSV-22 同じ時刻では自動の変化が数値の変更より先', () => {
  test('RSV-22 開始 9:45 の予約済は、10:00 の数値の変更の前に無断不使用になる（記録は自動・10:00 で、setting_changed より番号が小さい）', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      const id = insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });

      expect((await sendAt(ledger, postReq(admin, { key: 'grace_minutes', value: 60 }))).status).toBe(200);
      expect(statusOf(state, id)).toBe('no_show');
      const [auto] = events(state, 'reservation_status');
      const [changed] = events(state, 'setting_changed');
      expect(auto).toMatchObject({ actor_kind: 'auto', at: at(10), reservation_id: id });
      expect(auto.id).toBeLessThan(changed.id);
    });
  });
});

describe('RSV-25 値の誤り（INPUT_SETTING_VALUE）', () => {
  test.each([
    ['max_count', 0],
    ['max_count', -1],
    ['max_count', 1.5],
    ['max_count', Number.MAX_SAFE_INTEGER + 1],
    ['grace_minutes', MINUTE_MAX + 1],
    ['max_length_minutes', MINUTE_MAX + 1],
  ])('RSV-25 %s が %d なら INPUT_SETTING_VALUE で、何も書かず自動の変化も反映しない', async (key, value) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      const before = snapshot(state);

      const result = await sendAt(ledger, postReq(admin, { key, value }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_SETTING_VALUE');
      expect(snapshot(state)).toEqual(before);
    });
  });
});

describe('API 本文と Origin', () => {
  test.each([
    ['key がない', { value: 5 }],
    ['知らない key', { key: 'max', value: 5 }],
    ['key が数値', { key: 1, value: 5 }],
    ['value がない', { key: 'max_count' }],
    ['value が文字列', { key: 'max_count', value: '3' }],
    ['value が null', { key: 'max_count', value: null }],
  ])('API %s なら INPUT_BODY', async (_, payload) => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const before = snapshot(state);
      const result = await sendAt(ledger, postReq(admin, payload));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_BODY');
      expect(snapshot(state)).toEqual(before);
    });
  });

  test('API POST は Origin がないと AUTH_ORIGIN。GET は Origin を確かめない', async () => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      expect(codeOf(await sendAt(ledger, postReq(admin, { key: 'max_count', value: 5 }, { origin: null })))).toBe('AUTH_ORIGIN');
      expect((await sendAt(ledger, getReq(admin, { origin: null }))).status).toBe(200);
    });
  });
});

describe('ADM-1 管理者の証明', () => {
  const all = [
    ['GET', (options) => getReq(undefined, options)],
    ['POST', (options) => postReq(undefined, { key: 'max_count', value: 5 }, options)],
  ];

  test.each(all)('ADM-1 %s は利用者の Cookie だけでは AUTH_REQUIRED', async (_, makeReq) => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      expect(codeOf(await sendAt(ledger, makeReq({ user })))).toBe('AUTH_REQUIRED');
    });
  });

  test.each(all)('ADM-1 %s は管理者の証明を解いた後は AUTH_REVOKED', async (_, makeReq) => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      expect((await sendAt(ledger, req('POST', '/api/admin/logout', { body: {}, admin }))).status).toBe(200);
      expect(codeOf(await sendAt(ledger, makeReq({ admin })))).toBe('AUTH_REVOKED');
    });
  });
});

describe('RSV-23 ほぼ同時の変更', () => {
  test('RSV-23 2人の管理者が同じ数値を同時に変えると両方とも成功し、settings と events に2行ずつ。後の記録の before が先の値', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      const other = await secondAdmin(ledger);
      const before = settingRows(state).length;

      const results = await Promise.all([
        sendAt(ledger, postReq(admin, { key: 'max_count', value: 5 })),
        sendAt(ledger, postReq(other.cookie, { key: 'max_count', value: 7 })),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);

      const added = settingRows(state).slice(before);
      expect(added).toHaveLength(2);
      const changed = events(state, 'setting_changed');
      expect(changed).toHaveLength(2);
      const [first, second] = changed.map((e) => JSON.parse(e.detail));
      expect(first.before).toBe(3);
      expect(second.before).toBe(first.after);
      expect(added.map((r) => r.value)).toEqual([first.after, second.after]);
      expect((await sendAt(ledger, getReq(admin))).body.data.max_count).toBe(second.after);
      expect(changed.map((e) => e.actor_admin_id).sort()).toEqual([1, other.id].sort());
    });
  });
});

describe('RSV-21 見た時点で自動の変化が反映される', () => {
  test('RSV-21 GET でも、反映した自動の変化が残る', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      const id = insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });

      expect((await sendAt(ledger, getReq(admin))).status).toBe(200);
      expect(statusOf(state, id)).toBe('no_show');
      expect(events(state, 'reservation_status')).toHaveLength(1);
    });
  });
});

// 登録・ログイン・名前と期生の変更（api.md 8.15・8.17）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, withLedger } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';
const COOKIE_ATTRIBUTES = 'Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict';

// 速い計算の関数に差し替える（PBKDF2 はこの機能の対象ではない）
const routes = buildRoutes({ derivePassword: (password, salt) => sha256(`${password}:${[...salt].join(',')}`) });

// cookie は利用者の Cookie の値、admin は管理者の Cookie の値
function req(method, path, { body, cookie, admin, origin = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': '192.0.2.1' };
  if (origin !== null) headers.Origin = origin;
  const cookies = [];
  if (cookie !== undefined) cookies.push(`__Host-dxp_user=${cookie}`);
  if (admin !== undefined) cookies.push(`__Host-dxp_admin=${admin}`);
  if (cookies.length > 0) headers.Cookie = cookies.join('; ');
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const registerReq = (cookie, body, options = {}) => req('POST', '/api/me/register', { body, cookie, ...options });
const loginReq = (cookie, body, options = {}) => req('POST', '/api/me/login', { body, cookie, ...options });
const changeReq = (cookie, body, options = {}) => req('POST', '/api/me/change', { body, cookie, ...options });
const ALL_REQS = [
  ['登録', registerReq],
  ['ログイン', loginReq],
  ['変更', changeReq],
];

async function send(ledger, request, { at = T10 } = {}) {
  const response = await ledger.handle(request, fixedClock(at), routes);
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('Set-Cookie') };
}

const codeOf = (result) => result.body.error?.code;
const userTokenOf = (result) => /^__Host-dxp_user=([^;]*);/.exec(result.setCookie)[1];

async function setSharedInfo(ledger, admin) {
  const result = await send(ledger, req('POST', '/api/admin/shared-info', { body: {}, admin }));
  expect(result.status).toBe(200);
  return result.body.data.value;
}

async function startUser(ledger, k) {
  const started = await send(ledger, req('POST', '/api/session', { body: { k } }));
  expect(started.status).toBe(200);
  return userTokenOf(started);
}

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
  const k = await setSharedInfo(ledger, admin);
  return { admin, user: await startUser(ledger, k) };
}

const STUDENT = { role: 'student', student_id: '12345678', name: '山田', cohort: 12 };
const STUDENT_ID = { role: 'student', student_id: '12345678' };
const users = (state) => rows(state, 'SELECT * FROM users ORDER BY id');
const userEvents = (state) =>
  rows(state, "SELECT * FROM events WHERE kind IN ('user_created', 'user_renamed') ORDER BY id");

// 利用者の表と利用者の記録をまとめて写す（変わっていないことを確かめる）
const snapshot = (state) => JSON.stringify([users(state), userEvents(state)]);

describe('USR-3 登録（POST /api/me/register）', () => {
  test('USR-3 生徒で呼ぶと行が1つでき、data がそろえた値になる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(
        ledger,
        registerReq(user, { ...STUDENT, student_id: '１２３４５６７８', name: '  山田 　' }),
      );
      expect(result.status).toBe(200);
      const [row] = users(state);
      expect(result.body).toEqual({
        ok: true,
        data: { id: row.id, role: 'student', student_id: '12345678', name: '山田', cohort: 12 },
      });
      expect(users(state)).toHaveLength(1);
      expect(row).toMatchObject({ role: 'student', student_id: '12345678', name: '山田', cohort: 12 });
    });
  });

  test('USR-3 教員では cohort が null', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(ledger, registerReq(user, { role: 'teacher', student_id: 'Tanaka.T', name: '田中' }));
      expect(result.body.data).toMatchObject({ role: 'teacher', student_id: 'tanaka.t', name: '田中', cohort: null });
      expect(users(state)[0].cohort).toBeNull();
    });
  });

  test.each([
    ['名前・期生が同じ', STUDENT],
    ['名前・期生が違う', { ...STUDENT, name: '鈴木', cohort: 13 }],
  ])('USR-3 すでにいる組で、%s でも RULE_USER_DUPLICATE（409）で、行も events も変わらない', async (_, body) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);
      const result = await send(ledger, registerReq(user, body));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_USER_DUPLICATE');
      expect(snapshot(state)).toBe(before);
    });
  });
});

describe('USR-3 ログイン（POST /api/me/login）', () => {
  test('USR-3 登録した組で呼ぶと、data が登録の応答と同じ。表は変わらず、name・cohort を送っても読まない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const registered = await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);

      const result = await send(ledger, loginReq(user, STUDENT_ID));
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual(registered.body.data);

      const withProfile = await send(ledger, loginReq(user, { ...STUDENT_ID, name: '鈴木', cohort: 0 }));
      expect(withProfile.status).toBe(200);
      expect(withProfile.body.data).toEqual(registered.body.data);
      expect(snapshot(state)).toBe(before);
    });
  });

  test('USR-3 登録していない組では NOT_FOUND_USER（404）で、表が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(ledger, loginReq(user, STUDENT_ID));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_USER');
      expect(users(state)).toHaveLength(0);
      expect(userEvents(state)).toHaveLength(0);
    });
  });
});

describe('USR-4 識別の組のそろえ方', () => {
  test('USR-4 全角で登録した後に半角で登録すると RULE_USER_DUPLICATE。ログイン・変更は同じ行を引く', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, { ...STUDENT, student_id: '１２３４５６７８' }));
      expect(codeOf(await send(ledger, registerReq(user, STUDENT)))).toBe('RULE_USER_DUPLICATE');
      const [row] = users(state);
      expect((await send(ledger, loginReq(user, STUDENT_ID))).body.data.id).toBe(row.id);
      const changed = await send(ledger, changeReq(user, { ...STUDENT, student_id: '１２３４５６７８', name: '鈴木' }));
      expect(changed.body.data).toMatchObject({ id: row.id, name: '鈴木' });
      expect(users(state)).toHaveLength(1);
    });
  });

  test('USR-4 教員の Tanaka.T と tanaka.t は同じ利用者', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, { role: 'teacher', student_id: 'Tanaka.T', name: '田中' }));
      expect(
        codeOf(await send(ledger, registerReq(user, { role: 'teacher', student_id: 'tanaka.t', name: '田中' }))),
      ).toBe('RULE_USER_DUPLICATE');
      const login = await send(ledger, loginReq(user, { role: 'teacher', student_id: 'TANAKA.T' }));
      expect(login.body.data.student_id).toBe('tanaka.t');
      const changed = await send(ledger, changeReq(user, { role: 'teacher', student_id: 'tanaka.T', name: '田中一郎' }));
      expect(changed.body.data.name).toBe('田中一郎');
      expect(users(state)).toHaveLength(1);
    });
  });

  test('USR-4 00000001 は受け付け、生徒と教員の同じ番号は別の行', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(ledger, registerReq(user, { ...STUDENT, student_id: '00000001' }));
      expect(result.body.data.student_id).toBe('00000001');
      await send(ledger, registerReq(user, STUDENT));
      await send(ledger, registerReq(user, { role: 'teacher', student_id: '12345678', name: '山田' }));
      expect(users(state).map((u) => [u.role, u.student_id])).toEqual([
        ['student', '00000001'],
        ['student', '12345678'],
        ['teacher', '12345678'],
      ]);
    });
  });

  test.each(ALL_REQS)('USR-4 %s：0000001（7桁）と英字入りの生徒の番号は INPUT_STUDENT_ID', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);
      expect(codeOf(await send(ledger, makeReq(user, { ...STUDENT, student_id: '0000001' })))).toBe('INPUT_STUDENT_ID');
      expect(codeOf(await send(ledger, makeReq(user, { ...STUDENT, student_id: '1234567a' })))).toBe('INPUT_STUDENT_ID');
      expect(snapshot(state)).toBe(before);
    });
  });
});

describe('USR-5 名前', () => {
  test.each([
    ['空白だけ', ' 　 '],
    ['31文字', 'あ'.repeat(31)],
    ['改行入り', '山\n田'],
  ])('USR-5 登録・変更で名前が %s なら INPUT_NAME で、表が変わらない', async (_, name) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      expect(codeOf(await send(ledger, registerReq(user, { ...STUDENT, name })))).toBe('INPUT_NAME');
      expect(users(state)).toHaveLength(0);
      await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);
      expect(codeOf(await send(ledger, changeReq(user, { ...STUDENT, name })))).toBe('INPUT_NAME');
      expect(snapshot(state)).toBe(before);
    });
  });
});

describe('USR-6 期生', () => {
  test.each([
    ['ない', undefined],
    ['0', 0],
    ['1.5', 1.5],
    ['文字列', '1'],
  ])('USR-6 登録・変更で生徒の期生が %s なら INPUT_COHORT で、表が変わらない', async (_, cohort) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      expect(codeOf(await send(ledger, registerReq(user, { ...STUDENT, cohort })))).toBe('INPUT_COHORT');
      expect(users(state)).toHaveLength(0);
      await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);
      expect(codeOf(await send(ledger, changeReq(user, { ...STUDENT, cohort })))).toBe('INPUT_COHORT');
      expect(snapshot(state)).toBe(before);
    });
  });

  test.each([5, 'abc'])('USR-6 教員で期生に %j を送っても登録・変更で受け付け、NULL で保存される', async (cohort) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const teacher = { role: 'teacher', student_id: 't', name: '田中', cohort };
      const registered = await send(ledger, registerReq(user, teacher));
      expect(registered.body.data.cohort).toBeNull();
      const changed = await send(ledger, changeReq(user, { ...teacher, name: '田中一郎' }));
      expect(changed.body.data.cohort).toBeNull();
      expect(users(state)[0]).toMatchObject({ name: '田中一郎', cohort: null });
    });
  });
});

describe('USR-7 名前・期生の変更（POST /api/me/change）', () => {
  test('USR-7 同じ値では行も events も変わらず、応答はその行', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const registered = await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);
      const result = await send(ledger, changeReq(user, STUDENT));
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual(registered.body.data);
      expect(snapshot(state)).toBe(before);
    });
  });

  test('USR-7 名前だけ・期生だけの変更で上書きされ、user_renamed が1行ずつ、応答は新しい値', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT));
      const renamed = await send(ledger, changeReq(user, { ...STUDENT, name: '山田花子' }));
      expect(renamed.body.data).toMatchObject({ name: '山田花子', cohort: 12 });
      const recohorted = await send(ledger, changeReq(user, { ...STUDENT, name: '山田花子', cohort: 13 }));
      expect(recohorted.body.data).toMatchObject({ name: '山田花子', cohort: 13 });

      expect(users(state)).toHaveLength(1);
      expect(users(state)[0]).toMatchObject({ name: '山田花子', cohort: 13 });
      const events = userEvents(state);
      expect(events.map((e) => e.kind)).toEqual(['user_created', 'user_renamed', 'user_renamed']);
      expect(JSON.parse(events[0].detail)).toEqual({ name: '山田', cohort: 12 });
      expect(JSON.parse(events[1].detail)).toEqual({
        before: { name: '山田', cohort: 12 },
        after: { name: '山田花子', cohort: 12 },
      });
      expect(JSON.parse(events[2].detail)).toEqual({
        before: { name: '山田花子', cohort: 12 },
        after: { name: '山田花子', cohort: 13 },
      });
    });
  });

  test('USR-7 登録していない組では NOT_FOUND_USER で、行ができない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(ledger, changeReq(user, STUDENT));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_USER');
      expect(users(state)).toHaveLength(0);
      expect(userEvents(state)).toHaveLength(0);
    });
  });

  test('USR-7 段 1 で断った要求（名前は正しく期生が誤り）では、名前も置き換わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT));
      expect(codeOf(await send(ledger, changeReq(user, { ...STUDENT, name: '鈴木', cohort: 0 })))).toBe('INPUT_COHORT');
      expect(users(state)[0].name).toBe('山田');
      expect(userEvents(state)).toHaveLength(1);
    });
  });
});

describe('LOG-1 登録・変更の記録', () => {
  test('LOG-1 actor_kind は user、user_id は対象の利用者、at は切り捨てない時刻、detail に学籍番号がない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT), { at: T10 + 1234 });
      await send(ledger, changeReq(user, { ...STUDENT, name: '山田花子' }), { at: T10 + 5678 });
      const [row] = users(state);
      const events = userEvents(state);
      expect(events.map((e) => [e.kind, e.at])).toEqual([
        ['user_created', T10 + 1234],
        ['user_renamed', T10 + 5678],
      ]);
      expect(row.created_at).toBe(T10 + 1234);
      for (const event of events) {
        expect(event).toMatchObject({
          actor_kind: 'user',
          user_id: row.id,
          actor_admin_id: null,
          reservation_id: null,
          device_id: null,
          admin_id: null,
        });
        expect(event.detail).not.toContain('12345678');
      }
    });
  });
});

describe('ADM-3 共有された情報の設定し直し', () => {
  test.each(ALL_REQS)('ADM-3 %s：前の版で始めた証明では AUTH_REVOKED で、Set-Cookie が付かず、表が変わらない', async (_, makeReq) => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT));
      const before = snapshot(state);
      await setSharedInfo(ledger, admin);
      const result = await send(ledger, makeReq(user, { ...STUDENT, name: '鈴木' }));
      expect(codeOf(result)).toBe('AUTH_REVOKED');
      expect(result.setCookie).toBeNull();
      expect(snapshot(state)).toBe(before);
    });
  });
});

describe('USR-2 登録・ログイン・変更の認証', () => {
  test.each(ALL_REQS)('USR-2 %s：Cookie がないと AUTH_REQUIRED。本文が壊れていて Cookie もないと AUTH_REQUIRED', async (_, makeReq) => {
    await withLedger(async (ledger) => {
      await setup(ledger);
      expect(codeOf(await send(ledger, makeReq(undefined, STUDENT)))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, makeReq(undefined, '{')))).toBe('AUTH_REQUIRED');
    });
  });

  test.each(ALL_REQS)('USR-2 %s：Origin がないと AUTH_ORIGIN、管理者の Cookie だけでは AUTH_REQUIRED', async (_, makeReq) => {
    await withLedger(async (ledger) => {
      const { admin, user } = await setup(ledger);
      expect(codeOf(await send(ledger, makeReq(user, STUDENT, { origin: null })))).toBe('AUTH_ORIGIN');
      expect(codeOf(await send(ledger, makeReq(undefined, STUDENT, { admin })))).toBe('AUTH_REQUIRED');
    });
  });

  test('USR-2 成功にも、INPUT_*・NOT_FOUND_USER・RULE_USER_DUPLICATE で断る応答にも、受け取った値と同じ Set-Cookie が付く', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      const expected = `__Host-dxp_user=${user}; ${COOKIE_ATTRIBUTES}`;
      const cases = [
        [loginReq, STUDENT_ID, 'NOT_FOUND_USER'],
        [changeReq, STUDENT, 'NOT_FOUND_USER'],
        [registerReq, STUDENT, null],
        [registerReq, STUDENT, 'RULE_USER_DUPLICATE'],
        [loginReq, STUDENT_ID, null],
        [changeReq, STUDENT, null],
        [registerReq, '{', 'INPUT_BODY'],
        [registerReq, { ...STUDENT, name: 1 }, 'INPUT_BODY'],
        [registerReq, { role: 'student', name: '山田', cohort: 12 }, 'INPUT_BODY'],
        [loginReq, { role: 'student' }, 'INPUT_BODY'],
        [changeReq, { ...STUDENT_ID }, 'INPUT_BODY'],
        [registerReq, { ...STUDENT, role: 'admin' }, 'INPUT_ROLE'],
        [loginReq, { ...STUDENT_ID, student_id: '1' }, 'INPUT_STUDENT_ID'],
        [registerReq, { ...STUDENT, name: '' }, 'INPUT_NAME'],
        [changeReq, { ...STUDENT, cohort: 0 }, 'INPUT_COHORT'],
      ];
      for (const [makeReq, body, code] of cases) {
        const result = await send(ledger, makeReq(user, body));
        expect(codeOf(result) ?? null).toBe(code);
        expect(result.setCookie).toBe(expected);
      }
    });
  });

  test.each([
    ['登録', registerReq],
    ['変更', changeReq],
  ])('USR-3 %s：段 1 は role → student_id → name → cohort の順に確かめる', async (_, makeReq) => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      const allWrong = { role: 'x', student_id: '1', name: '', cohort: 0 };
      expect(codeOf(await send(ledger, makeReq(user, allWrong)))).toBe('INPUT_ROLE');
      expect(codeOf(await send(ledger, makeReq(user, { ...allWrong, role: 'student' })))).toBe('INPUT_STUDENT_ID');
      expect(codeOf(await send(ledger, makeReq(user, { ...allWrong, ...STUDENT_ID })))).toBe('INPUT_NAME');
      expect(codeOf(await send(ledger, makeReq(user, { ...allWrong, ...STUDENT_ID, name: '山田' })))).toBe(
        'INPUT_COHORT',
      );
    });
  });

  test('USR-3 ログイン：段 1 は role → student_id の順に確かめる', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      expect(codeOf(await send(ledger, loginReq(user, { role: 'x', student_id: '1' })))).toBe('INPUT_ROLE');
      expect(codeOf(await send(ledger, loginReq(user, { role: 'student', student_id: '1' })))).toBe('INPUT_STUDENT_ID');
    });
  });
});

describe('RSV-23 同時の登録・変更', () => {
  test('RSV-23 同じ組で2つ同時に登録すると、行は1つで、片方が成功し、もう片方は RULE_USER_DUPLICATE', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const results = await Promise.all([
        send(ledger, registerReq(user, { ...STUDENT, name: '山田' })),
        send(ledger, registerReq(user, { ...STUDENT, name: '鈴木' })),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'RULE_USER_DUPLICATE'].sort());
      expect(users(state)).toHaveLength(1);
      expect(userEvents(state).map((e) => e.kind)).toEqual(['user_created']);
      const winner = results.find((r) => r.status === 200);
      expect(users(state)[0].name).toBe(winner.body.data.name);
    });
  });

  test('RSV-23 同じ組で違う名前の変更を2つ同時に送ると、user_renamed が2行で、残る名前は後に処理された要求の値', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, registerReq(user, STUDENT));
      const results = await Promise.all([
        send(ledger, changeReq(user, { ...STUDENT, name: '佐藤' })),
        send(ledger, changeReq(user, { ...STUDENT, name: '鈴木' })),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const renamed = userEvents(state).filter((e) => e.kind === 'user_renamed');
      expect(renamed).toHaveLength(2);
      // どちらが後に処理されたかは記録の順で見分ける
      const [first, second] = renamed.map((e) => JSON.parse(e.detail));
      expect(first.before.name).toBe('山田');
      expect(second.before.name).toBe(first.after.name);
      expect(users(state)[0].name).toBe(second.after.name);
      expect(new Set([first.after.name, second.after.name])).toEqual(new Set(['佐藤', '鈴木']));
    });
  });
});

describe('RSV-21 登録・ログイン・変更と自動の変化', () => {
  const AT = T10 + 30 * MIN;
  const statuses = (state) => rows(state, 'SELECT status FROM reservations ORDER BY id').map((r) => r.status);
  // 開始時刻＋猶予を過ぎた予約済の予約を足す（利用者 1・機器 1）
  const addDue = (state) => insertReservation(state, { startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });

  async function prepare(ledger, state) {
    const { user } = await setup(ledger);
    await send(ledger, registerReq(user, STUDENT));
    state.storage.sql.exec("INSERT INTO devices (name, created_at) VALUES ('3Dプリンタ1', 0)");
    return user;
  }

  test.each([
    ['登録', registerReq, { ...STUDENT, student_id: '87654321' }],
    ['ログイン', loginReq, STUDENT_ID],
    ['変更（unchanged）', changeReq, STUDENT],
    ['変更（rename）', changeReq, { ...STUDENT, name: '山田花子' }],
  ])('RSV-21 %s が成功すると無断不使用になる', async (_, makeReq, body) => {
    await withLedger(async (ledger, state) => {
      const user = await prepare(ledger, state);
      addDue(state);
      expect((await send(ledger, makeReq(user, body), { at: AT })).status).toBe(200);
      expect(statuses(state)).toEqual(['no_show']);
    });
  });

  test.each([
    ['登録の RULE_USER_DUPLICATE', registerReq, STUDENT, 'RULE_USER_DUPLICATE'],
    ['ログインの NOT_FOUND_USER', loginReq, { ...STUDENT_ID, student_id: '87654321' }, 'NOT_FOUND_USER'],
    ['変更の NOT_FOUND_USER', changeReq, { ...STUDENT, student_id: '87654321' }, 'NOT_FOUND_USER'],
  ])('RSV-21 %s で断ったときも無断不使用になる', async (_, makeReq, body, code) => {
    await withLedger(async (ledger, state) => {
      const user = await prepare(ledger, state);
      addDue(state);
      expect(codeOf(await send(ledger, makeReq(user, body), { at: AT }))).toBe(code);
      expect(statuses(state)).toEqual(['no_show']);
    });
  });

  test.each([
    ['登録', registerReq, { ...STUDENT, cohort: 0 }, 'INPUT_COHORT'],
    ['ログイン', loginReq, { ...STUDENT_ID, role: 'x' }, 'INPUT_ROLE'],
    ['変更', changeReq, { ...STUDENT, name: '' }, 'INPUT_NAME'],
  ])('RSV-21 %s を段 1 で断ったときは変わらない', async (_, makeReq, body, code) => {
    await withLedger(async (ledger, state) => {
      const user = await prepare(ledger, state);
      addDue(state);
      expect(codeOf(await send(ledger, makeReq(user, body), { at: AT }))).toBe(code);
      expect(statuses(state)).toEqual(['reserved']);
    });
  });
});

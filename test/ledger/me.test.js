// 利用者の入力（api.md 8.15・8.17）
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

const meReq = (cookie, body, options = {}) => req('POST', '/api/me', { body, cookie, ...options });

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
const users = (state) => rows(state, 'SELECT * FROM users ORDER BY id');
const userEvents = (state) =>
  rows(state, "SELECT * FROM events WHERE kind IN ('user_created', 'user_renamed') ORDER BY id");

describe('USR-3 利用者の入力（POST /api/me）', () => {
  test('USR-3 生徒で呼ぶと行が1つでき、data がそろえた値になる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(ledger, meReq(user, { ...STUDENT, student_id: '１２３４５６７８', name: '  山田 　' }));
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
      const result = await send(ledger, meReq(user, { role: 'teacher', student_id: 'Tanaka.T', name: '田中' }));
      expect(result.body.data).toMatchObject({ role: 'teacher', student_id: 'tanaka.t', name: '田中', cohort: null });
      expect(users(state)[0].cohort).toBeNull();
    });
  });
});

describe('USR-4 識別の組のそろえ方', () => {
  test('USR-4 全角で作った後に半角で呼ぶと同じ行を引く。教員の大文字と小文字も同じ', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, meReq(user, { ...STUDENT, student_id: '１２３４５６７８' }));
      await send(ledger, meReq(user, STUDENT));
      await send(ledger, meReq(user, { role: 'teacher', student_id: 'Tanaka.T', name: '田中' }));
      await send(ledger, meReq(user, { role: 'teacher', student_id: 'tanaka.t', name: '田中' }));
      expect(users(state)).toHaveLength(2);
    });
  });

  test('USR-4 00000001 は受け付け、0000001 は INPUT_STUDENT_ID。生徒と教員の同じ番号は別の行', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      expect((await send(ledger, meReq(user, { ...STUDENT, student_id: '00000001' }))).body.data.student_id).toBe(
        '00000001',
      );
      expect(codeOf(await send(ledger, meReq(user, { ...STUDENT, student_id: '0000001' })))).toBe('INPUT_STUDENT_ID');
      expect(codeOf(await send(ledger, meReq(user, { ...STUDENT, student_id: '1234567a' })))).toBe('INPUT_STUDENT_ID');
      await send(ledger, meReq(user, STUDENT));
      await send(ledger, meReq(user, { role: 'teacher', student_id: '12345678', name: '山田' }));
      expect(users(state).map((u) => [u.role, u.student_id])).toEqual([
        ['student', '00000001'],
        ['student', '12345678'],
        ['teacher', '12345678'],
      ]);
    });
  });
});

describe('USR-5 名前', () => {
  test.each([
    ['空白だけ', ' 　 '],
    ['31文字', 'あ'.repeat(31)],
    ['改行入り', '山\n田'],
  ])('USR-5 %s なら INPUT_NAME で、表が変わらない', async (_, name) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      expect(codeOf(await send(ledger, meReq(user, { ...STUDENT, name })))).toBe('INPUT_NAME');
      expect(users(state)).toHaveLength(0);
      expect(userEvents(state)).toHaveLength(0);
    });
  });
});

describe('USR-6 期生', () => {
  test.each([
    ['ない', undefined],
    ['0', 0],
    ['1.5', 1.5],
    ['文字列', '1'],
  ])('USR-6 生徒で期生が %s なら INPUT_COHORT', async (_, cohort) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      expect(codeOf(await send(ledger, meReq(user, { ...STUDENT, cohort })))).toBe('INPUT_COHORT');
      expect(users(state)).toHaveLength(0);
    });
  });

  test.each([5, 'abc'])('USR-6 教員で期生に %j を送っても受け付け、NULL で保存される', async (cohort) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const result = await send(ledger, meReq(user, { role: 'teacher', student_id: 't', name: '田中', cohort }));
      expect(result.body.data.cohort).toBeNull();
      expect(users(state)[0].cohort).toBeNull();
    });
  });
});

describe('USR-7 名前・期生の置き換え', () => {
  test('USR-7 作ると user_created が1行。同じ値では増えず、名前だけ・期生だけの変更で上書きされ user_renamed が1行ずつ', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, meReq(user, STUDENT));
      await send(ledger, meReq(user, STUDENT));
      expect(users(state)).toHaveLength(1);
      expect(userEvents(state).map((e) => e.kind)).toEqual(['user_created']);
      expect(JSON.parse(userEvents(state)[0].detail)).toEqual({ name: '山田', cohort: 12 });

      await send(ledger, meReq(user, { ...STUDENT, name: '山田花子' }));
      await send(ledger, meReq(user, { ...STUDENT, name: '山田花子', cohort: 13 }));
      expect(users(state)).toHaveLength(1);
      expect(users(state)[0]).toMatchObject({ name: '山田花子', cohort: 13 });
      const events = userEvents(state);
      expect(events.map((e) => e.kind)).toEqual(['user_created', 'user_renamed', 'user_renamed']);
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

  test('USR-7 段 1 で断った要求（名前は正しく期生が誤り）では、名前も置き換わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, meReq(user, STUDENT));
      expect(codeOf(await send(ledger, meReq(user, { ...STUDENT, name: '鈴木', cohort: 0 })))).toBe('INPUT_COHORT');
      expect(users(state)[0].name).toBe('山田');
      expect(userEvents(state)).toHaveLength(1);
    });
  });
});

describe('LOG-1 利用者の入力の記録', () => {
  test('LOG-1 actor_kind は user、user_id は対象の利用者、at は切り捨てない時刻、detail に学籍番号がない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      await send(ledger, meReq(user, STUDENT), { at: T10 + 1234 });
      await send(ledger, meReq(user, { ...STUDENT, name: '山田花子' }), { at: T10 + 5678 });
      const [row] = users(state);
      const events = userEvents(state);
      expect(events.map((e) => e.at)).toEqual([T10 + 1234, T10 + 5678]);
      expect(users(state)[0].created_at).toBe(T10 + 1234);
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
  test('ADM-3 前の版で始めた証明では AUTH_REVOKED で、Set-Cookie が付かず、表が変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { admin, user } = await setup(ledger);
      await setSharedInfo(ledger, admin);
      const result = await send(ledger, meReq(user, STUDENT));
      expect(codeOf(result)).toBe('AUTH_REVOKED');
      expect(result.setCookie).toBeNull();
      expect(users(state)).toHaveLength(0);
    });
  });
});

describe('USR-2 利用者の入力の認証', () => {
  test('USR-2 Cookie がないと AUTH_REQUIRED。本文が壊れていて Cookie もないと AUTH_REQUIRED', async () => {
    await withLedger(async (ledger) => {
      await setup(ledger);
      expect(codeOf(await send(ledger, meReq(undefined, STUDENT)))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, meReq(undefined, '{')))).toBe('AUTH_REQUIRED');
    });
  });

  test('USR-2 Origin がないと AUTH_ORIGIN', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      expect(codeOf(await send(ledger, meReq(user, STUDENT, { origin: null })))).toBe('AUTH_ORIGIN');
    });
  });

  test('USR-2 管理者の Cookie だけでは AUTH_REQUIRED', async () => {
    await withLedger(async (ledger) => {
      const { admin } = await setup(ledger);
      expect(codeOf(await send(ledger, meReq(undefined, STUDENT, { admin })))).toBe('AUTH_REQUIRED');
    });
  });

  test('USR-2 成功にも、INPUT_BODY と段 1 で断る応答にも、受け取った値と同じ Set-Cookie が付く', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      const expected = `__Host-dxp_user=${user}; ${COOKIE_ATTRIBUTES}`;
      const cases = [
        [STUDENT, null],
        ['{', 'INPUT_BODY'],
        [{ ...STUDENT, name: 1 }, 'INPUT_BODY'],
        [{ role: 'student', name: '山田', cohort: 12 }, 'INPUT_BODY'],
        [{ ...STUDENT, role: 'admin' }, 'INPUT_ROLE'],
        [{ ...STUDENT, student_id: '1' }, 'INPUT_STUDENT_ID'],
        [{ ...STUDENT, name: '' }, 'INPUT_NAME'],
        [{ ...STUDENT, cohort: 0 }, 'INPUT_COHORT'],
      ];
      for (const [body, code] of cases) {
        const result = await send(ledger, meReq(user, body));
        expect(codeOf(result) ?? null).toBe(code);
        expect(result.setCookie).toBe(expected);
      }
    });
  });

  test('USR-3 段 1 は role → student_id → name → cohort の順に確かめる', async () => {
    await withLedger(async (ledger) => {
      const { user } = await setup(ledger);
      const allWrong = { role: 'x', student_id: '1', name: '', cohort: 0 };
      expect(codeOf(await send(ledger, meReq(user, allWrong)))).toBe('INPUT_ROLE');
      expect(codeOf(await send(ledger, meReq(user, { ...allWrong, role: 'student' })))).toBe('INPUT_STUDENT_ID');
      expect(codeOf(await send(ledger, meReq(user, { ...allWrong, ...STUDENT, name: '', cohort: 0 })))).toBe(
        'INPUT_NAME',
      );
    });
  });
});

describe('RSV-23 同時の利用者の入力', () => {
  test('RSV-23 同じ識別の組を違う名前で2つ同時に送ると、行は1つで、created と renamed が1行ずつ、残る名前は後の要求の値', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const results = await Promise.all([
        send(ledger, meReq(user, { ...STUDENT, name: '山田' })),
        send(ledger, meReq(user, { ...STUDENT, name: '鈴木' })),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(users(state)).toHaveLength(1);
      const [created, renamed] = userEvents(state);
      expect([created.kind, renamed.kind]).toEqual(['user_created', 'user_renamed']);
      // どちらが後に処理されたかは記録の順で見分ける
      const later = JSON.parse(renamed.detail).after.name;
      expect(JSON.parse(renamed.detail).before.name).toBe(JSON.parse(created.detail).name);
      expect(users(state)[0].name).toBe(later);
      expect(new Set([JSON.parse(created.detail).name, later])).toEqual(new Set(['山田', '鈴木']));
    });
  });
});

describe('RSV-21 利用者の入力と自動の変化', () => {
  test('RSV-21 段 1 で断ったときは変わらず、成功（unchanged を含む）すると無断不使用になる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      const AT = T10 + 30 * MIN;
      const statuses = () => rows(state, 'SELECT status FROM reservations ORDER BY id').map((r) => r.status);
      await send(ledger, meReq(user, STUDENT));
      state.storage.sql.exec("INSERT INTO devices (name, created_at) VALUES ('3Dプリンタ1', 0)");
      const addDue = () =>
        insertReservation(state, { startAt: T10 + 10 * MIN, endAt: T10 + 60 * MIN, status: 'reserved' });

      addDue();
      expect(codeOf(await send(ledger, meReq(user, { ...STUDENT, cohort: 0 }), { at: AT }))).toBe('INPUT_COHORT');
      expect(statuses()).toEqual(['reserved']);

      expect((await send(ledger, meReq(user, STUDENT), { at: AT })).status).toBe(200);
      expect(statuses()).toEqual(['no_show']);

      addDue();
      expect((await send(ledger, meReq(user, { ...STUDENT, name: '山田花子' }), { at: AT })).status).toBe(200);
      expect(statuses()).toEqual(['no_show', 'no_show']);
    });
  });
});

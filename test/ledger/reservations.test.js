// 予約状況・確保（api.md 8.24〜8.26）
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { SQL_DAY_RESERVATIONS } from '../../src/store/reservations.js';
import { MIN, ORIGIN, T10, fixedClock, insertReservation, rows, withLedger } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';
const H = 60 * MIN;
const DAY = '2026-11-20';
const DAY_START = Date.UTC(2026, 10, 19, 15, 0); // 2026-11-20T00:00（日本時間）

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

const dayReq = (user, deviceId = 1, date = DAY, options = {}) => {
  const query = date === null ? '' : `?date=${date}`;
  return req('GET', `/api/devices/${deviceId}/day${query}`, { user, ...options });
};
const reserveReq = (user, body, options = {}) => req('POST', '/api/reservations', { body, user, ...options });

async function send(ledger, request, { at = T10 } = {}) {
  const response = await ledger.handle(request, fixedClock(at), routes);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text), setCookie: response.headers.get('Set-Cookie') };
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
  return { admin, user };
}

// 機器2つ（1: 3Dプリンタ1、2: PC1）と利用者2人（1: 生徒 12345678 山田 12期、2: 教員 t-suzuki 鈴木）
function seed(state) {
  const sql = state.storage.sql;
  sql.exec("INSERT INTO devices (name, created_at) VALUES ('3Dプリンタ1', 0), ('PC1', 0)");
  sql.exec(
    `INSERT INTO users (role, student_id, name, cohort, created_at) VALUES
       ('student', '12345678', '山田', 12, 0),
       ('teacher', 't-suzuki', '鈴木', NULL, 0)`,
  );
}

const STUDENT = { role: 'student', student_id: '12345678' };
const TEACHER = { role: 'teacher', student_id: 't-suzuki' };

// 確保の本文。時刻は 2026-11-20 の日本時間の HH:mm
const body = (start, end, { deviceId = 1, who = STUDENT } = {}) => ({
  ...who,
  device_id: deviceId,
  start: `${DAY}T${start}`,
  end: `${DAY}T${end}`,
});

const reservations = (state) => rows(state, 'SELECT * FROM reservations ORDER BY id');
const events = (state, kind) => rows(state, 'SELECT * FROM events WHERE kind = ? ORDER BY id', kind);
const at = (hour, minute = 0) => DAY_START + hour * H + minute * MIN;

describe('RSV-2 確保', () => {
  test('RSV-2, RSV-5 確保すると reservations に1行でき、応答と記録がその値になる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, body('10:00', '11:00')), { at: T10 + 30_123 });
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({
        id: 1,
        device_id: 1,
        start: '2026-11-20T10:00',
        end: '2026-11-20T11:00',
        status: 'reserved',
      });
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);

      expect(reservations(state)).toEqual([
        {
          id: 1,
          device_id: 1,
          user_id: 1,
          start_at: at(10),
          end_at: at(11),
          status: 'reserved',
          cause: null,
          walk_in: 0,
          created_at: T10 + 30_123,
        },
      ]);
      const created = events(state, 'reservation_created');
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        at: T10 + 30_123,
        actor_kind: 'user',
        actor_admin_id: null,
        reservation_id: 1,
        device_id: 1,
        user_id: 1,
        admin_id: null,
      });
      expect(JSON.parse(created[0].detail)).toEqual({ start_at: at(10), end_at: at(11) });
    });
  });

  test('USR-4 全角の学籍番号でも、そろえて同じ利用者を引く', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, body('10:00', '11:00', { who: { role: 'student', student_id: '１２３４５６７８' } })));
      expect(result.status).toBe(200);
      expect(reservations(state)[0].user_id).toBe(1);
    });
  });

  test('USR-4 識別の組の利用者がいなければ NOT_FOUND_USER（404）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, body('10:00', '11:00', { who: { role: 'student', student_id: '99999999' } })));
      expect(result.status).toBe(404);
      expect(codeOf(result)).toBe('NOT_FOUND_USER');
      expect(reservations(state)).toEqual([]);
    });
  });

  test('MNG-1 ない機器・削除した機器への確保は NOT_FOUND_DEVICE（404）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec('UPDATE devices SET deleted_at = 1 WHERE id = 2');
      for (const deviceId of [2, 99]) {
        const result = await send(ledger, reserveReq(user, body('10:00', '11:00', { deviceId })));
        expect(result.status).toBe(404);
        expect(codeOf(result)).toBe('NOT_FOUND_DEVICE');
      }
      expect(reservations(state)).toEqual([]);
    });
  });
});

describe('RSV-3 重なり', () => {
  test('RSV-3 同じ機器の [10:00, 11:00) の後に [10:30, 11:30) は RULE_OVERLAP で、[11:00, 12:00) は成功（TIM-2）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00', { who: TEACHER })))).status).toBe(200);

      const overlap = await send(ledger, reserveReq(user, body('10:30', '11:30')));
      expect(overlap.status).toBe(409);
      expect(codeOf(overlap)).toBe('RULE_OVERLAP');
      expect(reservations(state)).toHaveLength(1);

      expect((await send(ledger, reserveReq(user, body('11:00', '12:00')))).status).toBe(200);
    });
  });

  test('RSV-3 同じ人でも断り、別の機器なら同じ人の同じ時間帯も成功', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00')))).status).toBe(200);
      expect(codeOf(await send(ledger, reserveReq(user, body('10:00', '11:00'))))).toBe('RULE_OVERLAP');
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00', { deviceId: 2 })))).status).toBe(200);
    });
  });
});

describe('RSV-4 件数の上限', () => {
  test('RSV-4 3件まで成功し、4件目は RULE_COUNT。予約なしの利用で始めた利用中は数えず、1件を取消にするとまた確保できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      // 予約なしの利用で始めた利用中（数えない）
      insertReservation(state, { deviceId: 2, startAt: T10, endAt: at(18), status: 'in_use', walkIn: 1 });
      for (const [start, end] of [
        ['11:00', '12:00'],
        ['12:00', '13:00'],
        ['13:00', '14:00'],
      ]) {
        expect((await send(ledger, reserveReq(user, body(start, end)))).status).toBe(200);
      }
      const fourth = await send(ledger, reserveReq(user, body('14:00', '15:00')));
      expect(fourth.status).toBe(409);
      expect(codeOf(fourth)).toBe('RULE_COUNT');

      state.storage.sql.exec("UPDATE reservations SET status = 'cancelled' WHERE id = 2");
      expect((await send(ledger, reserveReq(user, body('14:00', '15:00')))).status).toBe(200);
    });
  });
});

describe('RSV-6 長さの上限', () => {
  test('RSV-6 1440分は成功、1441分は RULE_LENGTH', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const ok = { ...STUDENT, device_id: 1, start: '2026-11-20T10:00', end: '2026-11-21T10:00' };
      expect((await send(ledger, reserveReq(user, ok))).status).toBe(200);
      const tooLong = { ...STUDENT, device_id: 2, start: '2026-11-20T10:00', end: '2026-11-21T10:01' };
      const result = await send(ledger, reserveReq(user, tooLong));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_LENGTH');
    });
  });

  test('RSV-6 数値の履歴に max_length_minutes = 60（effective_at が nowMin）を入れると61分を断る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec("INSERT INTO settings (key, value, effective_at) VALUES ('max_length_minutes', 60, ?)", T10);
      expect(codeOf(await send(ledger, reserveReq(user, body('10:00', '11:01'))))).toBe('RULE_LENGTH');
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00')))).status).toBe(200);
    });
  });
});

describe('TIM-6 TIM-7 時刻の条件', () => {
  test('TIM-6 時計が 10:00:30 で開始 10:00 は成功', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00')), { at: T10 + 30_000 })).status).toBe(200);
    });
  });

  test('TIM-6 開始が1分前、終了がちょうど nowMin は RULE_PAST', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, body('09:59', '10:00')), { at: T10 + 30_000 });
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_PAST');
    });
  });

  test('TIM-7 終了 = 開始は RULE_TIME_ORDER', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, body('11:00', '11:00')));
      expect(result.status).toBe(409);
      expect(codeOf(result)).toBe('RULE_TIME_ORDER');
    });
  });
});

describe('TIM-3 入力の形式', () => {
  test.each(['2026-11-20T10:00:00', '2026-02-30T10:00'])('TIM-3 start が %s なら INPUT_TIME（400）', async (start) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, { ...body('10:00', '11:00'), start }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_TIME');
    });
  });

  test.each([
    ['start が数値', { start: 1 }],
    ['device_id が "1"', { device_id: '1' }],
    ['device_id が 1.5', { device_id: 1.5 }],
    ['device_id が 0', { device_id: 0 }],
    ['device_id がない', { device_id: undefined }],
  ])('TIM-3 %s なら INPUT_BODY', async (_, change) => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const result = await send(ledger, reserveReq(user, { ...body('10:00', '11:00'), ...change }));
      expect(result.status).toBe(400);
      expect(codeOf(result)).toBe('INPUT_BODY');
    });
  });

  test('USR-4 確かめる順は INPUT_ROLE → INPUT_STUDENT_ID → INPUT_TIME', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const bad = { ...body('10:00', '11:00'), start: 'x' };
      expect(codeOf(await send(ledger, reserveReq(user, { ...bad, role: 'x', student_id: 'x' })))).toBe('INPUT_ROLE');
      expect(codeOf(await send(ledger, reserveReq(user, { ...bad, student_id: 'x' })))).toBe('INPUT_STUDENT_ID');
      expect(codeOf(await send(ledger, reserveReq(user, bad)))).toBe('INPUT_TIME');
    });
  });
});

describe('RSV-23 ほぼ同時の確保', () => {
  test('RSV-23 同じ機器の重なる時間帯を2つ同時に送ると、1つが成功し、もう1つが RULE_OVERLAP', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      const results = await Promise.all([
        send(ledger, reserveReq(user, body('10:00', '11:00'))),
        send(ledger, reserveReq(user, body('10:30', '11:30', { who: TEACHER }))),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'RULE_OVERLAP'].sort());
      expect(reservations(state)).toHaveLength(1);
    });
  });

  test('RSV-23 上限 − 1 件の利用者が別の機器を2つ同時に送ると、1つが成功し、もう1つが RULE_COUNT', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec("INSERT INTO devices (name, created_at) VALUES ('PC2', 0)");
      insertReservation(state, { deviceId: 3, startAt: at(15), endAt: at(16), status: 'reserved' });
      insertReservation(state, { deviceId: 3, startAt: at(16), endAt: at(17), status: 'reserved' });
      const results = await Promise.all([
        send(ledger, reserveReq(user, body('10:00', '11:00', { deviceId: 1 }))),
        send(ledger, reserveReq(user, body('10:00', '11:00', { deviceId: 2 }))),
      ]);
      expect(results.map((r) => codeOf(r) ?? null).sort()).toEqual([null, 'RULE_COUNT'].sort());
      expect(reservations(state)).toHaveLength(3);
    });
  });
});

describe('RSV-22 自動の変化が先', () => {
  test('RSV-22 終了時刻がちょうど nowMin の利用中がある機器で、その時刻から始まる確保が成功し、先の予約は終了', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { userId: 2, startAt: at(9), endAt: T10, status: 'in_use' });
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00')))).status).toBe(200);
      expect(reservations(state)[0].status).toBe('finished');
      const status = events(state, 'reservation_status');
      expect(status).toHaveLength(1);
      expect(status[0]).toMatchObject({ actor_kind: 'auto', at: T10, reservation_id: 1 });
    });
  });

  test('RSV-22 開始時刻＋猶予がちょうど nowMin の予約済は無断不使用になり、件数に数えず、その時間帯も確保できる', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec("INSERT INTO settings (key, value, effective_at) VALUES ('max_count', 1, 0)");
      // 猶予15分。9:45 開始の予約は 10:00 に無断不使用
      insertReservation(state, { startAt: at(9, 45), endAt: at(11), status: 'reserved' });
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00')))).status).toBe(200);
      expect(reservations(state)[0].status).toBe('no_show');
    });
  });
});

describe('RSV-21 断っても反映した自動の変化は残る', () => {
  test('RSV-21 段 2 以降で断った確保と予約状況でも、反映した自動の変化が残る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: T10, status: 'in_use' });
      expect(codeOf(await send(ledger, reserveReq(user, body('09:00', '10:30'))))).toBe('RULE_PAST');
      expect(reservations(state)[0].status).toBe('finished');

      insertReservation(state, { startAt: at(9), endAt: T10, status: 'in_use' });
      expect(codeOf(await send(ledger, dayReq(user, 99)))).toBe('NOT_FOUND_DEVICE');
      expect(reservations(state)[1].status).toBe('finished');
    });
  });

  test('RSV-21 段 1 で断ったときは変わらない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(9), endAt: T10, status: 'in_use' });
      expect(codeOf(await send(ledger, reserveReq(user, { ...body('10:00', '11:00'), start: 'x' })))).toBe('INPUT_TIME');
      expect(codeOf(await send(ledger, dayReq(user, 1, '2026-11-31')))).toBe('INPUT_DATE');
      expect(reservations(state)[0].status).toBe('in_use');
      expect(events(state, 'reservation_status')).toEqual([]);
    });
  });
});

describe('VIW-1 予約状況', () => {
  test('VIW-1 予約済・利用中・終了・管理者による終了が開始時刻の順で出て、取消・無断不使用・管理者による取消は出ない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      // 自動の変化が起きないよう、すべて先の時刻か終わった状態にする
      insertReservation(state, { startAt: at(15), endAt: at(16), status: 'reserved' });
      insertReservation(state, { startAt: at(8), endAt: at(9), status: 'finished' });
      insertReservation(state, { userId: 2, startAt: at(9, 30), endAt: at(12), status: 'in_use' });
      insertReservation(state, { startAt: at(7), endAt: at(7, 30), status: 'admin_finished' });
      insertReservation(state, { startAt: at(13), endAt: at(14), status: 'cancelled' });
      insertReservation(state, { startAt: at(6), endAt: at(7), status: 'no_show' });
      insertReservation(state, { startAt: at(17), endAt: at(18), status: 'admin_cancelled' });
      insertReservation(state, { deviceId: 2, startAt: at(15), endAt: at(16), status: 'reserved' }); // 別の機器

      const result = await send(ledger, dayReq(user), { at: T10 + 45_000 });
      expect(result.status).toBe(200);
      expect(result.setCookie).toMatch(/^__Host-dxp_user=/);
      expect(result.body.data).toEqual({
        date: DAY,
        now: '2026-11-20T10:00',
        slots: [
          { start: '2026-11-20T07:00', end: '2026-11-20T07:30', status: 'admin_finished', user_id: 1, name: '山田', cohort: 12 },
          { start: '2026-11-20T08:00', end: '2026-11-20T09:00', status: 'finished', user_id: 1, name: '山田', cohort: 12 },
          { start: '2026-11-20T09:30', end: '2026-11-20T12:00', status: 'in_use', user_id: 2, name: '鈴木', cohort: null },
          { start: '2026-11-20T15:00', end: '2026-11-20T16:00', status: 'reserved', user_id: 1, name: '山田', cohort: 12 },
        ],
      });
    });
  });

  test('VIW-1 日をまたぐ予約は両方の日に出る。長さ0の終了は開始時刻を含む日にだけ出る。0:00 に終わる予約は次の日に出ない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      insertReservation(state, { startAt: at(23), endAt: at(25), status: 'reserved' }); // 11-20 23:00〜11-21 1:00
      insertReservation(state, { startAt: at(20), endAt: at(24), status: 'reserved' }); // 11-21 0:00 に終わる
      insertReservation(state, { startAt: at(24), endAt: at(24), status: 'finished' }); // 長さ0、11-21 0:00
      const starts = async (date) =>
        (await send(ledger, dayReq(user, 1, date))).body.data.slots.map((s) => `${s.start}~${s.end}`);
      expect(await starts('2026-11-20')).toEqual(['2026-11-20T20:00~2026-11-21T00:00', '2026-11-20T23:00~2026-11-21T01:00']);
      expect(await starts('2026-11-21')).toEqual(['2026-11-20T23:00~2026-11-21T01:00', '2026-11-21T00:00~2026-11-21T00:00']);
    });
  });

  test('VIW-1 終了は利用した時間帯の終わりで出る', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      // 利用中の 9:00〜10:00 は nowMin = 10:00 で自動で終了になる
      insertReservation(state, { startAt: at(9), endAt: T10, status: 'in_use' });
      const slots = (await send(ledger, dayReq(user))).body.data.slots;
      expect(slots).toEqual([
        { start: '2026-11-20T09:00', end: '2026-11-20T10:00', status: 'finished', user_id: 1, name: '山田', cohort: 12 },
      ]);
    });
  });

  test('VIW-1 予約がなければ slots は空の配列', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, dayReq(user))).body.data).toEqual({ date: DAY, now: '2026-11-20T10:00', slots: [] });
    });
  });

  test('VIW-1 date がない、2026-11-31 なら INPUT_DATE（400）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      for (const date of [null, '2026-11-31']) {
        const result = await send(ledger, dayReq(user, 1, date));
        expect(result.status).toBe(400);
        expect(codeOf(result)).toBe('INPUT_DATE');
      }
    });
  });

  test('VIW-1 ない機器・削除した機器は NOT_FOUND_DEVICE', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      state.storage.sql.exec('UPDATE devices SET deleted_at = 1 WHERE id = 2');
      for (const deviceId of [2, 99]) {
        const result = await send(ledger, dayReq(user, deviceId));
        expect(result.status).toBe(404);
        expect(codeOf(result)).toBe('NOT_FOUND_DEVICE');
      }
    });
  });

  test('VIW-1 {id} が正の整数の形でなければ NOT_FOUND_API', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, dayReq(user, '01')))).toBe('NOT_FOUND_API');
    });
  });

  test('VIW-1 予約状況の SQL は reservations_device_end を使う', async () => {
    await withLedger(async (_ledger, state) => {
      const plan = rows(state, `EXPLAIN QUERY PLAN ${SQL_DAY_RESERVATIONS}`, 1, DAY_START, DAY_START + 24 * H)
        .map((r) => r.detail)
        .join('\n');
      expect(plan).toContain('reservations_device_end');
    });
  });
});

describe('VIW-2 予約状況に学籍番号を含めない', () => {
  test('VIW-2 応答の本文にどの利用者の学籍番号も含まれず、名前・期生は変更の後の現在の値', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect((await send(ledger, reserveReq(user, body('10:00', '11:00')))).status).toBe(200);
      expect((await send(ledger, reserveReq(user, body('11:00', '12:00', { who: TEACHER })))).status).toBe(200);
      const changed = await send(
        ledger,
        req('POST', '/api/me/change', { body: { ...STUDENT, name: '山田花子', cohort: 13 }, user }),
      );
      expect(changed.status).toBe(200);

      const result = await send(ledger, dayReq(user));
      expect(result.text).not.toContain('12345678');
      expect(result.text).not.toContain('t-suzuki');
      expect(result.text).not.toContain('student_id');
      expect(result.text).not.toContain('teacher');
      expect(result.body.data.slots.map((s) => [s.name, s.cohort])).toEqual([
        ['山田花子', 13],
        ['鈴木', null],
      ]);
    });
  });
});

describe('USR-2 認証', () => {
  test('USR-2 Cookie がないと AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, dayReq(undefined)))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, reserveReq(undefined, body('10:00', '11:00'))))).toBe('AUTH_REQUIRED');
    });
  });

  test('ADM-1 管理者の Cookie だけでも AUTH_REQUIRED', async () => {
    await withLedger(async (ledger, state) => {
      const { admin } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, dayReq(undefined, 1, DAY, { admin })))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, reserveReq(undefined, body('10:00', '11:00'), { admin })))).toBe('AUTH_REQUIRED');
    });
  });

  test('USR-2 確保で Origin がないと AUTH_ORIGIN。予約状況（GET）は Origin を確かめない', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, reserveReq(user, body('10:00', '11:00'), { origin: null })))).toBe('AUTH_ORIGIN');
      expect((await send(ledger, dayReq(user, 1, DAY, { origin: null }))).status).toBe(200);
    });
  });

  test('API 確保で本文が壊れていて Cookie もないと AUTH_REQUIRED（認証が先）', async () => {
    await withLedger(async (ledger, state) => {
      const { user } = await setup(ledger);
      seed(state);
      expect(codeOf(await send(ledger, reserveReq(undefined, '{broken')))).toBe('AUTH_REQUIRED');
      expect(codeOf(await send(ledger, reserveReq(user, '{broken')))).toBe('INPUT_BODY');
    });
  });
});

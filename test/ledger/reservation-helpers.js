// 利用者の予約の操作の台帳の層のテストで共通に使う道具（予約状況・確保・予約なしの利用）
import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { buildRoutes } from '../../src/api/routes.js';
import { sha256 } from '../../src/lib/hash.js';
import { MIN, ORIGIN, T10, fixedClock, rows } from './helpers.js';

const PASSWORD = 'Correct-Horse-Battery-01';
export const H = 60 * MIN;
export const DAY = '2026-11-20';
export const DAY_START = Date.UTC(2026, 10, 19, 15, 0); // 2026-11-20T00:00（日本時間）

// 速い計算の関数に差し替える（PBKDF2 はこの機能の対象ではない）
const routes = buildRoutes({ derivePassword: (password, salt) => sha256(`${password}:${[...salt].join(',')}`) });

export function req(method, path, { body, user, admin, origin = ORIGIN } = {}) {
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

export const dayReq = (user, deviceId = 1, date = DAY, options = {}) => {
  const query = date === null ? '' : `?date=${date}`;
  return req('GET', `/api/devices/${deviceId}/day${query}`, { user, ...options });
};
export const reserveReq = (user, body, options = {}) => req('POST', '/api/reservations', { body, user, ...options });

export async function send(ledger, request, { at = T10 } = {}) {
  const response = await ledger.handle(request, fixedClock(at), routes);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text), setCookie: response.headers.get('Set-Cookie') };
}

export const codeOf = (result) => result.body.error?.code;

// 管理者を作って認証し、共有された情報を設定し、利用を始める
export async function setup(ledger) {
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
export function seed(state) {
  const sql = state.storage.sql;
  sql.exec("INSERT INTO devices (name, created_at) VALUES ('3Dプリンタ1', 0), ('PC1', 0)");
  sql.exec(
    `INSERT INTO users (role, student_id, name, cohort, created_at) VALUES
       ('student', '12345678', '山田', 12, 0),
       ('teacher', 't-suzuki', '鈴木', NULL, 0)`,
  );
}

export const STUDENT = { role: 'student', student_id: '12345678' };
export const TEACHER = { role: 'teacher', student_id: 't-suzuki' };

// 確保の本文。時刻は 2026-11-20 の日本時間の HH:mm
export const body = (start, end, { deviceId = 1, who = STUDENT } = {}) => ({
  ...who,
  device_id: deviceId,
  start: `${DAY}T${start}`,
  end: `${DAY}T${end}`,
});

export const reservations = (state) => rows(state, 'SELECT * FROM reservations ORDER BY id');
export const events = (state, kind) => rows(state, 'SELECT * FROM events WHERE kind = ? ORDER BY id', kind);
export const at = (hour, minute = 0) => DAY_START + hour * H + minute * MIN;

// 台帳の層のテストの道具
import { env, runInDurableObject } from 'cloudflare:test';

export const ORIGIN = 'https://dxplace.example.test';
export const T10 = Date.UTC(2026, 10, 20, 1, 0); // 2026-11-20T10:00（日本時間）
export const MIN = 60_000;

// テストごとに空の台帳を作り、その中で fn(instance, state) を動かす
export function withLedger(fn) {
  const stub = env.LEDGER.get(env.LEDGER.newUniqueId());
  return runInDurableObject(stub, fn);
}

// 要求を作る。headers の既定は同じサイトの Origin
export function request(method, path, { body, headers = { Origin: ORIGIN } } = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

// 一定の時刻を返す時計と、呼ばれた回数
export function fixedClock(ms) {
  const clock = () => {
    clock.calls += 1;
    return ms;
  };
  clock.calls = 0;
  return clock;
}

export function rows(state, query, ...bindings) {
  return state.storage.sql.exec(query, ...bindings).toArray();
}

// 予約の前提になる機器と利用者を1つずつ作り、番号を返す
export function seedDeviceAndUser(state) {
  const sql = state.storage.sql;
  sql.exec("INSERT INTO devices (name, created_at) VALUES ('3Dプリンタ1', 0)");
  sql.exec("INSERT INTO users (role, student_id, name, cohort, created_at) VALUES ('student', 's001', '山田', 30, 0)");
  return { deviceId: 1, userId: 1 };
}

export function insertReservation(state, { deviceId = 1, userId = 1, startAt, endAt, status, walkIn = 0 }) {
  state.storage.sql.exec(
    `INSERT INTO reservations (device_id, user_id, start_at, end_at, status, cause, walk_in, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 0)`,
    deviceId,
    userId,
    startAt,
    endAt,
    status,
    walkIn,
  );
  return state.storage.sql.exec('SELECT last_insert_rowid() AS id').one().id;
}

import { describe, expect, test } from 'vitest';
import { MIGRATIONS, applyMigrations } from '../../src/store/migrations.js';
import { SQL_TRANSITION_CANDIDATES } from '../../src/store/reservations.js';
import { MIN, T10, insertReservation, rows, seedDeviceAndUser, withLedger } from './helpers.js';

const TABLES = [
  'admin_sessions',
  'admins',
  'auth_failures',
  'devices',
  'events',
  'reservations',
  'schema_migrations',
  'settings',
  'shared_infos',
  'user_sessions',
  'users',
];

const INDEXES = [
  'devices_name_current',
  'events_at',
  'events_device_at',
  'events_user_at',
  'reservations_device_end',
  'reservations_device_status',
  'reservations_status_start',
  'reservations_user_status',
];

function names(state, type) {
  return rows(state, "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name", type).map(
    (r) => r.name,
  );
}

function countAll(state) {
  return Object.fromEntries(TABLES.map((t) => [t, rows(state, `SELECT COUNT(*) AS n FROM ${t}`)[0].n]));
}

describe('SCHEMA 版の適用（schema.md 5）', () => {
  test('SCHEMA 空の台帳から最新の版まで：すべての表と索引ができ、初期値の3行と全部の版がある', async () => {
    await withLedger(async (_, state) => {
      expect(names(state, 'table')).toEqual(TABLES);
      expect(names(state, 'index')).toEqual(INDEXES);
      expect(rows(state, 'SELECT key, value, effective_at FROM settings ORDER BY id')).toEqual([
        { key: 'max_count', value: 3, effective_at: 0 },
        { key: 'grace_minutes', value: 15, effective_at: 0 },
        { key: 'max_length_minutes', value: 1440, effective_at: 0 },
      ]);
      expect(rows(state, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual(
        MIGRATIONS.map((m) => m.version),
      );
    });
  });

  test('SCHEMA 2回目の起動：何も適用せず、行が増えない', async () => {
    await withLedger(async (_, state) => {
      const before = countAll(state);
      const applied = rows(state, 'SELECT * FROM schema_migrations');
      applyMigrations(state.storage, T10);
      expect(countAll(state)).toEqual(before);
      expect(rows(state, 'SELECT * FROM schema_migrations')).toEqual(applied);
    });
  });

  test('SCHEMA 1つ前の版から最新の版まで：前の版の表と行が残ったまま、足りない版だけが適用される', async () => {
    await withLedger(async (_, state) => {
      seedDeviceAndUser(state);
      const next = { version: MIGRATIONS.length + 1, statements: ['CREATE TABLE schema_test_extra (id INTEGER PRIMARY KEY) STRICT'] };

      applyMigrations(state.storage, T10, [...MIGRATIONS, next]);

      expect(names(state, 'table')).toContain('schema_test_extra');
      expect(rows(state, 'SELECT name FROM devices')).toEqual([{ name: '3Dプリンタ1' }]);
      expect(rows(state, 'SELECT COUNT(*) AS n FROM settings')[0].n).toBe(3);
      const versions = rows(state, 'SELECT version, applied_at FROM schema_migrations ORDER BY version');
      expect(versions.map((r) => r.version)).toEqual([...MIGRATIONS.map((m) => m.version), next.version]);
      expect(versions.at(-1).applied_at).toBe(T10);
    });
  });

  test('SCHEMA 途中で失敗した版は取り消され、例外はそのまま外に出る', async () => {
    await withLedger(async (_, state) => {
      const broken = {
        version: MIGRATIONS.length + 1,
        statements: ['CREATE TABLE schema_test_broken (id INTEGER PRIMARY KEY) STRICT', 'THIS IS NOT SQL'],
      };

      expect(() => applyMigrations(state.storage, T10, [...MIGRATIONS, broken])).toThrow();

      expect(names(state, 'table')).not.toContain('schema_test_broken');
      expect(rows(state, 'SELECT MAX(version) AS v FROM schema_migrations')[0].v).toBe(MIGRATIONS.length);
    });
  });
});

describe('SCHEMA 表の決まり（schema.md 1）', () => {
  test('SCHEMA 外部キー：存在しない機器・利用者の番号で予約を入れると断られる', async () => {
    await withLedger(async (_, state) => {
      expect(() => insertReservation(state, { deviceId: 99, userId: 99, startAt: T10, endAt: T10 + 60 * MIN, status: 'reserved' })).toThrow(
        /FOREIGN KEY/i,
      );
      expect(rows(state, 'SELECT COUNT(*) AS n FROM reservations')[0].n).toBe(0);
    });
  });

  test('SCHEMA STRICT：数値の列に文字列を入れると断られる', async () => {
    await withLedger(async (_, state) => {
      expect(() => state.storage.sql.exec("INSERT INTO settings (key, value, effective_at) VALUES ('max_count', 'three', 0)")).toThrow();
    });
  });

  test('SCHEMA 索引：自動の変化の反映で引く予約は reservations_status_start を使う', async () => {
    await withLedger(async (_, state) => {
      seedDeviceAndUser(state);
      const statuses = ['reserved', 'in_use', 'cancelled', 'no_show', 'finished'];
      for (let i = 0; i < 200; i++) {
        insertReservation(state, { startAt: T10 + i * 60 * MIN, endAt: T10 + (i * 60 + 30) * MIN, status: statuses[i % statuses.length] });
      }
      const plan = rows(state, `EXPLAIN QUERY PLAN ${SQL_TRANSITION_CANDIDATES}`, T10).map((r) => r.detail).join('\n');
      expect(plan).toContain('reservations_status_start');
    });
  });
});

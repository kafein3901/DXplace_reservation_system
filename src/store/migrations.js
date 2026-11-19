// スキーマの版と適用（docs/design/detailed/schema.md 2〜5、docs/design/basic/architecture.md 7）
//
// 版は古い順に並べる。1つの版は { version, statements }。
// 決まり（schema.md 5.3）：
//   - 版を足すときは、表・列・索引を足す SQL だけを書く。既存の列を消す・名前を変える・意味を変える SQL は書かない
//   - 適用済みの版の中身は書き換えない。直したいときは次の版を足す
//   - 列を足すときは、NULL を許すか既定値を付ける
export const MIGRATIONS = [
  {
    // 版 1：schema.md 2 の表と 3 の索引、4 の初期データ。
    // schema_migrations（2.11）は、版を読む前に applyMigrations が作る
    version: 1,
    statements: [
      // 2.1 利用者（USR-3〜USR-7）
      `CREATE TABLE users (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        role        TEXT    NOT NULL,
        student_id  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        cohort      INTEGER,
        created_at  INTEGER NOT NULL,
        UNIQUE (role, student_id)
      ) STRICT`,

      // 2.2 機器（MNG-1, MNG-2）
      `CREATE TABLE devices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      ) STRICT`,
      `CREATE UNIQUE INDEX devices_name_current ON devices (name) WHERE deleted_at IS NULL`,

      // 2.3 予約（RSV-1〜RSV-20, MNG-2, MNG-3）
      `CREATE TABLE reservations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   INTEGER NOT NULL REFERENCES devices (id),
        user_id     INTEGER NOT NULL REFERENCES users (id),
        start_at    INTEGER NOT NULL,
        end_at      INTEGER NOT NULL,
        status      TEXT    NOT NULL,
        cause       TEXT,
        walk_in     INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX reservations_status_start ON reservations (status, start_at)`,
      `CREATE INDEX reservations_device_status ON reservations (device_id, status)`,
      `CREATE INDEX reservations_user_status ON reservations (user_id, status)`,
      `CREATE INDEX reservations_device_end ON reservations (device_id, end_at)`,

      // 2.4 数値の履歴（RSV-25, RSV-26）
      `CREATE TABLE settings (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        key           TEXT    NOT NULL,
        value         INTEGER NOT NULL,
        effective_at  INTEGER NOT NULL
      ) STRICT`,

      // 2.5 管理者（ADM-2）
      `CREATE TABLE admins (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        login_id             TEXT    NOT NULL UNIQUE,
        display_name         TEXT    NOT NULL,
        password_hash        BLOB    NOT NULL,
        password_salt        BLOB    NOT NULL,
        password_iterations  INTEGER NOT NULL,
        password_version     INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        deleted_at           INTEGER
      ) STRICT`,

      // 2.6 共有された情報（ADM-3）
      `CREATE TABLE shared_infos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        hash        BLOB    NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT`,

      // 2.7 利用を始めた証明（USR-2）
      `CREATE TABLE user_sessions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash      BLOB    NOT NULL UNIQUE,
        shared_info_id  INTEGER NOT NULL REFERENCES shared_infos (id),
        created_at      INTEGER NOT NULL
      ) STRICT`,

      // 2.8 管理者の認証（ADM-2）
      `CREATE TABLE admin_sessions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash        BLOB    NOT NULL UNIQUE,
        admin_id          INTEGER NOT NULL REFERENCES admins (id),
        password_version  INTEGER NOT NULL,
        created_at        INTEGER NOT NULL,
        ended_at          INTEGER
      ) STRICT`,

      // 2.9 出来事の記録（LOG-1〜LOG-5）
      `CREATE TABLE events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        at              INTEGER NOT NULL,
        actor_kind      TEXT    NOT NULL,
        actor_admin_id  INTEGER REFERENCES admins (id),
        kind            TEXT    NOT NULL,
        reservation_id  INTEGER REFERENCES reservations (id),
        device_id       INTEGER REFERENCES devices (id),
        user_id         INTEGER REFERENCES users (id),
        admin_id        INTEGER REFERENCES admins (id),
        detail          TEXT    NOT NULL
      ) STRICT`,
      `CREATE INDEX events_at ON events (at)`,
      `CREATE INDEX events_device_at ON events (device_id, at)`,
      `CREATE INDEX events_user_at ON events (user_id, at)`,

      // 2.10 認証の失敗（SEC-3、LOG-4）
      `CREATE TABLE auth_failures (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        entry                    TEXT    NOT NULL,
        client                   TEXT    NOT NULL,
        window_start             INTEGER NOT NULL,
        failures                 INTEGER NOT NULL,
        unknown_id_failures      INTEGER NOT NULL,
        wrong_password_failures  INTEGER NOT NULL,
        last_login_id            TEXT,
        first_at                 INTEGER NOT NULL,
        last_at                  INTEGER NOT NULL,
        UNIQUE (entry, client, window_start)
      ) STRICT`,

      // 4 初期データ。effective_at を 0 にして、どの時刻で引いても値が見つかるようにする
      `INSERT INTO settings (key, value, effective_at) VALUES
        ('max_count', 3, 0),
        ('grace_minutes', 15, 0),
        ('max_length_minutes', 1440, 0)`,
    ],
  },
];

// 足りない版を古い順に1つずつ適用する（schema.md 5.2）。台帳の constructor が blockConcurrencyWhile の中で呼ぶ。
// now は適用した時刻。migrations はテストが版を足した一覧を渡すためにある。
// 途中で失敗した版はトランザクションで取り消され、例外はそのまま外に出る
export function applyMigrations(storage, now, migrations = MIGRATIONS) {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL
  ) STRICT`);

  const current = sql.exec('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').one().version;

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    storage.transactionSync(() => {
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', migration.version, now);
    });
  }
}

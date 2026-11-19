# 表の定義

- 状態：決定
- 日付：2026-11-19
- 関係する要件：PRE-5, USR-2〜USR-7, ADM-2, ADM-3, TIM-3, TIM-5, TIM-7, RSV-1〜RSV-21, RSV-25, RSV-26, VIW-1, MNG-1〜MNG-3, LOG-1〜LOG-6, SEC-3, SEC-4, NFR-3, FUT-4, FUT-5
- 前提：[domain-model.md](../basic/domain-model.md)（まとまりと状態）、[time-and-concurrency.md](../basic/time-and-concurrency.md) 1（時刻はミリ秒）、[auth.md](../basic/auth.md) 3, 4, 7（証明、ハッシュ、試行の制限）、[logging.md](../basic/logging.md)（記録の2つの表、索引、容量）、[architecture.md](../basic/architecture.md) 7（スキーマの版）、[testing-and-deploy.md](../basic/testing-and-deploy.md) 4（足す形だけで変える）、[rules.md](rules.md) 3, 5（store と rules の分担、自動の変化）

ここでは、台帳の SQLite の表・列・値・索引、初期データ、スキーマの版の適用を決める。SQL は `src/store/` にだけ書く（architecture.md 4）。

## 1. 共通の決まり

| 決まり | 内容 | 理由 |
| --- | --- | --- |
| `STRICT` の表 | すべての表を `STRICT` で作る。型の合わない値は SQLite が断る | 取り違え（数値の列に文字列など）を書き込みの時点で見つけられる |
| 値の一覧の `CHECK` は付けない | 状態・原因・出来事の種類などは `TEXT` にし、許す値は `rules/`・`lib/` で確かめる | SQLite は `CHECK` を変えるのに表の作り直しが要る。FUT-5 で原因に「メンテナンス」を足すときなどに、足す形だけで変える決まり（testing-and-deploy.md 4）を守れなくなる |
| 終了 > 開始の制約は付けない | 予約の表に `end_at > start_at` を付けない | 利用終了では長さ0を認める（TIM-7）。終了 > 開始は rules で確かめる（rules.md 4 の段 5） |
| 番号 | `INTEGER PRIMARY KEY AUTOINCREMENT` | 番号を使い回さない。記録から指した番号が別のものを指すことがない。認証の失敗の表は古い行を消すので、とくに要る |
| 参照 | 他の表の番号を持つ列には `REFERENCES` を付ける | どの表も行を消さない（認証の失敗の表はどこからも参照されない）ので邪魔にならず、番号の誤りを書き込みで断れる |
| 時刻 | 列の名前は `…_at`。1970-01-01 00:00 UTC からのミリ秒の `INTEGER` | time-and-concurrency.md 1 |
| 長さ | 列の名前・項目の名前は `…_minutes`。分の `INTEGER` | 要件も管理者の画面も分で扱い、Data Studio で読みやすい。ミリ秒への換算は `rules/` の1か所で行う |
| 真偽 | `INTEGER` の 0 / 1 | SQLite に真偽の型がない |
| ハッシュとソルト | `BLOB`（バイト列のまま） | Web Crypto の結果をそのまま保存して比べられ、変換が要らない |
| 名前の付け方 | 表は複数形、列は小文字とアンダースコア | 一般的な書き方（PRE-5） |

外部キーの確かめは、DO の SQLite では既定で有効とされている。台帳の層のテストで、存在しない番号を入れると断られることを確かめる。

**基盤で確かめたこと（2026-11-19、spike の `/schema-check`。手元の `wrangler dev` と本番の基盤の両方で同じ結果）**：2.1〜2.3 の `CREATE TABLE` と索引がそのまま作れた。`PRAGMA foreign_keys` は 1 で、存在しない番号は `SQLITE_CONSTRAINT_FOREIGNKEY` で断られた。`STRICT` は型の合わない値を `SQLITE_CONSTRAINT_DATATYPE` で断った。`AUTOINCREMENT` は消した番号を使い回さなかった。`devices_name_current` は、削除していない機器どうしの名前の重なりだけを断った。`transactionSync` の中で例外を投げると書き込みは取り消され、例外はそのまま外に出た（5.2 の 4）。索引の確認は 3 の最後の行。

## 2. 表

### 2.1 `users`（利用者。USR-3〜USR-7）

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT    NOT NULL,   -- 'student' | 'teacher'
  student_id  TEXT    NOT NULL,   -- 正規化した学籍番号（USR-4）
  name        TEXT    NOT NULL,   -- 現在の名前（USR-7）
  cohort      INTEGER,            -- 現在の期生。教員は NULL（USR-6）
  created_at  INTEGER NOT NULL,
  UNIQUE (role, student_id)
) STRICT;
```

- `student_id` は、全角を半角に、英字を小文字にそろえた形で持つ（USR-4。正規化は `src/lib/`）。先頭の0は残す。
- 名前・期生を置き換えるときは行を上書きし、前の値は出来事の記録に残す（USR-7, LOG-1）。
- `UNIQUE (role, student_id)` が、識別の組で引く索引を兼ねる。

### 2.2 `devices`（機器。MNG-1, MNG-2）

```sql
CREATE TABLE devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,   -- 前後の空白を除いた名前
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER             -- 削除した時刻。削除していなければ NULL
) STRICT;

CREATE UNIQUE INDEX devices_name_current ON devices (name) WHERE deleted_at IS NULL;
```

- 削除は `deleted_at` を入れるだけで、行は残す（LOG-2）。削除した機器の名前は、削除の時点の名前のまま残る（MNG-1）。
- `devices_name_current` は、削除していない機器どうしで名前が重ならないことの最後の守り。重なりの判定と理由のコードは rules で行う（rules.md 3）。
- 名前は前後の空白を除いた後の文字列をそのまま比べ、全角と半角、英字の大小はそろえない（rules.md 6.7。2026-11-19 に機器の機能の設計で決めた）。比べるための列は足さず、`devices_name_current` をそのまま使う。上限（30文字）は rules.md 6.6。

### 2.3 `reservations`（予約。RSV-1〜RSV-20, MNG-2, MNG-3）

```sql
CREATE TABLE reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL REFERENCES devices (id),
  user_id     INTEGER NOT NULL REFERENCES users (id),
  start_at    INTEGER NOT NULL,   -- 分の倍数（TIM-3）
  end_at      INTEGER NOT NULL,   -- 分の倍数（TIM-3）
  status      TEXT    NOT NULL,   -- 下の表
  cause       TEXT,               -- 管理者による取消・終了のときだけ
  walk_in     INTEGER NOT NULL,   -- 予約なしの利用で始めたら 1（RSV-17）
  created_at  INTEGER NOT NULL    -- 実際の時刻（TIM-5）
) STRICT;

CREATE INDEX reservations_status_start ON reservations (status, start_at);
CREATE INDEX reservations_device_status ON reservations (device_id, status);
CREATE INDEX reservations_user_status ON reservations (user_id, status);
CREATE INDEX reservations_device_end ON reservations (device_id, end_at);
```

`status` の値（RSV-1、domain-model.md 4.1）：

| 値 | 状態 | 時間帯を確保しているか |
| --- | --- | --- |
| `reserved` | 予約済 | する |
| `in_use` | 利用中 | する |
| `cancelled` | 取消 | しない |
| `no_show` | 無断不使用 | しない |
| `admin_cancelled` | 管理者による取消 | しない |
| `finished` | 終了（本人の操作か自動かは記録で区別する） | しない |
| `admin_finished` | 管理者による終了 | しない |

`cause` の値（LOG-3）：

| 値 | 原因 | 使う状態 |
| --- | --- | --- |
| `admin_action` | 管理者の操作 | `admin_cancelled`、`admin_finished` |
| `device_deleted` | 機器の削除（MNG-2） | `admin_cancelled` |

FUT-5 では `cause` に `maintenance` を足す。`CHECK` がないので表は変えなくてよい。

- `walk_in` は作るときに決め、変えない（RSV-17「時間帯を変更した後も数えない」）。
- 終了した予約の `end_at` は、利用した時間帯の終わりになる（domain-model.md 4）。予定していた終了時刻は記録からたどる。

### 2.4 `settings`（数値の履歴。RSV-25, RSV-26）

```sql
CREATE TABLE settings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL,   -- 下の表
  value         INTEGER NOT NULL,
  effective_at  INTEGER NOT NULL    -- 有効になる時刻。分の倍数（RSV-26）
) STRICT;
```

| `key` | 数値 | 単位 | 初期値 |
| --- | --- | --- | --- |
| `max_count` | 件数の上限（RSV-4） | 件 | 3 |
| `grace_minutes` | 猶予（RSV-13） | 分 | 15 |
| `max_length_minutes` | 長さの上限（RSV-6） | 分 | 1440 |

- 変更のたびに1行足し、上書きしない（domain-model.md 3）。同じ `effective_at` の行が複数あれば、`id` の大きい行が勝つ（rules.md 3.1）。
- 変更のたびに1行なので小さく、索引は付けない。store は全件を渡す（rules.md 3.1）。

### 2.5 `admins`（管理者。ADM-2）

```sql
CREATE TABLE admins (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id             TEXT    NOT NULL UNIQUE,  -- そろえた形（auth.md 5）。削除した行も含めて一意
  display_name         TEXT    NOT NULL,
  password_hash        BLOB    NOT NULL,         -- PBKDF2-HMAC-SHA256
  password_salt        BLOB    NOT NULL,         -- 16バイト
  password_iterations  INTEGER NOT NULL,         -- ハッシュを作ったときの反復回数
  password_version     INTEGER NOT NULL,         -- パスワードを設定し直すたびに1増やす
  created_at           INTEGER NOT NULL,
  deleted_at           INTEGER
) STRICT;
```

- `login_id` は削除した行も含めて一意にする（ADM-2「削除したアカウントの ID は再び使えない」）。そのため部分索引ではなく、列の `UNIQUE` にする。
- パスワードの設定し直しでは、ハッシュ・ソルト・反復回数を上書きし、`password_version` を増やす。証明は作ったときの版を持つので、版が変わるとすべての端末で止まる（auth.md 3）。前のハッシュは残さない（秘密の値で、残しても追跡に役立たない。設定し直したことは記録に残る）。
- 最初の版は 1。

### 2.6 `shared_infos`（共有された情報。ADM-3）

```sql
CREATE TABLE shared_infos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 共有された情報の版
  hash        BLOB    NOT NULL,                   -- 値の SHA-256
  created_at  INTEGER NOT NULL
) STRICT;
```

- `id` を共有された情報の版とする。`id` の最も大きい行が現在の値で、1行もなければ未設定（domain-model.md 1）。版の列を別に持たない。
- 行は消さない。

### 2.7 `user_sessions`（利用を始めた証明。USR-2）

```sql
CREATE TABLE user_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash      BLOB    NOT NULL UNIQUE,                     -- Cookie の値の SHA-256
  shared_info_id  INTEGER NOT NULL REFERENCES shared_infos (id),  -- 始めた版
  created_at      INTEGER NOT NULL
) STRICT;
```

- 有効なのは、`shared_info_id` が現在の版と同じとき（auth.md 3）。

### 2.8 `admin_sessions`（管理者の認証。ADM-2）

```sql
CREATE TABLE admin_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash        BLOB    NOT NULL UNIQUE,              -- Cookie の値の SHA-256
  admin_id          INTEGER NOT NULL REFERENCES admins (id),
  password_version  INTEGER NOT NULL,                     -- 作ったときの版
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER                               -- 認証を解いた時刻
) STRICT;
```

- 有効なのは、管理者が削除されていない、`password_version` が現在と同じ、`ended_at` が NULL のとき（auth.md 3）。

2.7・2.8 に「最後に使った時刻」は持たない。Cookie の期限を延ばすときは同じ値を送り直すだけで、表に書かなくてよい。リクエストのたびに書くと、1日の書き込みの上限（logging.md 5）を無駄に使う。

### 2.9 `events`（出来事の記録。LOG-1〜LOG-5）

```sql
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,   -- 実際の時刻。自動の変化はルール上の時刻（RSV-21）
  actor_kind      TEXT    NOT NULL,   -- 'user' | 'admin' | 'auto' | 'maint'
  actor_admin_id  INTEGER REFERENCES admins (id),       -- actor_kind が 'admin' のとき
  kind            TEXT    NOT NULL,   -- 下の表
  reservation_id  INTEGER REFERENCES reservations (id),
  device_id       INTEGER REFERENCES devices (id),
  user_id         INTEGER REFERENCES users (id),
  admin_id        INTEGER REFERENCES admins (id),       -- 対象の管理者
  detail          TEXT    NOT NULL    -- JSON の文字列
) STRICT;

CREATE INDEX events_at ON events (at);
CREATE INDEX events_device_at ON events (device_id, at);
CREATE INDEX events_user_at ON events (user_id, at);
```

だれが（`actor_kind`）：

| 値 | だれ | 操作した人の番号 |
| --- | --- | --- |
| `user` | 利用者 | `user_id`。利用者が操作できるのは自分自身と自分の予約だけなので、操作した人は必ず対象の利用者と同じになる |
| `admin` | 管理者 | `actor_admin_id`（LOG-4 の管理者の ID） |
| `auto` | 自動の変化（RSV-13, RSV-16, RSV-19） | なし |
| `maint` | 保守用の API（auth.md 6） | なし |

何を（`kind`）と、詳しく（`detail`）に入れるもの（logging.md 2）：

| `kind` | 出来事 | 何に | `detail` |
| --- | --- | --- | --- |
| `reservation_created` | 予約の確保 | 予約・機器・利用者 | `start_at`、`end_at` |
| `walk_in_started` | 予約なしの利用 | 予約・機器・利用者 | `start_at`、`end_at` |
| `reservation_status` | 状態の変化（利用開始、取消、無断不使用、終了、管理者による取消・終了） | 予約・機器・利用者 | `from`、`to`、`cause`（管理者による取消・終了のとき）、書き換えた時刻（前倒しの利用開始は `start_at`、利用終了・管理者による終了は `end_at` に、それぞれ `{before, after}`。書き換えないときは入れない。api.md 8.34・8.35） |
| `reservation_time_changed` | 時間帯の変更（RSV-9, RSV-10。RSV-15 の前倒しは `reservation_status` に入れる。logging.md 2） | 予約・機器・利用者 | `before`・`after` に、それぞれ `start_at`・`end_at`（片方だけ変えても両方。時間帯の変更は api.md 8.32） |
| `user_created` | 利用者を作った | 利用者 | `name`、`cohort` |
| `user_renamed` | 名前・期生を置き換えた（USR-7） | 利用者 | `before`・`after` に、それぞれ `name`・`cohort`（片方だけ変わっても両方。api.md 8.15.1） |
| `device_created`・`device_renamed`・`device_deleted` | 機器の追加・名前の変更・削除 | 機器 | 追加・削除は `name`。名前の変更は `before`・`after` に、それぞれ `name`（api.md 8.19〜8.21） |
| `setting_changed` | 数値の変更（RSV-25） | なし | `key`、`before`・`after` に前後の `value`、`effective_at`（同じ値への変更は書かない。api.md 8.42） |
| `admin_created`・`admin_deleted`・`admin_password_reset` | 管理者のアカウント | 管理者 | `login_id`、`display_name`。パスワードは入れない |
| `shared_info_set` | 共有された情報の設定・変更（ADM-3） | なし | `version`（新しい `shared_infos.id`）。値もハッシュも入れない |
| `admin_login`・`admin_logout` | 管理者の認証の成功、認証を解いた | 管理者 | `ip` |

- 予約の出来事には、その予約の `device_id` と `user_id` を必ず入れる（FUT-4。logging.md 2）。
- `detail` の時刻はミリ秒の数値で入れる（SQL で日本時間に直せる。logging.md 6）。
- 状態の変化を1つの `kind` にまとめ、どの状態へ移ったかは `detail` の `to` で区別する。LOG-3 の区別（取消・無断不使用・管理者による取消、終了・管理者による終了）は `to` の値で表せる。本人の操作による終了か自動による終了かは、`actor_kind` で区別する（domain-model.md 4.1）。
- 状態の変化に伴う時刻の書き換えは、その `reservation_status` の1行に入れ、`reservation_time_changed` を別に書かない（1回の操作を1行にする。logging.md 2。2026-11-19 に利用開始の設計で決めた）。LOG-3 の「時間帯の変更（RSV-15 を含む）」は、`reservation_time_changed` と、`detail` に `start_at` を持つ `reservation_status` を合わせて引く。
- `detail` に入れる項目は `kind` ごとに決めた形だけにし、リクエストの本文をそのまま入れない（logging.md 3）。
- `detail` の項目は足してよいが、すでに入れた項目の意味は変えない。

### 2.10 `auth_failures`（認証の失敗。SEC-3、LOG-4）

```sql
CREATE TABLE auth_failures (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry                    TEXT    NOT NULL,   -- 'shared_info' | 'admin_login' | 'maint'
  client                   TEXT    NOT NULL,   -- 接続元の IP。IPv6 は先頭64ビット
  window_start             INTEGER NOT NULL,   -- 時刻を10分で切り捨てたもの
  failures                 INTEGER NOT NULL,   -- 上限（auth.md 7）まで
  unknown_id_failures      INTEGER NOT NULL,   -- 管理者の認証で、ID がなかった回数
  wrong_password_failures  INTEGER NOT NULL,   -- 管理者の認証で、パスワードが違った回数
  last_login_id            TEXT,               -- 管理者の認証で最後に試された ID。形式に合わなければ '(invalid)'
  first_at                 INTEGER NOT NULL,
  last_at                  INTEGER NOT NULL,
  UNIQUE (entry, client, window_start)
) STRICT;
```

- `UNIQUE (entry, client, window_start)` が、回数を引いて足す索引を兼ねる。
- 管理者の認証以外では、`unknown_id_failures`・`wrong_password_failures` は 0、`last_login_id` は NULL。
- 上限に達した後の試行は書き込まない（logging.md 4）。

**10,000行を超えたら消す。** 行を足したら、`id <= 足した行の id − 10000` の行を消す（`DELETE FROM auth_failures WHERE id <= ?`）。

- 主キーで消すので、ほとんど行を読まない。`COUNT(*)` で数えると失敗のたびに10,000行を読み、1日の読み取りの上限（logging.md 5）を使いやすい。
- 行は区切りの始まりの順に足されるので、番号の小さい順に消せば、古い区切りから消すことになる（logging.md 4）。
- 消すのはこの表だけ。ほかの表を消す SQL は書かない（LOG-5）。

### 2.11 `schema_migrations`（スキーマの版。architecture.md 7）

```sql
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
) STRICT;
```

下の 5 で使う。

## 3. 索引と、それを使う処理

ふだんの処理では記録の表を読まず、予約の表は索引で引く（logging.md 5）。

| 索引 | 使う処理 | 条件 |
| --- | --- | --- |
| `reservations_status_start` | 自動の変化の反映（rules.md 5.2） | `status IN ('reserved', 'in_use') AND start_at <= nowMin` |
| `reservations_device_status` | 確保・変更・予約なしの利用の重なり（RSV-3, RSV-20）、利用開始の前倒し（RSV-15）、管理者の一覧（MNG-3）、機器の削除（MNG-2） | `device_id = ? AND status IN ('reserved', 'in_use')` |
| `reservations_user_status` | 件数（RSV-4）、自分の予約（RSV-7） | `user_id = ? AND status IN ('reserved', 'in_use')` |
| `reservations_device_end` | 予約状況の1日分（VIW-1） | `device_id = ? AND end_at >= 日の始まり AND start_at < 日の終わり`（状態では絞らない。api.md 8.24） |
| `events_at`・`events_device_at`・`events_user_at` | FUT-4 の期間・機器・利用者での絞り込み（v0.1.0 では Data Studio の SQL。logging.md 6） | ― |

- **予約状況は `end_at` で引く。** `start_at` で引くと、その日より前の、その機器の履歴をすべてたどる（5年で数万件）。`end_at >= 日の始まり` で引けば、その日にかかるものと先の予約だけを読む。長さの上限は変えられるので、`start_at` に下限を付けて絞る方法は使わない。
- **`>` ではなく `>=`。** 長さ0の利用（TIM-7）を開始時刻を含む日に出すため（rules.md 6.9。2026-11-19 に予約状況の設計で直した）。終了がちょうど日の始まりの予約も引かれるが、rules の `daySlots` が落とす。
- **部分索引（`WHERE status IN …`）は使わない。** 索引は小さくなるが、SQL の条件を索引の定義と同じ形で書かないと使われず、引き継ぐ人が気づきにくい（PRE-5）。2.2 の `devices_name_current` は一意の制約のためのもので、検索の速さのためではない。
- **書き込みの量。** 記録1件で、表と3つの索引の4行を書く。予約1件の確保から終了まで（記録3〜5件）で20行あまり。10倍の規模（予約200件/日）でも1日5,000行ほどで、10万行（logging.md 5）に収まる。
- 索引が実際に使われることは、台帳の層のテストで `EXPLAIN QUERY PLAN` を見て確かめる（自動の変化の反映と予約状況の2つ）。基盤では、空の表で `reservations_status_start`（自動の変化の反映）と `reservations_device_end`（予約状況）が使われることを確かめた（2026-11-19、spike）。行が増えたときの選び方は、テストで行を入れて確かめる。

## 4. 初期データ

最初の版（下の 5 の版 1）で、表と一緒に `settings` の3行を入れる。

| `key` | `value` | `effective_at` |
| --- | --- | --- |
| `max_count` | 3 | 0 |
| `grace_minutes` | 15 | 0 |
| `max_length_minutes` | 1440 | 0 |

- `effective_at` を 0 にするのは、どの時刻で引いても値が必ず見つかるようにするため。`settingAt`（rules.md 3.1）に「値がない」場合の処理が要らなくなる。0 より前の時刻を引くことはない。
- 機器・管理者・共有された情報は入れない。管理者は保守用の API で作り（ADM-2）、共有された情報は最初は未設定（ADM-3）。

## 5. スキーマの版と適用（architecture.md 7, testing-and-deploy.md 4）

### 5.1 置き場所

`src/store/migrations.js` に、版の一覧を古い順に並べる。1つの版は「版の番号」と「実行する SQL の並び」の組。版 1 は、上の 2 の表と索引のすべてと、4 の初期データ。

### 5.2 適用の手順

台帳の constructor で、`ctx.blockConcurrencyWhile()` に包んで行う。包んでいる間、台帳はリクエストを受けないので、適用の途中の表をリクエストが読むことはない。

1. `schema_migrations` がなければ作る。
2. `schema_migrations` の `version` の最大を読む（なければ 0）。
3. それより大きい版を古い順に、1つずつ `ctx.storage.transactionSync()` の中で適用する。同じトランザクションで `schema_migrations` に行を足す。`applied_at` は適用した時刻。
4. 途中で失敗したら、その版はトランザクションで取り消される。例外は受け止めずに投げ、台帳を作り直させる（次のリクエストで、もう一度 1 から試す）。

### 5.3 変更の決まり

- 版を足すときは、表・列・索引を足す SQL だけを書く。既存の列を消す、名前を変える、意味を変える SQL は書かない（testing-and-deploy.md 4、LOG-5）。
- 適用済みの版の中身は書き換えない。直したいときは次の版を足す。
- 列を足すときは、既存の行のために `NULL` を許すか、既定値を付ける。前の版のコードに戻したときも動くように、新しい列がなくても古いコードが読み書きできる形にする（testing-and-deploy.md 4）。

### 5.4 テストの観点

| 観点 | 確かめること |
| --- | --- |
| 空の台帳から最新の版まで | すべての表と索引ができ、`settings` に初期値の3行が入り、`schema_migrations` に全部の版がある |
| 1つ前の版から最新の版まで | 前の版の表と行が残ったまま、足りない版だけが適用される（版が1つの間は、版 1 を適用した台帳に何もしないことを確かめる） |
| 2回目の起動 | 何も適用しない（行が増えない） |
| 外部キー | 存在しない機器・利用者の番号で予約を入れると断られる |
| 索引 | 3 の最後の行のとおり |

テスト名は、関係する要件の ID か `SCHEMA` で始める（要件の ID がない仕組みのテストのため）。

## 採らなかった案

| 案 | 理由 |
| --- | --- |
| 型を付けない普通の表 | 数値の列に文字列が入っても通ってしまう |
| 状態・原因の値を `CHECK` で縛る | 値を足すとき（FUT-5 の「メンテナンス」など）に表の作り直しが要り、足す形だけで変える決まりに反する |
| `AUTOINCREMENT` を付けない | 最も新しい行を消すと番号が使い回されうる。認証の失敗の表は行を消す |
| 長さをミリ秒で持つ | 900000 のような値になり、Data Studio で読みにくい。要件も画面も分で扱う |
| ハッシュを16進の文字列で持つ | 保存と比較のたびに変換が要る |
| 共有された情報に版の列を別に持つ | 番号と版が二重になる。番号を版とすれば足りる |
| 証明に最後に使った時刻を持つ | リクエストのたびに書き込みが起き、1日の書き込みの上限を使う。要件で使わない |
| 記録の「だれが」を、利用者と管理者の両方の列で持つ | 利用者の操作では、操作した人が必ず対象の利用者と同じになり、列が二重になる |
| 状態の変化を、移る先ごとに別の `kind` にする | 種類が増える。移る先は `detail` の `to` で区別できる |
| 予約状況を `(device_id, start_at)` で引く | その日より前の履歴をすべてたどる |
| 部分索引で、予約済・利用中だけを索引にする | 条件を定義と同じ形で書かないと使われず、気づきにくい（PRE-5） |
| 認証の失敗の行数を `COUNT(*)` で数えて消す | 失敗のたびに表全体を読む |
| スキーマの版を `PRAGMA user_version` で持つ | いつ適用したかが残らない。DO で使えるかも確かめていない |
| 初期値の `effective_at` を台帳を作った時刻にする | それより前の時刻を引いたときに値がなく、`settingAt` に例外の処理が要る |

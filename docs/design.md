# DXプレイス予約システム 基本設計（テーブル・RPC・画面）

最終更新: 2026-11-08

要件定義（`docs/requirements.md`）を実装に落とすための、テーブル定義・RPC関数の一覧・画面一覧。マイグレーションとテスト（テスト先行）はこの設計に沿って進める。設計を変えるときは、先にこの文書を更新する。

要件定義に書かれていなかった点で、確定した判断:
- 管理者の追加は **Edge Function** で Auth ユーザーを作成する
- 利用停止時は、その人の**未来の予約をキャンセル**する（利用中はそのまま。チェックアウトは可能）
- 開始前のチェックインは**時間の制限なし**

---

## 1. 全体方針

- **スキーマの分離**: テーブル・ビュー・内部関数は `private` スキーマに置く（API の公開対象 `public` に入れない）。`public` には公開する RPC 関数だけを置く
- **権限**: `private` の全オブジェクトについて `anon` / `authenticated` / `public` から権限を取り消す。関数は PostgreSQL の既定で PUBLIC に実行権が付くので、`alter default privileges ... revoke execute on functions from public` を最初のマイグレーションで行い、関数ごとに明示的に `grant execute` する
  - 一般利用者の RPC: `anon, authenticated` に grant
  - 管理者の RPC: `authenticated` のみに grant（中で管理者表を確認）
- **関数の形**: すべて `security definer` かつ `set search_path = ''`。中の参照はすべて `private.xxx` / `extensions.xxx` のようにスキーマ付きで書く
- **時刻**: 判定はすべて `now()`。クライアントから受け取る時刻は `date_trunc('minute', …)` で分に切り捨てる。日付の境界は `Asia/Tokyo` で計算する
- **エラーの形式**: `raise exception using errcode = 'P0001', message = '<エラーコード>', detail = '<JSON文字列>'`。supabase-js では `error.message` にコード、`error.details` に補足が入る。フロントはコードを日本語の文に変換する（一覧は5章）
- **戻り値**: 1件を返す関数は `jsonb`、一覧は `jsonb`（配列）で返す。列が増えても関数の型を変えずに済むため

---

## 2. テーブル定義（`private` スキーマ）

PostgreSQL 17 なので、一意性に `nulls not distinct` を使える（教員は期生が NULL）。

### entry_tokens（入口トークン）
| 列 | 型 | 備考 |
|---|---|---|
| id | bigint identity PK | |
| token | text not null unique | `encode(extensions.gen_random_bytes(24), 'base64')` を URL セーフにしたもの |
| issued_at | timestamptz not null default now() | |
| issued_by | uuid null → auth.users | 初回は NULL |
| revoked_at | timestamptz null | 再発行時に設定 |

- `create unique index on entry_tokens ((true)) where revoked_at is null` で、有効なものを常に1つに保つ
- 管理画面で QR を再表示できるよう、平文で保存する（信頼モデル上、漏れても校外の人が閲覧できるだけで、再発行すれば無効にできる）

### users（利用者）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK default gen_random_uuid() | localStorage に保存する ID |
| name | text not null | 前後の空白を除いて 1〜50文字 |
| cohort | integer null | 期生。NULL なら教員。`check (cohort > 0)` |
| memo | text not null default '' | 500文字以内。プレーンテキスト |
| suspended_at | timestamptz null | 利用停止 |
| deleted_at | timestamptz null | 論理削除 |
| created_at / updated_at | timestamptz | |

- `create unique index on users (name, cohort) nulls not distinct where deleted_at is null`

### admins（管理者）
| 列 | 型 | 備考 |
|---|---|---|
| user_id | uuid PK → auth.users(id) | |
| display_name | text not null | ログの表示用 |
| created_at | timestamptz | |
| created_by | uuid null → auth.users | |

### resources（リソース）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | 変化しない ID |
| name | text not null | |
| memo_md | text not null default '' | Markdown |
| sort_order | integer not null default 0 | グリッドの列の順 |
| paused_at | timestamptz null | 一時停止 |
| pause_reason | text null | 例: 故障 |
| deleted_at | timestamptz null | 論理削除。名前は残す（過去のログ表示用） |
| created_at / updated_at | timestamptz | |

- `create unique index on resources (name) where deleted_at is null`

### reservations（予約・予約なしの利用・封鎖）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| resource_id | uuid not null → resources | |
| user_id | uuid null → users | 封鎖のときは NULL |
| kind | text not null | `'reservation'`（予約）/ `'walk_in'`（予約なしの利用）/ `'block'`（封鎖） |
| start_at / end_at | timestamptz not null | `check (end_at > start_at)` |
| checked_in_at | timestamptz null | walk_in は作成時に設定 |
| checked_out_at | timestamptz null | 管理者の強制終了でも設定する |
| cancelled_at | timestamptz null | |
| block_reason | text null | 封鎖の理由 |
| created_at / updated_at | timestamptz | |

- 制約: `check ((kind = 'block') = (user_id is null))`、`check (kind <> 'block' or checked_in_at is null)`、`check (kind <> 'walk_in' or checked_in_at is not null)`
- インデックス: `(resource_id, start_at)`、`(user_id, start_at)`
- `EXCLUDE` 制約は使わない（要件 4章）

### announcements（お知らせ）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| title | text not null | |
| body_md | text not null | |
| importance | text not null | `'normal'` / `'important'` |
| publish_start_at | timestamptz not null | |
| publish_end_at | timestamptz null | NULL なら無期限。`check (publish_end_at > publish_start_at)` |
| deleted_at | timestamptz null | |
| created_at / updated_at | timestamptz | |

### action_logs（操作ログ）
| 列 | 型 | 備考 |
|---|---|---|
| id | bigint identity PK | |
| actor_type | text not null | `'user'` / `'admin'` |
| actor_user_id | uuid null → users | |
| actor_admin_id | uuid null | 外部キーは付けない（Auth のユーザーが消えてもログを残す） |
| action | text not null | 例: `reservation.create`、`reservation.check_in`、`user.suspend` |
| target_type | text not null | `'reservation'` / `'user'` / `'resource'` / `'announcement'` / `'token'` / `'admin'` |
| target_id | text null | |
| detail | jsonb not null default '{}' | 変更前後の値、その時点のリソース名・氏名など |
| created_at | timestamptz not null default now() | |

- インデックス: `(created_at)`、`(actor_user_id, created_at)`、`(target_type, target_id)`

### ビューと内部関数（`private`。公開しない）

- **状態の導出（1か所に集約）** `private.reservation_status(r private.reservations, p_at timestamptz default now()) returns text`
  ```
  cancelled_at が NULL でない                         → 'cancelled'
  checked_out_at が NULL でない、または end_at <= at   → 'finished'
  kind = 'block'                                      → 'blocked'
  checked_in_at が NULL でない                        → 'in_use'
  start_at + 15分 < at                                → 'no_show'
  それ以外                                             → 'reserved'
  ```
  封鎖はチェックインしないため、無断不参加の判定より前に `'blocked'` を返す（要件の5行の導出に、封鎖の1行を加えたもの）
- `private.occupies(status)`: `'reserved' / 'in_use' / 'blocked'` のときに true（枠を占有する）
- `private.effective_end(r)`: `least(end_at, coalesce(checked_out_at, end_at))`。表示に使う実際の終了
- ビュー: `private.active_users`、`private.active_resources`（`deleted_at is null`）、`private.reservations_v`（状態・実際の終了・リソース名・氏名を付けたもの）
- 共通処理:
  - `private.assert_token(p_token)` → 無効なら `INVALID_TOKEN`
  - `private.get_actor(p_token, p_user_id)` → トークンを確認し、削除されていない利用者の行を返す。いなければ `USER_NOT_FOUND`
  - `private.assert_not_suspended(user)` → `USER_SUSPENDED`
  - `private.assert_admin()` → `auth.uid()` が admins になければ `NOT_ADMIN`
  - `private.lock_resource(p_resource_id, p_require_active)` → `select … for update`。ない・削除済みなら `RESOURCE_NOT_FOUND`、一時停止中なら `RESOURCE_PAUSED`
  - `private.find_overlap(p_resource_id, p_start, p_end, p_exclude_id)` → 区間 `[start, end)` に重なる占有中の予約（状態は `reservation_status` で判定）
  - `private.next_start(p_resource_id, p_after, p_exclude_id)` → `p_after` 以降に始まる占有中の予約の最も早い開始時刻
  - `private.count_holding(p_user_id)` → 状態が `reserved` / `in_use` の件数（kind は問わない）
  - `private.write_log(...)`

---

## 3. RPC関数（一般利用者。`anon, authenticated` に公開）

すべての関数は第1引数で `p_token text` を受け取り、冒頭で `assert_token` を実行する（以下の表では省略）。ログイン状態が必要な関数は `p_user_id uuid` も受け取る。

| 関数 | 引数 | 戻り値 | 主なエラー | 備考 |
|---|---|---|---|---|
| `check_token` | — | `jsonb {ok, server_now}` | INVALID_TOKEN | 入口処理と起動時の確認 |
| `get_home` | `p_user_id uuid null, p_day date` | `jsonb {server_now, me, my_reservations[], resources[], reservations[], announcements[]}` | INVALID_TOKEN, USER_NOT_FOUND | トップページを1回の呼び出しで描く。`reservations` は `p_day`（東京時間）にかかる占有中・終了の予約で、氏名・期生・メモ・封鎖理由を含む。キャンセルと無断不参加は含めない。`me` は未ログインなら null |
| `get_day` | `p_user_id uuid null, p_day date` | `jsonb {server_now, reservations[]}` | 同上 | 日付の切り替え用 |
| `create_user` | `p_name, p_cohort int null, p_memo` | `jsonb user` | INVALID_INPUT, IDENTITY_CONFLICT | 衝突したら `detail` に既存の `{id, name, cohort, memo}` を入れる |
| `login_user` | `p_name, p_cohort int null` | `jsonb user` | USER_NOT_FOUND | 「同一人物です」を選んだときに呼ぶ |
| `update_profile` | `p_user_id, p_name, p_cohort, p_memo` | `jsonb user` | INVALID_INPUT, IDENTITY_CONFLICT | 衝突して同一人物なら、フロントは既存のアカウントに切り替える |
| `create_reservation` | `p_user_id, p_resource_id, p_start_at, p_end_at` | `jsonb reservation` | USER_SUSPENDED, RESOURCE_NOT_FOUND, RESOURCE_PAUSED, INVALID_INPUT（`end<=start`、`start<now` の分）, OVERLAP, LIMIT_EXCEEDED | リソースをロックしてから重複と上限（3件）を判定する。開始が現在の分より前の入力は不可（フロントで現在の分に補正して送る） |
| `cancel_reservation` | `p_user_id, p_reservation_id` | `jsonb reservation` | RESERVATION_NOT_FOUND, NOT_OWNER, INVALID_STATE | 状態が `reserved` のときだけ可。停止中でも可 |
| `change_reservation` | `p_user_id, p_reservation_id, p_start_at null, p_end_at null` | `jsonb reservation` | USER_SUSPENDED, NOT_OWNER, INVALID_STATE, INVALID_INPUT, OVERLAP, END_EXCEEDS_NEXT | 開始の変更: `reserved` かつ `now < start_at`、新しい開始も `now` 以降。終了の変更: `reserved / in_use` かつ `now < end_at`、新しい終了は `now` より後。延長が次の予約にかかる場合は `END_EXCEEDS_NEXT`（`detail` に次の開始時刻） |
| `check_in` | `p_user_id, p_reservation_id, p_advance boolean default false` | `jsonb reservation` | USER_SUSPENDED, RESOURCE_PAUSED, NOT_OWNER, INVALID_STATE, CHECKIN_WINDOW_CLOSED, ADVANCE_REQUIRED, PREVIOUS_SLOT_OCCUPIED | `now >= start_at`: そのままチェックイン（15分を過ぎていれば `CHECKIN_WINDOW_CLOSED`）。`now < start_at`: `p_advance = true` のときだけ前倒しし（`[now, start_at)` が空いていなければ `PREVIOUS_SLOT_OCCUPIED`）、`start_at = checked_in_at = now()` とする。false なら `ADVANCE_REQUIRED`。「予約なしとして使う」を選んだ場合、フロントは `start_walk_in` を呼ぶ |
| `start_walk_in` | `p_user_id, p_resource_id, p_end_at` | `jsonb reservation` | USER_SUSPENDED, RESOURCE_PAUSED, NOT_FREE_NOW, INVALID_INPUT, END_EXCEEDS_NEXT | 現在時刻が空いていることが条件。終了は自分の予約を含む次の予約の開始時刻まで。上限は判定しない。`start_at = checked_in_at = now()` |
| `check_out` | `p_user_id, p_reservation_id` | `jsonb reservation` | NOT_OWNER, INVALID_STATE | 状態が `in_use` のときだけ可。停止中でも可 |

- 予約を書き換える関数は、すべて対象リソースの行を `for update` でロックしてから判定し、書き込み、ログの記録までを同じトランザクションで行う
- 予約の所有者の確認は `reservation.user_id = p_user_id` で行う（信頼モデル。なりすましの追跡は操作ログで行う）
- `create_reservation` は、上限が利用者ごとなので利用者の行もロックする（別のリソースへの同時の予約で4件目が通らないように）
- グリッド（`get_home` / `get_day` の `reservations`）に描くのは、占有中の予約と、実際に使われた終了済みの予約（チェックインした予約・予約なしの利用・封鎖）。要件の導出順では無断不参加も終了時刻を過ぎると「終了」になるため、チェックインしていない「終了」は描かない
- `login_user` も操作ログに残す（なりすましの追跡のため）
- 2人が同時に同じ枠を予約したときの拒否は、pgTAP（1つのトランザクション）では再現できない。画面ができた段階で、2つのブラウザから確かめる

---

## 4. RPC関数（管理者。`authenticated` のみに公開）

冒頭で `assert_admin()` を実行し、すべての書き込みを `actor_type = 'admin'` でログに残す。利用停止・アカウントの削除・リソースの削除に伴って予約をキャンセル・終了させるときは、予約ごとにも `reservation.cancel` / `reservation.force_checkout` のログを残す（ログを利用者やリソースで絞り込んだときに追えるように）。管理者の RPC の実行権は、名前が `admin_` で始まる関数に対して一括で `authenticated` に与える。

| 関数 | 引数 | 戻り値 | 主なエラー / 備考 |
|---|---|---|---|
| `admin_whoami` | — | `jsonb {is_admin, display_name}` | 管理者でなければ `is_admin=false` を返す（エラーにしない） |
| `admin_list_reservations` | `p_from, p_to, p_resource_id null, p_user_id null` | `jsonb[]` | キャンセルや無断不参加も含め、状態付きで返す |
| `admin_create_block` | `p_resource_id, p_start_at, p_end_at, p_reason` | `jsonb reservation` | OVERLAP。上限の対象外 |
| `admin_update_reservation` | `p_reservation_id, p_start_at null, p_end_at null` | `jsonb reservation` | OVERLAP, INVALID_STATE（終了・キャンセル済み）。時刻の期限による制限はかけない |
| `admin_cancel_reservation` | `p_reservation_id` | `jsonb reservation` | 状態が `reserved / blocked` のとき |
| `admin_force_checkout` | `p_reservation_id` | `jsonb reservation` | 状態が `in_use` のとき。`checked_out_at = now()` |
| `admin_list_users` | `p_query text null, p_include_deleted bool` | `jsonb[]` | |
| `admin_update_user` | `p_user_id, p_name, p_cohort, p_memo` | `jsonb user` | IDENTITY_CONFLICT |
| `admin_suspend_user` / `admin_unsuspend_user` | `p_user_id` | `jsonb user` | 停止時は未来の予約（`reserved`）をキャンセルする |
| `admin_delete_user` | `p_user_id` | `jsonb user` | メモを消し、`reserved` をキャンセルし、`in_use` を終了させる。氏名は残す |
| `admin_restore_user` | `p_user_id` | `jsonb user` | 同じ識別子の有効なアカウントがあれば IDENTITY_CONFLICT。消したメモは戻らない |
| `admin_list_resources` | — | `jsonb[]` | 削除済みも含む |
| `admin_create_resource` | `p_name, p_memo_md, p_sort_order` | `jsonb resource` | INVALID_INPUT, NAME_CONFLICT |
| `admin_update_resource` | `p_resource_id, p_name, p_memo_md, p_sort_order` | `jsonb resource` | NAME_CONFLICT |
| `admin_pause_resource` / `admin_resume_resource` | `p_resource_id, p_reason null` | `jsonb resource` | 一時停止しても既存の予約は残す（チェックインと新規の予約ができなくなるだけ） |
| `admin_delete_resource` | `p_resource_id` | `jsonb resource` | 未来の予約と封鎖をキャンセルし、利用中は終了させる |
| `admin_get_token` | — | `jsonb {token, issued_at}` | QR の再表示用 |
| `admin_issue_token` | — | `jsonb {token, issued_at}` | 古いトークンに `revoked_at` を設定し、新しいトークンを作る |
| `admin_list_announcements` | `p_include_deleted bool` | `jsonb[]` | 公開状態（予定・公開中・終了）を導出して付ける |
| `admin_create_announcement` / `admin_update_announcement` | `(p_id), p_title, p_body_md, p_importance, p_publish_start_at, p_publish_end_at null` | `jsonb announcement` | INVALID_INPUT |
| `admin_delete_announcement` | `p_id` | `jsonb announcement` | `deleted_at` を設定する |
| `admin_list_logs` | `p_from, p_to, p_user_id null, p_resource_id null, p_limit int default 100, p_offset int default 0` | `jsonb {total, rows[]}` | 操作者・対象の名前を付けて返す |
| `admin_list_admins` | — | `jsonb[]` | |
| `admin_register_admin` | `p_auth_user_id uuid, p_display_name` | `jsonb admin` | Edge Function から、呼び出した管理者の JWT で呼ぶ。`auth.users` にいなければ USER_NOT_FOUND |

### Edge Function `admin-create-admin`（`supabase/functions/admin-create-admin/index.ts`）

1. リクエストの JWT で Supabase クライアントを作り、`admin_whoami` で呼び出し元が管理者であることを確認する
2. 環境変数 `SUPABASE_SERVICE_ROLE_KEY`（Supabase が自動で注入する。リポジトリには置かない）で `auth.admin.createUser({ email, password, email_confirm: true })` を実行する
3. 呼び出し元の JWT で `admin_register_admin` を呼ぶ（判定とログは DB 側に残す）。失敗したら作成した Auth ユーザーを削除する

- リクエスト: `POST { email, password, display_name }`。応答: `200 { user_id, display_name, created_at }`、失敗時は `4xx { error: コード, details }`
- 関数独自のエラー: `NOT_ADMIN`（403）、`INVALID_INPUT`（`details.field` は email / password / display_name / body）、`EMAIL_EXISTS`（同じメールアドレスの Auth ユーザーがいる）、`AUTH_CREATE_FAILED`（その他の作成失敗）。`admin_register_admin` のエラーはそのコードを返す
- パスワードは8文字以上（`config.toml` の `minimum_password_length` も 8）

あわせて `config.toml` の `[auth] enable_signup` を `false` にする。初期の管理者2人は、ローカルでは `seed.sql`、本番では手順書に沿って1回だけ作成する。

### ローカルの初期データ（`supabase/seed.sql`）

入口トークン、リソース3つ、管理者1人（ローカル専用のテスト値。中身は `seed.sql` の冒頭に書いてある）。pgTAP のテストはこの初期データに左右されないよう、各ファイルの冒頭で `private` のテーブルを空にしてから始める（`rollback` で元に戻る）。

---

## 5. エラーコード一覧

| コード | 意味（フロントの表示） |
|---|---|
| INVALID_TOKEN | 入口URLが更新された → トークン無効の画面へ |
| USER_NOT_FOUND | アカウントが見つからない（削除済みなど）→ localStorage を消してログアウト |
| USER_SUSPENDED | アカウントが利用停止中 |
| IDENTITY_CONFLICT | 同じ氏名・期生の人がいる → 同一人物かを確認するダイアログへ |
| INVALID_INPUT | 入力が正しくない（`detail` に項目名） |
| RESOURCE_NOT_FOUND / RESOURCE_PAUSED | リソースがない / 一時停止中 |
| RESERVATION_NOT_FOUND / NOT_OWNER | 予約がない / 自分の予約ではない |
| INVALID_STATE | 今の状態ではその操作はできない（`detail` に現在の状態） |
| OVERLAP | 他の予約と重なっている（後から来た予約は拒否） |
| LIMIT_EXCEEDED | 予約は同時に3件まで |
| END_EXCEEDS_NEXT | 次の予約の開始時刻（`detail`）までしか延ばせない |
| NOT_FREE_NOW | 今は空いていない |
| CHECKIN_WINDOW_CLOSED | 開始15分後を過ぎたのでチェックインできない |
| ADVANCE_REQUIRED | 開始前なので、前倒しか予約なしの利用かを選ぶ必要がある |
| PREVIOUS_SLOT_OCCUPIED | 直前の時間帯が埋まっているので前倒しできない |
| NAME_CONFLICT | 同じ名前のリソースがある |
| ANNOUNCEMENT_NOT_FOUND | お知らせがない（削除済みを含む） |
| NOT_ADMIN | 管理者ではない |

---

## 6. 画面一覧

構成: `index.html`（利用者）と `admin.html`（管理者）の2ページ。画面内の切り替えとダイアログ（`<dialog>`）で構成する。外部ライブラリは CDN から読む: supabase-js、marked、DOMPurify、QR コード生成ライブラリ（管理画面のみ）。

### 利用者（index.html）

| ID | 画面・ダイアログ | 内容 |
|---|---|---|
| U1 | 入口処理 | `#t=...` があれば Cookie（`dx_token`、Max-Age 約400日、SameSite=Lax、Secure）に保存し、`history.replaceState` で消してから `check_token` を呼ぶ |
| U2 | Cookieなしの画面 | 「入口URL（QRコード）から開いてください」 |
| U3 | トークン無効の画面 | 「入口URLが更新されました。新しいQRコードから開いてください」 |
| U4 | トップページ | ヘッダー（再読み込みボタン、「16:42更新」、アカウントのメニュー）／重要なお知らせ／自分の予約カード（状態の文言とボタン: チェックイン・チェックアウト・変更・削除）／グリッド（日付の切り替え、現在時刻の線、列見出しの「今すぐ使う」）／お知らせの一覧。PC ではブレークポイントで左右2領域にする |
| U5 | 予約の作成 | タップした位置を開始にし、「+30分」「+1時間」などで終了を選ぶ。時刻の入力欄も置く。重複と上限は確定前に表示する。未ログインなら同じダイアログ内で U6 の入力を挟む |
| U6 | アカウントの作成・ログイン | 氏名、期生（「教員」のチェックで省略）、メモ |
| U7 | 同一人物の確認 | 既存の人の氏名・期生・メモを見せて「自分です（ログイン）」「別人です（表記を変える）」 |
| U8 | プロフィールの編集 | 氏名・期生・メモの変更。衝突時は U7 |
| U9 | 今すぐ使う | 終了時刻を選ぶ（次の予約の開始時刻までに制限）→ 確定 |
| U10 | 開始前のチェックイン | 「予約を前倒しする」「予約なしとして使う（→ U9）」を選ぶ |
| U11 | 予約の詳細 | 予約者の氏名とメモ（URL のみリンク化）。自分の予約なら変更・削除へ。PC はホバーで表示する |
| U12 | 予約の変更 | 開始時刻・終了時刻の変更 |
| U13 | リソースのメモ | 列見出しのタップで表示。Markdown → DOMPurify |
| U14 | お知らせの詳細 | 本文（Markdown）。localStorage の最終閲覧時刻で「新着」の印を付ける |
| — | エラー表示 | エラーコードを日本語の文に変換し、トーストで出す |

### 管理者（admin.html）

| ID | 画面 | 内容 |
|---|---|---|
| A1 | ログイン | メールアドレスとパスワード（Supabase Auth） |
| A2 | 予約の管理 | 利用者向けのグリッドを流用し、任意の予約の変更・削除・強制終了、枠の封鎖（理由つき）を行う |
| A3 | 利用者の管理 | 検索、編集、利用停止と解除、削除と復元 |
| A4 | リソースの管理 | 追加、名前・メモ（Markdown のプレビューつき）・並び順の変更、一時停止と再開、削除 |
| A5 | お知らせの管理 | 一覧（予定・公開中・終了・削除済み）、作成、編集、削除 |
| A6 | 入口URL | 現在の URL と QR コードの表示、再発行（確認つき） |
| A7 | ログの閲覧 | 期間・利用者・リソースで絞り込み、ページ送り |
| A8 | 管理者 | 一覧と追加（Edge Function を呼ぶ） |

### フロントのファイル構成（案）

```
index.html / admin.html / css/style.css
js/config.js      … Supabase の URL と anon キー（公開してよい値）。ホスト名でローカルと本番を切り替える
js/api.js         … supabase.rpc の薄いラッパーとエラーコードの変換
js/token.js       … 入口処理と Cookie
js/session.js     … localStorage の利用者 ID
js/grid.js        … グリッドの描画（admin でも使う）
js/markdown.js    … marked + DOMPurify
js/home.js        … トップページ
js/admin/*.js     … 管理画面の各タブ
```

---

## 7. 実装の順序

マイグレーションを分け、テスト先行で進める:
`schema`（スキーマ・テーブル・権限）→ `status`（状態の導出と共通処理）→ `user_rpc`（利用者とトークン）→ `reservation_rpc` → `admin_rpc` → Edge Function → フロント。

## 8. テストの観点

- `anon` でテーブルを直接参照できないこと（`has_table_privilege`）、全 RPC に `search_path` が設定されていること（`pg_proc.proconfig` を調べるテスト）、状態導出の境界（開始+15分ちょうど、`end_at = now()`）、同時予約で後から来たものが OVERLAP になること

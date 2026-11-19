# 理由のコード

- 状態：決定（2026-11-19 の詳細設計のレビューの後）
- 日付：2026-11-19
- 関係する要件：PRE-1, USR-1〜USR-6, ADM-2, ADM-3, TIM-3, TIM-6, TIM-7, RSV-2〜RSV-20, RSV-23, RSV-25, RSV-27, VIW-1, MNG-1〜MNG-3, SEC-3, NFR-4, FUT-1
- 前提：[screens-and-api.md](../basic/screens-and-api.md) 7（応答の形、頭と HTTP、コードは1つだけ）、[rules.md](rules.md) 1, 4（戻り値の形、確かめる順）、[api.md](api.md) 4（API に共通の確かめる順）、[auth.md](../basic/auth.md) 3, 8

ここでは、理由のコードの一覧の形と、すべての API のコードを決める。コードは `rules/`・`lib/`・`api/` が返し、画面の `public/js/messages.js` が文に直す。

## 1. 決まり

| 決まり | 内容 | 理由 |
| --- | --- | --- |
| 名前 | `頭_対象[_様子]`。大文字の英字・数字とアンダースコア | 頭で種類と HTTP が決まる（screens-and-api.md 7） |
| 頭と HTTP | `INPUT_` 400、`AUTH_` 401、`LIMIT_` 429、`NOT_FOUND_` 404、`STATE_` 409、`RULE_` 409 | 同上。HTTP は頭から機械的に決め、コードごとに変えない |
| `INPUT_` を返す場所 | `lib/` の入力の検証（rules.md 4 の段 1）と、本文の読み取り（下の `INPUT_BODY`）だけ | 「入力だけを見れば決まる」ものに限る。保存してある値と比べるものは `RULE_` にする |
| 足すだけ | 一度使い始めたコードは、名前も意味も変えず、消さない | 画面の `messages.js` とテストがコードの文字列に頼る。デプロイの直後に古い画面と新しい台帳が組み合わさっても、意味が食い違わない（api.md 5） |
| 例外 | 想定していない例外（バグ）にはコードを付けない。HTTP 500 で `{ "ok": false }` だけを返す | 断る理由ではない（screens-and-api.md 7）。画面は JSON として読めない応答と同じく汎用の文を出す |

画面は、知らないコード、コードのない応答、JSON として読めない応答（基盤の上限を超えて止まったときなど。FUT-1）のどれにも汎用の文を出す。

## 2. 一覧の形

頭ごとに表を分け、次の列で書く。

| 列 | 内容 |
| --- | --- |
| コード | 名前 |
| 要件 | 当たる要件の ID。テスト名はこの ID で始める |
| 返す API | API の一覧（api.md）での名前、または「すべて」「利用者の API」など |
| 段 | rules.md 4 の段（1〜8）、または api.md 4 の共通の段（共1〜共4） |
| 意味 | どういうときに返すか |

## 3. 一覧

### 3.1 `INPUT_`（400）

| コード | 要件 | 返す API | 段 | 意味 |
| --- | --- | --- | --- | --- |
| `INPUT_BODY` | RSV-27 | 本文を受け取るすべて | 共4 | 本文が JSON のオブジェクトでない、16 KiB を超える（design-values.md）、要る項目がない、項目の型が違う（文字列のはずが数値など） |
| `INPUT_LOGIN_ID` | ADM-2 | 管理者の作成（保守用の `POST /api/maint/admins`、管理者の画面からの `POST /api/admin/admins`） | 1 | 管理者の ID が、そろえた後に形式（auth.md 5）に合わない（rules.md 6.2） |
| `INPUT_NAME` | USR-5, ADM-2 | 管理者の作成（保守用・管理者の画面から）、利用者の入力（`POST /api/me`） | 1 | 名前（管理者の表示用の名前を含む）が USR-5 の条件に合わない（rules.md 6.2） |
| `INPUT_PASSWORD` | SEC-3 | 管理者の作成・パスワードの設定し直し（保守用・管理者の画面から。`…/admins/{id}/reset-password`） | 1 | パスワードが条件（auth.md 5）に合わない（rules.md 6.2） |
| `INPUT_ROLE` | USR-3 | 利用者の入力、利用者の操作の API（api.md 8.16） | 1 | 生徒か教員か（`role`）が `student`・`teacher` のどちらでもない（rules.md 6.4） |
| `INPUT_STUDENT_ID` | USR-4 | 利用者の入力、利用者の操作の API | 1 | 学籍番号が、そろえた後に、選んだ側（生徒・教員）の形式に合わない（rules.md 6.4） |
| `INPUT_COHORT` | USR-6 | 利用者の入力 | 1 | 生徒で、期生がない、数値でない、1以上の整数でない（rules.md 6.4）。教員では返さない（送られても無視する） |
| `INPUT_DEVICE_NAME` | MNG-1 | 機器の追加・名前の変更（`POST /api/admin/devices`、`…/{id}/rename`） | 1 | 機器の名前が、前後の空白を除いて1〜30文字でない、または改行・制御文字を含む（rules.md 6.6、design-values.md） |
| `INPUT_TIME` | TIM-3 | 確保（`POST /api/reservations`）、予約なしの利用（`POST /api/walk-ins`）、時間帯の変更（`POST /api/reservations/{id}/change`） | 1 | 境界の時刻が `YYYY-MM-DDTHH:mm` の形でない（秒・タイムゾーン付きを含む）、またはありえない日時（`02-30`、`24:00` など）（rules.md 6.8） |
| `INPUT_DATE` | VIW-1 | 予約状況（`GET /api/devices/{id}/day`） | 1 | クエリの `date` がない、`YYYY-MM-DD` の形でない、またはありえない日（rules.md 6.8） |
| `INPUT_SETTING_VALUE` | RSV-25 | 数値の変更（`POST /api/admin/settings`） | 1 | 数値の値が1以上の整数でない（小数・0・負の数）、または計算が正しく行える範囲を超える（rules.md 6.17）。値が数値でないときは `INPUT_BODY` |

- `INPUT_COHORT` は、項目の型の誤りも含む。期生は要るかどうかが生徒か教員かで変わるので、共4 の `INPUT_BODY` ではなく段 1 で確かめる（rules.md 6.4）。`role`・`student_id`・`name` の型の誤りは `INPUT_BODY`。

確保・予約なしの利用の本文の `device_id` が正の整数でないときは、項目の型の誤りとして `INPUT_BODY` にする（api.md 8.25、8.27）。数値の変更の本文の `key` が3つの数値のどれでもないときも `INPUT_BODY` にする（api.md 8.42）。管理者の画面からの作成・設定し直し（api.md 8.45・8.46）も、上の3つを保守用の API と同じ意味で返す。

### 3.2 `AUTH_`（401）

| コード | 要件 | 返す API | 段 | 意味 |
| --- | --- | --- | --- | --- |
| `AUTH_ORIGIN` | USR-1, ADM-2 | `GET` 以外のすべて（保守用の API を除く） | 共2 | `Origin` ヘッダがない、または自分のサイトと違う（auth.md 3 の CSRF の対策） |
| `AUTH_REQUIRED` | USR-1, USR-2, ADM-2 | 利用者の API、管理者の API | 共3 | 証明の Cookie がない、形が違う、または値のハッシュが表にない |
| `AUTH_REVOKED` | USR-2, ADM-2, ADM-3 | 利用者の API、管理者の API | 共3 | 証明は表にあるが止められている（利用を始めた版が現在の共有された情報の版と違う。管理者の認証を解いた、管理者が削除された、パスワードの版が違う） |
| `AUTH_MAINT_DISABLED` | ADM-2 | 保守用の API | 共3 | `MAINT_KEY` が設定されていない、または43文字より短い（design-values.md）。失敗として数えない（api.md 6） |
| `AUTH_MAINT_KEY_INVALID` | ADM-2, SEC-3 | 保守用の API | 共3 | `Authorization: Bearer 鍵` のヘッダがない、形が違う、または鍵が違う。失敗として数える（api.md 6） |
| `AUTH_ADMIN_FAILED` | ADM-2, SEC-3 | 管理者の認証（`POST /api/admin/login`） | 共3 | ID がない（形式に合わない、削除した管理者を含む）、またはパスワードが違う。どちらかを区別しない（auth.md 8）。失敗として数える（api.md 8.4、rules.md 6.3） |
| `AUTH_SHARED_INFO_UNSET` | USR-2, ADM-3 | 利用の開始（`POST /api/session`） | 共3 | 共有された情報が未設定（`shared_infos` が0行）。失敗として数えない（api.md 8.11） |
| `AUTH_SHARED_INFO_WRONG` | USR-2, ADM-3, SEC-3 | 利用の開始（`POST /api/session`） | 共3 | 送られた値が現在の共有された情報と違う。変更前の古い値、形の違う値（43文字の base64url でない）を含み、どれかを区別しない。失敗として数える（api.md 8.11、rules.md 6.3） |

- `AUTH_REQUIRED` と `AUTH_REVOKED` を分けるのは、画面で「QR コードが新しくなったので読み直してください」と案内できるようにするため（RSV-27。auth.md 8 も止められた証明を理由に挙げている）。分けても、外から新しく分かることは「その端末が以前に使えていたか」だけで、その端末の持ち主はもともと知っている。
- 利用者の API と管理者の API で同じコードを使う。どちらの証明かは呼んだ画面が知っている。
- `AUTH_MAINT_DISABLED` と `AUTH_MAINT_KEY_INVALID` を分けるのは、学校のアカウントが「シークレットを設定し忘れた」ことに気づけるようにするため。設定されていることが外にわかっても、鍵は256ビットのランダムな値なので推測できない。
- `AUTH_ADMIN_FAILED` は、ID やパスワードの形式が合わないときにも返す。管理者の認証では `INPUT_LOGIN_ID`・`INPUT_PASSWORD` を返さない。形式を教えると、ID の候補を外から絞り込めるため（api.md 8.4）。
- `AUTH_SHARED_INFO_UNSET` と `AUTH_SHARED_INFO_WRONG` を分けるのは、未設定の間（ADM-3「管理者が設定するまで誰も利用を始められない」）に、利用者が読み直しても直らないことを示せるようにするため。`WRONG` で古い値とまったく違う値を区別しないのは、過去の版のハッシュとすべて比べることになるため（api.md 8.11）。画面の文は「QR コードが古いか、正しくありません」とする。
- `GET /api/session` は断らず、`data.reason` に `AUTH_REQUIRED`・`AUTH_REVOKED` を入れて返す（api.md 8.13）。画面は同じ文を使う。

### 3.3 `LIMIT_`（429）

| コード | 要件 | 返す API | 段 | 意味 |
| --- | --- | --- | --- | --- |
| `LIMIT_ATTEMPTS` | SEC-3 | 利用の開始、管理者の認証、保守用の API | 共3 | 同じ相手からの失敗が、その10分の区切りで上限に達している（auth.md 7） |

### 3.4 `NOT_FOUND_`（404）

| コード | 要件 | 返す API | 段 | 意味 |
| --- | --- | --- | --- | --- |
| `NOT_FOUND_API` | RSV-27 | すべて | 共1 | そのメソッドとパスの API がない。パスの `{id}` が正の整数の形でないときも含む |
| `NOT_FOUND_ADMIN` | ADM-2 | パスワードの設定し直し（保守用・管理者の画面から）、管理者の削除（`POST /api/admin/admins/{id}/delete`） | 2 | その番号の管理者がいない、または削除されている（rules.md 6.1） |
| `NOT_FOUND_USER` | USR-3, USR-4 | 利用者の操作の API（api.md 8.16。`POST /api/me` を除く。確保（api.md 8.25）・予約なしの利用（8.27）・自分の予約（8.29）・取消（8.30）・時間帯の変更（8.32）・利用開始（8.34）・利用終了（8.35）で確かめる） | 2 | 送られた識別の組（生徒か教員か・そろえた学籍番号）の利用者がいない（`POST /api/me` をまだしていない）。段 2 の最初に確かめる |
| `NOT_FOUND_RESERVATION` | RSV-8, RSV-9, RSV-10, RSV-14, RSV-18, MNG-3 | 取消（`POST /api/reservations/{id}/cancel`）、時間帯の変更（`POST /api/reservations/{id}/change`）、利用開始（`POST /api/reservations/{id}/begin`）、利用終了（`POST /api/reservations/{id}/finish`）、管理者による取消・終了（`POST /api/admin/reservations/{id}/cancel`、`…/finish`） | 2 | その番号の予約がない、または送られた識別の組の利用者の予約でない（どちらかを区別しない。rules.md 2、6.12）。`NOT_FOUND_USER` の後に確かめる。管理者の API では本人を確かめず、予約がないときだけ返す（rules.md 6.16） |
| `NOT_FOUND_DEVICE` | MNG-1, MNG-2, MNG-3, VIW-1, RSV-2 | 機器の名前の変更・削除（`POST /api/admin/devices/{id}/rename`、`…/delete`）、予約の管理の一覧（`GET /api/admin/devices/{id}/reservations`）、予約状況（`GET /api/devices/{id}/day`）、確保（`POST /api/reservations`）、予約なしの利用（`POST /api/walk-ins`） | 2 | その番号の機器がない、または削除されている（rules.md 6.7、6.9 の `checkDeviceActive`） |

- `NOT_FOUND_USER` を受けた画面は、利用者の入力の画面に移る。利用者がいるかどうかが外からわかるが、利用者の入力をすればだれでも作れるので、隠しても守れるものがない（PRE-1）。

- `NOT_FOUND_RESERVATION` で他の利用者の予約を「ない」と同じに扱うのは、番号を変えて送っても他の利用者の予約の有無や状態がわからないようにするため（screens-and-api.md 7）。画面は受けたら自分の予約を読み直す。

### 3.5 `STATE_`（409）

| コード | 要件 | 返す API | 段 | 意味 |
| --- | --- | --- | --- | --- |
| `STATE_NOT_RESERVED` | RSV-8, RSV-14, RSV-23, MNG-3 | 取消（`POST /api/reservations/{id}/cancel`）、利用開始（`POST /api/reservations/{id}/begin`）、管理者による取消（`POST /api/admin/reservations/{id}/cancel`）。時間帯の変更では使わない（`STATE_NOT_ACTIVE`） | 3 | 本人の予約（管理者の API では、どの利用者の予約でも）だが、自動の変化を反映した後の状態が予約済でない（利用中・取消・無断不使用・終了・管理者による取消・管理者による終了）。すでに取り消した予約への2回目の取消、すでに利用中の予約への2回目の利用開始、猶予を過ぎて無断不使用になった予約の利用開始も含む（rules.md 6.12、6.14、6.16） |
| `STATE_NOT_ACTIVE` | RSV-9, RSV-10, RSV-23 | 時間帯の変更（`POST /api/reservations/{id}/change`） | 3 | 本人の予約だが、自動の変化を反映した後の状態が予約済・利用中のどちらでもない（取消・無断不使用・終了・管理者による取消・管理者による終了。rules.md 6.13） |
| `STATE_NOT_IN_USE` | RSV-18, RSV-19, RSV-23, MNG-3 | 利用終了（`POST /api/reservations/{id}/finish`）、管理者による終了（`POST /api/admin/reservations/{id}/finish`） | 3 | 本人の予約（管理者の API では、どの利用者の予約でも）だが、自動の変化を反映した後の状態が利用中でない（予約済・取消・無断不使用・終了・管理者による取消・管理者による終了）。2回目の利用終了、終了時刻を過ぎて自動で終了になった予約の利用終了も含む（rules.md 6.15、6.16） |

- 2回目の取消を成功にしないのは、結果の状態が取消とは限らず、何が起きたかが曖昧になるため（rules.md 6.12）。画面は受けたら自分の予約を読み直す。
- 管理者による取消・終了も同じコードを使う。意味がそのまま合い、コードを分けても伝わることが変わらない（rules.md 6.16）。管理者の画面は受けたら予約の管理の一覧を読み直す。
- `STATE_NOT_IN_USE` を受けた画面は、自分の予約を読み直す。終了時刻を過ぎて自動で終了になった後に押した場合も、結果は同じ「終了」なので、文は「すでに終了しています」でよい（screens.md）。
- `STATE_NOT_ACTIVE` を `STATE_NOT_RESERVED` と分けるのは、時間帯の変更は利用中も受け付けるので、「予約済でない」という意味と合わないため（rules.md 6.13）。画面は受けたら自分の予約を読み直す。

### 3.6 `RULE_`（409）

| コード | 要件 | 返す API | 段 | 意味 |
| --- | --- | --- | --- | --- |
| `RULE_PAST` | TIM-6, RSV-5, RSV-17, RSV-11 | 確保（`POST /api/reservations`）、予約なしの利用（`POST /api/walk-ins`）、時間帯の変更（`POST /api/reservations/{id}/change`） | 4 | 新たに指定する開始時刻が `nowMin` より前、または終了時刻が `nowMin` 以前。開始と終了を区別しない（rules.md 6.10）。予約なしの利用では終了時刻だけ（rules.md 6.11）。時間帯の変更では変える側の時刻だけ（変えない時刻には当てはめない。TIM-6、rules.md 6.13） |
| `RULE_START_PASSED` | RSV-11, RSV-10 | 時間帯の変更（`POST /api/reservations/{id}/change`） | 4 | 開始時刻を変えようとしたが、変更前の開始時刻が `nowMin` 以前（ちょうど開始時刻の分を含む）。利用中の予約の開始の変更（RSV-10）、猶予の中の予約済の開始の変更を含む。`RULE_PAST` より先に確かめる（rules.md 6.13） |
| `RULE_TIME_ORDER` | TIM-7, RSV-5 | 確保（`POST /api/reservations`）、時間帯の変更（`POST /api/reservations/{id}/change`） | 5 | 終了が開始より後でない。時間帯の変更では、変えない側の保存してある時刻と合わせて比べる。利用終了には当てはめない（TIM-7）。予約なしの利用では返さない（開始が `nowMin` なので段 4 を通れば必ず成り立つ。rules.md 6.11） |
| `RULE_ADMIN_ID_DUPLICATE` | ADM-2, RSV-23 | 管理者の作成（保守用・管理者の画面から） | 8 | そろえた後の管理者の ID が、ほかの管理者（削除した管理者を含む）の ID と同じ（rules.md 6.1） |
| `RULE_ADMIN_SELF_RESET` | ADM-2 | パスワードの設定し直し（管理者の画面からの `POST /api/admin/admins/{id}/reset-password`。保守用では返さない） | 8 | 対象が操作した管理者自身。自分のパスワードの変更は10章で除かれており、設定し直しは「他の管理者」が行う（ADM-2。rules.md 6.1、api.md 8.46） |
| `RULE_ADMIN_LAST` | ADM-2, RSV-23 | 管理者の削除（`POST /api/admin/admins/{id}/delete`） | 8 | 削除していない管理者が対象の1人だけ（最後の1人）。自分自身の削除でも同じ（rules.md 6.1、api.md 8.47） |
| `RULE_DEVICE_NAME_DUPLICATE` | MNG-1, RSV-23 | 機器の追加・名前の変更 | 8 | 前後の空白を除いた名前が、削除していないほかの機器の名前と完全に一致する（全角・大小はそろえない。rules.md 6.7） |
| `RULE_DEVICE_IN_USE` | MNG-2, RSV-23 | 機器の削除 | 8 | その機器に利用中の予約がある（自動の変化を反映した後。rules.md 6.7） |
| `RULE_LENGTH` | RSV-6, RSV-12 | 確保、予約なしの利用、時間帯の変更 | 6 | 時間帯の長さが、`nowMin` の時点の長さの上限を超える（rules.md 6.10、6.11）。時間帯の変更では、上限を超え、かつ変更前の長さより長いとき（RSV-12、rules.md 6.13）。利用開始の前倒しでは使わない（`RULE_BEGIN_LENGTH`） |
| `RULE_COUNT` | RSV-4, RSV-5, RSV-23 | 確保 | 7 | その利用者の予約済・利用中（予約なしの利用で始めたものを除く。全機器）の件数が、`nowMin` の時点の件数の上限に達している（rules.md 6.10） |
| `RULE_OVERLAP` | RSV-3, RSV-11, RSV-23 | 確保、予約なしの利用、時間帯の変更 | 8 | その機器の予約済・利用中の予約と時間帯が重なる（同じ人の予約を含む。rules.md 6.10）。予約なしの利用では、空いている（`RULE_DEVICE_BUSY` でない）が `[nowMin, 終了)` が後の予約と重なるとき（rules.md 6.11）。時間帯の変更では、その予約自身を除いて比べる（rules.md 6.13）。利用開始の前倒しでは使わない（`RULE_BEGIN_OVERLAP`） |
| `RULE_BEGIN_LENGTH` | RSV-6, RSV-15 | 利用開始（`POST /api/reservations/{id}/begin`） | 6 | 開始時刻より前に利用開始すると、`[nowMin, 終了)` の長さが `nowMin` の時点の長さの上限を超える。開始時刻まで待てば始められる。前倒しでない利用開始では返さない（rules.md 6.14） |
| `RULE_BEGIN_OVERLAP` | RSV-15, RSV-3, RSV-23 | 利用開始（`POST /api/reservations/{id}/begin`） | 8 | 開始時刻より前に利用開始しようとしたが、`[nowMin, 開始)` に同じ機器の予約済・利用中の予約がある（同じ人の予約を含む）。開始時刻まで待てば始められる。前倒しでない利用開始では返さない（rules.md 6.14） |
| `RULE_DEVICE_BUSY` | RSV-20, RSV-17, RSV-23 | 予約なしの利用（`POST /api/walk-ins`） | 8 | その機器に、`nowMin` を含む予約済・利用中の予約がある（機器が空いていない。自分の予約を含む）。`RULE_OVERLAP` より先に確かめる（rules.md 6.11） |

- `RULE_DEVICE_BUSY` を `RULE_OVERLAP` と分けるのは、利用者が「今は使えない」のか「終了時刻を早めれば使える」のかを見分けられるようにするため（RSV-27）。MNG-2 の `RULE_DEVICE_IN_USE` とも分ける。空いていないのは利用中に限らず、猶予の間の予約済でも空いていない。
- `RULE_START_PASSED` を `RULE_PAST` と分けるのは、`RULE_PAST` は入力を直せば通るが、`RULE_START_PASSED` はどう入力しても開始を変えられないことを、利用者が見分けられるようにするため（RSV-27。rules.md 6.13）。画面は「開始時刻を過ぎているので、変えられるのは終了時刻だけです」とする（screens.md）。
- `RULE_BEGIN_LENGTH`・`RULE_BEGIN_OVERLAP` を `RULE_LENGTH`・`RULE_OVERLAP` と分けるのは、確保などでは「時刻を直せば通る」が、利用開始には入力がなく「開始時刻まで待てば始められる」という意味になり、画面がコードだけで文を決められるようにするため。重なりと長さを1つのコードにまとめないのは、どちらで断ったかをテストで確かめるため（RSV-27。rules.md 6.14）。
- `RULE_ADMIN_SELF_RESET` を `NOT_FOUND_ADMIN` と分けるのは、対象はいるが自分なので断ったことを示し、画面が「ほかの管理者に頼むか、保守用の手順で設定し直してください」と案内できるようにするため。管理者の画面では自分の行に設定し直しのボタンを出さない（screens.md）ので、ふつうは画面からは届かない。
- `RULE_TIME_ORDER` を `INPUT_` にしないのは、時間帯の変更では保存してある値と比べるので、入力だけでは決まらないため（上の 1）。

## 4. テストの観点

| 観点 | 確かめること |
| --- | --- |
| 頭と HTTP | 応答の HTTP が、コードの頭から決まる値と一致する（台帳の層で、代表的なコードごとに） |
| 断る理由 | ルールのテストは `code` の文字列を確かめる（文は確かめない） |
| 例外 | 例外のときは 500 で `{ "ok": false }` だけを返し、`error` を含まない |

共通のコードを返す場面のテストは api.md 7 に書く。

## 採らなかった案

| 案 | 理由 |
| --- | --- |
| 段 5 を `INPUT_TIME_ORDER`（400）にする | 時間帯の変更では保存してある値と比べるので、入力だけでは決まらない。`INPUT_` を `lib/` の段 1 に限る区切りが崩れる |
| `AUTH_REVOKED` を作らず `AUTH_REQUIRED` にまとめる | 止められた端末に、読み直す理由を示せない |
| 例外に `INTERNAL_` などの頭を足す | 断る理由の体系（6つの頭）を変えることになる。画面の扱いは汎用の文で同じなので、コードが要らない |
| コードの名前を後から直せるようにする | 画面とテストが文字列に頼るので、直すたびに両方を合わせる必要があり、デプロイの直後に食い違う |

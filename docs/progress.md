# 進捗と引き継ぎ

セッションを終える前（`/clear` の前）に更新し、次のセッションはここから読み始める。決定の中身は設計文書に書き、ここには「どこまで進んだか」「次に何をするか」「保留していること」だけを書く。

最終更新：2026-11-19

## いまの段階

**基本設計と、そのレビューが終わった。** 基本設計の文書（下の表）がすべて決定になり、2026-11-17 のレビューで見つけたものを直した（下の「レビューで変えたこと」）。

**基盤の実測が終わり、設計文書に反映した（2026-11-18）。** OPN-1 も24時間に決めた。

**詳細設計に入った（2026-11-19）。** 方針を決めた（下の「詳細設計の方針」）。rules.md の枠組み（関数の形、2段の関数、store との分担、確かめる順、自動の変化）を書いた（2026-11-19 に開発者が了承）。ルールごとの節は機能ごとの設計で足す。schema.md（表・列・値・索引・初期データ・版の適用）を書いた（2026-11-19 に開発者が了承）。error-codes.md（コードの形と共通のコード、段 5 は `RULE_TIME_ORDER`）と api.md の共通部分（応答と要求の形、Worker と台帳の受け渡し、共通の確かめる順、版の食い違いへの備え、`curl` 手順の形）を書いた（2026-11-19 に開発者が了承）。これで共通の部分は終わり。

**機能ごとの設計の1つ目、保守用の API を書いた（2026-11-19 に開発者が了承）。** api.md 6（鍵の確かめ方、PowerShell の手順）・8.1〜8.3、error-codes.md 3 の7つのコード、rules.md 6.1（`checkAdminCreate`・`checkAdminPasswordReset`）・6.2（`toHalfWidthLower`・`validateLoginId`・`validateName`・`validatePassword`・`clientKey`）、design-values.md（`MAINT_KEY` は43文字以上）。あわせて api.md 4 の例外から保守用の API を外し（鍵はヘッダなので本文の誤りは鍵の後）、time-and-concurrency.md 4 の「包む理由」を直した（結論は同じ）。

**機能ごとの設計の2つ目、管理者の認証を書いた（2026-11-19 に開発者が了承）。** api.md 8.4（`login`。ID がなくてもダミーのソルトで PBKDF2 を1回計算して時間をそろえる、形式の誤りも `AUTH_ADMIN_FAILED` で数える、有効な Cookie があってもふつうに処理する、成功で失敗の数を戻さない、記録の `ip` は生の値）・8.5（管理者の API に共通の証明の確かめ方、共3 を通った応答はすべて Cookie を延ばす）・8.6（`me`）・8.7（`logout`。本文 `{}`）・8.8（台帳の層のテスト）、error-codes.md 3.2 の `AUTH_ADMIN_FAILED`、rules.md 6.3（`checkAttemptLimit`・`checkAdminLogin`・`checkAdminSession` と `lib/` の `windowStart`・`readCookie`・`isTokenFormat`・`adminCookie`・`clearAdminCookie`・`equalBytes`）。保守用の API の上限も `checkAttemptLimit` を使う形にした（api.md 6.1）。

**機能ごとの設計の3つ目、共有された情報の設定を書いた（2026-11-19 に開発者が了承）。** api.md 8.9（`POST /api/admin/shared-info`。本文 `{}`、包まない、値と SHA-256 は準備で `newToken()` で作る、`shared_infos` に1行足して `id` が版、応答は `{ value }` だけで URL は画面が作る、記録は `shared_info_set` の `version`、予約・管理者の証明・`user_sessions` に触れない、同時に押すと両方成功して後が勝つのは残るリスク）・8.10（台帳の層のテスト）、rules.md 6 の表（判定なしで関数を作らない）と 6.3 の `newToken`。8.4 の証明の値も `newToken()` で作る書き方にそろえ、api.md 1 の `console.error` に応答の本文も出さないことを足した。新しいコードはない。

**機能ごとの設計の4つ目、利用の開始を書いた（2026-11-19 に開発者が了承）。** api.md 8.11（`POST /api/session`。本文は `{ k }`、包まない、確かめる順は 有効な証明 → 上限（200）→ 本文 → 未設定 → 値。有効な証明があれば値も本文も見ずに成功を返して行を足さず、上限より先なので校内の回線が上限に達しても使えている端末は止まらない。未設定は数えない。形の違う `k` も `AUTH_SHARED_INFO_WRONG` で数える。古い値と違う値は区別しない。応答は `{}`。成功は記録しない）・8.12（利用者の API に共通の証明の確かめ方。版が違えば `AUTH_REVOKED`、共3 を通った応答は Cookie を延ばす）・8.13（`GET /api/session`。`{ active }` と、有効でなければ `reason` に `AUTH_REQUIRED`・`AUTH_REVOKED`）・8.14（台帳の層のテスト）、error-codes.md 3.2 の `AUTH_SHARED_INFO_UNSET`・`AUTH_SHARED_INFO_WRONG`、rules.md 6.3（`checkSharedInfo`・`checkUserSession`・`userCookie`）。design-values.md に足す値はない。

**機能ごとの設計の5つ目、利用者の入力を書いた（2026-11-19 に開発者が了承）。** api.md 8.15（`POST /api/me`。本文は `role`・`student_id`・`name`・`cohort`、包まない、段 1 は `INPUT_ROLE` → `INPUT_STUDENT_ID` → `INPUT_NAME` → `INPUT_COHORT`、期生は JSON の数値で型の誤りも `INPUT_COHORT`、教員の期生は無視して `NULL`、学籍番号の前後の空白は台帳では除かない、段 1 で断れば何も書かず自動の変化も反映しない、`decideUserInput` で作る・置き換える・変わらない、記録は `user_created`（`{name, cohort}`）と `user_renamed`（`{before, after}` に両方）、応答は `{ id, role, student_id, name, cohort }`）・8.16（利用者の操作の API に共通の利用者の引き方。識別の組を段 1 の最初に確かめ、段 2 の最初で `NOT_FOUND_USER`。名前・期生は読まない）・8.17（台帳の層のテスト。8.14 から回した `AUTH_REVOKED` を含む）、rules.md 6.4（`validateRole`・`validateStudentId`・`validateCohort`）・6.5（`decideUserInput`）、error-codes.md の `INPUT_ROLE`・`INPUT_STUDENT_ID`・`INPUT_COHORT`・`NOT_FOUND_USER`、schema.md 2.9 の `user_renamed` の `detail`。design-values.md に足す値はない（期生の上限は要件になく、`Number.isSafeInteger` の範囲を事実上の上限とした）。

**機能ごとの設計の6つ目、機器を書いた（2026-11-19 に開発者が了承）。** api.md 8.18（`GET /api/admin/devices`。削除していない機器を番号の順に `{ devices: [{ id, name }] }`）・8.19（`POST /api/admin/devices`。本文 `{ name }`、包まない、段 2・段 8 で断っても反映した自動の変化は残す）・8.20（`…/{id}/rename`。同じ名前への変更は `unchanged` で何も書かない、記録は `device_renamed` の `{before, after}`）・8.21（`…/{id}/delete`。本文 `{}`、利用中があれば `RULE_DEVICE_IN_USE` で何も変えない、予約済はすべて `admin_cancelled`・`cause = device_deleted`、記録は `device_deleted` を先に書き取消を番号の順に後に、取り消した件数は返さない）・8.22（`GET /api/devices`。識別の組を受け取らない、8.18 と同じ形）・8.23（台帳の層のテスト）、rules.md 6.6（`validateDeviceName`。前後の空白を除いて1〜30コードポイント、改行・制御文字を断る。MNG-1 にない条件だが開発者が了承）・6.7（`checkDeviceCreate`・`checkDeviceRename`・`checkDeviceDelete`。名前は全角・大小をそろえずに比べる）、error-codes.md の `INPUT_DEVICE_NAME`・`NOT_FOUND_DEVICE`・`RULE_DEVICE_NAME_DUPLICATE`・`RULE_DEVICE_IN_USE`、design-values.md（機器の名前の上限30）、schema.md 2.2・2.9（比べる列は足さない、`device_renamed` の `detail`）。予約状況（`GET /api/devices/{id}/day`）は予約の操作に、`GET /api/admin/devices/{id}/reservations` は予約の管理（MNG-3）に回した。

**予約の操作の1つ目、予約状況・確保を書いた（2026-11-19 に開発者が了承）。** rules.md 6.8（`lib/time.js`：`floorMinute`・`parseDateTime`・`parseDate`・`formatDateTime`・`formatDate`。正規表現の後に文字列へ戻して比べ、`02-30`・`24:00`・0〜99年を断る。年は4桁で9999年まで。日の誤りは `INPUT_DATE` として `INPUT_TIME` と分ける）・6.9（`checkDeviceActive`、`daySlots`。予約済・利用中・終了・管理者による終了を残し、長さ0の利用は開始時刻を含む日に出す。空きは返さず画面がすき間から描く）・6.10（`checkStartNotPast`・`checkEndNotPast`・`checkTimeOrder`・`checkLength`・`checkCount`・`checkOverlap` と `checkReserve`。`RULE_PAST` は開始と終了で分けない。件数は全機器で `walk_in = 0` だけ数える）、api.md 8.24（`GET /api/devices/{id}/day`。応答は `{ date, now, slots: [{ start, end, status, user_id, name, cohort }] }`、状態では SQL で絞らない）・8.25（`POST /api/reservations`。`device_id` の形の誤りは `INPUT_BODY`、応答は `{ id, device_id, start, end, status }`、記録は `reservation_created`）・8.26（台帳の層のテスト。8.17 から回した `NOT_FOUND_USER` を含む）、error-codes.md の `INPUT_TIME`・`INPUT_DATE`・`RULE_PAST`・`RULE_LENGTH`・`RULE_COUNT`・`RULE_OVERLAP`、schema.md 3（予約状況の条件を `end_at >= 日の始まり` に直した）。design-values.md に足す値はない。

**予約の操作の2つ目、予約なしの利用を書いた（2026-11-19 に開発者が了承）。** rules.md 6.11（`checkVacant`（RSV-20）と `checkWalkIn`。開始は受け取らず `{ ok: true, start: nowMin }` を返す。段 5 は段 4 を通れば必ず成り立つので確かめない。段 7 なし。段 8 は `RULE_DEVICE_BUSY` → `RULE_OVERLAP`）、api.md 8.27（`POST /api/walk-ins`。本文は識別の組・`device_id`・`end`、`start` は無視、利用者の予約は引かない、行は `in_use`・`walk_in = 1`、記録は `walk_in_started` だけ、応答は確保と同じ形で `status = 'in_use'`）・8.28（台帳の層のテスト）、error-codes.md（新しい `RULE_DEVICE_BUSY`。`INPUT_TIME`・`NOT_FOUND_USER`・`NOT_FOUND_DEVICE`・`RULE_PAST`・`RULE_LENGTH`・`RULE_OVERLAP` の「返す API」に足し、`RULE_TIME_ORDER` から予約なしの利用を外した）。design-values.md に足す値はない。

**予約の操作の3つ目、自分の予約・取消を書いた（2026-11-19 に開発者が了承）。** rules.md 6.12（`checkMyReservations`：段 2 で `NOT_FOUND_USER`、予約済・利用中を開始時刻の順に。予約なしの利用で始めたものも出す。`checkCancel`：段 2 `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION`（他人の予約も同じ）、段 3 `STATE_NOT_RESERVED`（2回目の取消・利用中も断る）、段 4〜8 なし）、api.md 8.29（`POST /api/my/reservations`。本文は識別の組だけ、応答は `{ now, reservations: [{ id, device_id, device_name, start, end, status }] }`、記録なし）・8.30（`POST /api/reservations/{id}/cancel`。予約は番号だけで引く、`status = 'cancelled'`・`cause = NULL`・時刻は変えない、記録は `reservation_status` の `{from, to}`、応答は確保と同じ形）・8.31（台帳の層のテスト）、error-codes.md の `NOT_FOUND_RESERVATION`・`STATE_NOT_RESERVED`。design-values.md に足す値はない。

**予約の操作の4つ目、時間帯の変更を書いた（2026-11-19 に開発者が了承）。** rules.md 6.13（`checkStartNotPassed`（RSV-11。`nowMin < 変更前の開始`）・`checkChangeLength`（RSV-12。上限以下か変更前以下）と `checkChange`。段 2 は取消と同じ、段 3 `STATE_NOT_ACTIVE`（予約済・利用中でない）、段 4 は変える側だけ `RULE_START_PASSED` → `RULE_PAST`、段 5 は変えない側の今の値と合わせて、段 7 なし、段 8 は自分を除く `RULE_OVERLAP`。利用中の開始の変更は、利用中の開始が必ず `nowMin` 以下なので `RULE_START_PASSED` で断り、RSV-10 の判定を別に置かない。RSV-11 の終了の条件は反映した後に必ず成り立つので確かめない。両方とも変えないときは `unchanged`）、api.md 8.32（`POST /api/reservations/{id}/change`。本文は識別の組・`start`・`end`（両方必須、変えない側は今の値）、`device_id` は無視、`unchanged` は何も書かない、記録は `reservation_time_changed` の `{before, after}` に両方の時刻、応答は確保と同じ形）・8.33（台帳の層のテスト。変更後の開始での猶予 RSV-26 を含む）、error-codes.md（新しい `STATE_NOT_ACTIVE`・`RULE_START_PASSED`。`INPUT_TIME`・`NOT_FOUND_USER`・`NOT_FOUND_RESERVATION`・`RULE_PAST`・`RULE_TIME_ORDER`・`RULE_LENGTH`・`RULE_OVERLAP` の「返す API」に足した。`STATE_NOT_RESERVED` は時間帯の変更では使わない）、schema.md 2.9（`reservation_time_changed` の `detail`）。design-values.md に足す値はない。

**機能を縦に切る順を決めた（2026-11-19 に開発者が決定）。** 実際に使う順に進める：保守用の API（管理者の作成・パスワードの設定し直し）→ 管理者の認証 → 共有された情報の設定 → 利用の開始 → 利用者の入力 → 機器 → 予約の操作。理由：何にも頼らないものから積むので、各段を手元の `wrangler dev` で前の段の結果を使って手で確かめられ、食い違いをその段で設計に戻せる。PBKDF2 と処理全体を `blockConcurrencyWhile` で包む経路（architecture.md 3 の唯一の例外）を、画面のない最初の段で片付けられる。採らなかった案：利用の開始から利用者側を先に進め、管理者側を後に回す。予約のルールには早く着く（確保が4段目、こちらは7段目）が、共有された情報を作る手段が管理者の画面しかないので、管理者側ができるまで利用者の画面を手で通せない。

**予約の操作の分け方と、管理者側の残りの順を決めた（2026-11-19 に開発者が決定）。** 予約の操作は、予約のルールの大半が入り1つの作業には大きいので、5つの作業に分ける：①予約状況・確保（`lib/time.js`・`INPUT_TIME`・`GET /api/devices/{id}/day`・RSV-2〜RSV-6・VIW-1・VIW-2）→ ②予約なしの利用（RSV-17, RSV-20）→ ③自分の予約・取消（RSV-7, RSV-8）→ ④時間帯の変更（RSV-9〜RSV-12）→ ⑤利用開始・利用終了（RSV-13〜RSV-16, RSV-18, RSV-19）。①で時刻と重なりの共通の部品を固めてから後を積む。管理者側の残りは予約の操作の後に、予約の管理（MNG-3）→ 数値の変更（RSV-25）→ 管理者の画面からの管理者のアカウント（ADM-2）の順に置く。理由：MNG-3 は予約の状態と利用終了の判定を使い、RSV-25 は RSV-22・RSV-26 を利用開始と無断不使用の判定を書いた後に詰められ、ADM-2 は他に頼らない。採らなかった案：RSV-25 を予約の操作の前に置く（手で確かめるときに猶予や上限を小さくできるが、RSV-26 を無断不使用の判定より先に詰めることになり、⑤で直すおそれがある。自動テストは時計を差し替えるので影響しない）。ADM-2 を管理者側の残りの先頭に置く（中身は変わらず、得るものがない）。実装の段階（下の「進め方」3）も同じ順に進める。

## 詳細設計の方針（2026-11-19 に開発者が決定）

### 進め方：詳細設計を最後まで書いてレビューし、その後に機能ごとに実装する（2026-11-19 に開発者が変更）

1. **詳細設計**：共通の部分（済み）の後、機能ごとの設計（ルールの詳細・API・画面）を、上の「機能を縦に切る順」で最後の機能まで書く。1つの機能の設計を1つの作業とする。
2. **詳細設計のレビュー**：すべての文書を通して、要件の ID の抜け、文書どうしと基本設計との食い違いを確かめて直す。
3. **機能ごとの実装と個別のテスト**：同じ順で1つずつ実装し、その機能の自動テスト（ルール・部品・台帳の層）と手での確認を済ませてから次に移る。実装で設計との食い違いがわかったら、設計文書を先に直してから進める。
4. **結合テスト**：すべての機能をつないで、手元の `wrangler dev` で screens.md の手で確かめる手順を通しで行う。
5. **デプロイ**：GitHub Actions のデプロイのジョブで行う。

当初の案（共通の部分の後、機能ごとに設計と実装を交互に進める）から変えた。交互に進める案を採らなかったときの懸念（実装で見つかる問題の反映が遅れる）は、3 で設計に戻すことで受ける。

### 文書の分け方（`docs/design/detailed/`）

| 文書 | 決めること | 対応する `src/` |
| --- | --- | --- |
| `schema.md` | 表の定義（列・型・制約・索引）、初期データ、スキーマの版と起動時の順の適用 | `store/` |
| `rules.md` | ルールごとの判定の手順、関数の入出力、複数のルールに反するときに確かめる順、自動の変化を反映する手順、ルールのテストの観点 | `rules/`、`lib/` |
| `error-codes.md` | 理由のコードの一覧（コード・HTTP・要件の ID・どこで返すか） | `rules/`、`public/js/messages.js` |
| `api.md` | API ごとの入出力と返しうるコード、保守用の API の `curl` 手順、Worker と台帳の受け渡し、台帳の層のテストの観点 | `api/`、`ledger.js`、`index.js` |
| `screens.md` | 画面ごとの項目と動き、エラーの表示、手で確かめる手順の一覧 | `public/` |

- コードの一覧を独立させるのは、rules・api・画面の3か所が同じコードを使うため。
- テストの観点は、観点だけの文書を作らず各文書に書く（テスト名が要件の ID で始まるので、ID で横断して探せる）。
- 書く順：rules.md → schema.md → error-codes.md・api.md → screens.md。

### 粒度

- 判定の条件、境界（TIM-2）、確かめる順、返すコードまで、実装で迷わない程度に書く。
- rules.md にはコードを書かない。関数の名前・引数・戻り値と判定の手順を文章と表で書く（設計とコードを二重に持たないため。コードはバイブコーディングで Claude が書く。CLAUDE.md「開発の進め方」）。
- schema.md の `CREATE TABLE` は書いてよい（定型の部分）。

### 基本設計から持ち越した事項の割り振り

| 事項 | 決める文書 |
| --- | --- |
| TIM-7 で長さ0の時間帯を認めるので、予約の表に「終了 > 開始」の制約を付けない | schema.md |
| スキーマの版と移行の仕組み（architecture.md 7） | schema.md |
| 記録の表と予約の表の索引（logging.md 5） | schema.md |
| 機器の名前の上限（MNG-1） | rules.md 6.6（30文字。design-values.md に足した。2026-11-19） |
| 確かめる順と、コードを1つだけ返すこと（screens-and-api.md 7） | rules.md、api.md |
| デプロイ直後に Worker と台帳の版が食い違うかもしれないこと（実測で気づいたもの。下の「基盤の実測で決めたこと」） | api.md（受け渡しの形）。5 で決めた |
| 保守用の API の `curl` 手順（screens-and-api.md 5） | api.md。6 で形を決めた。本文の項目は管理者のアカウントの機能で |
| 手で確かめる手順の一覧（testing-and-deploy.md 1） | screens.md |

### 次の作業

1. 予約の操作の5つ目「利用開始・利用終了」（RSV-13〜RSV-16, RSV-18, RSV-19）の詳細設計（実装はしない）。まず設計を示して了承を得る。決めることの例：`POST /api/reservations/{id}/begin`・`…/finish` の本文、開始時刻より前の利用開始（RSV-15。`[nowMin, 開始)` に他の予約がないこと、変更後の長さ RSV-6、`RULE_OVERLAP` を使うか別のコードか）、RSV-16 の終了時刻までの利用開始、利用開始の状態のコード（`STATE_NOT_RESERVED` を使うか）、利用終了の状態のコード、長さ0の終了（TIM-7）、記録（`reservation_status` に書き換えた時刻を入れるか、前倒しで `reservation_time_changed` も書くか。schema.md 2.9）。
   - screens.md に回すこと（時間帯の変更の設計で出たもの）：開始・終了の欄の初期値は今の値（変えない側はそのまま送る）、利用中と開始時刻を過ぎた予約済では開始の欄を変えられなくする（応答の `status`・`now` から決める。TIM-1）、`RULE_START_PASSED` の文は「開始時刻を過ぎているので、変えられるのは終了時刻だけです」、`STATE_NOT_ACTIVE`・`NOT_FOUND_RESERVATION` を受けたら自分の予約を読み直す、成功したら自分の予約と予約状況を取り直す（VIW-3）。
   - screens.md に回すこと（自分の予約・取消の設計で出たもの）：応答の `status` と `now` から出す操作（取消・時間帯の変更・利用開始・利用終了）を決める（TIM-1）、取消の前に「取り消しますか」の確かめを置くか、`NOT_FOUND_RESERVATION`・`STATE_NOT_RESERVED` を受けたら自分の予約を読み直す、取消が成功したら自分の予約と予約状況を取り直す（VIW-3）、機器の名前は `textContent` で入れる（SEC-1）。
2. 予約の管理（MNG-3）→ 数値の変更（RSV-25）→ 管理者の画面からの管理者のアカウント（ADM-2）の詳細設計。1つずつ別の作業とする。`GET /api/admin/devices/{id}/reservations` は MNG-3 で決める（api.md 8.21 の後の注）。
   - screens.md に回すこと（予約なしの利用の設計で出たもの）：「予約なしの利用」は終了時刻だけを入れる（開始は送らない）、`RULE_DEVICE_BUSY` と `RULE_OVERLAP` の文の出し分け（今は使えない／終了時刻を早めれば使える）、自分の予約が今の時刻にかかっているときの `RULE_DEVICE_BUSY` で利用開始を案内するか、終了時刻の初期値を応答の `now` から作る（TIM-1）、成功したら予約状況を取り直す（VIW-3）。
   - screens.md に回すこと（予約状況・確保の設計で出たもの）：空きは確保済み（予約済・利用中）のすき間として描く、確保済みと利用があった時間帯（終了・管理者による終了）を区別して描く、日をまたぐ予約はその日の範囲に切って描く、日と時刻の初期値は応答の `now` から作り端末の時計に頼らない（TIM-1）、時刻の入力は `datetime-local`（既定の刻み）、時刻の表示は `timeZone: 'Asia/Tokyo'`、`RULE_PAST` は入力と `now` からどちらの欄かを示すか、確保が成功したら予約状況を取り直す（VIW-3）、`NOT_FOUND_DEVICE` を受けたら機器の一覧を読み直す、名前は `textContent` で入れる（SEC-1）。
   - screens.md に回すこと（機器の設計で出たもの）：機器の選択肢・一覧の名前は `textContent` で入れる（SEC-1）、名前の欄の上限30文字（画面の検証は使いやすさのためだけ）、削除の前に「削除しますか」の確かめを置くか（影響範囲の事前表示は10章で除かれている）、`NOT_FOUND_DEVICE` を受けたら一覧を読み直す、機器が1つもないときの表示、押している間にボタンを止めて二重に送らないこと。
   - screens.md に回すこと（利用者の入力の設計で出たもの）：生徒か教員かの選び方と、教員では期生の欄を隠すこと、期生の欄の値を数値に直して送ること（空なら送らない）、学籍番号の前後の空白を画面で除くか、`NOT_FOUND_USER` を受けたら利用者の入力の画面に移ること、応答の `student_id`（そろえた値）を変数に持って以後の操作に使うこと、名前の置き換えの前の確認は作らない（10章）。
   - screens.md に回すこと（利用の開始の設計で出たもの）：`AUTH_SHARED_INFO_WRONG` の文は「QR コードが古いか、正しくありません」、`AUTH_REQUIRED`・`AUTH_REVOKED` の案内の出し分け（`GET /api/session` の `reason` を使う）、`#k=` 付きで開いたら `GET` を呼ばずに `POST` を送り、送ったら `history.replaceState` で消す（auth.md 2）。
   - screens.md に回すこと（共有された情報の設定の設計で出たもの）：QR コードのライブラリ（qrcode-generator）の版の固定と描き方、押す前に「変更しますか」の確かめを置くか（影響範囲の事前表示は10章で除かれている）、押している間にボタンを止めて二重に送らないこと、利用者の画面の URL の作り方（`location.origin` ＋ `/` ＋ `#k=値`）。

実装の段階（上の「進め方」3）に回すこと：土台（`package.json`・`.nvmrc`・`wrangler.jsonc`・Vitest の設定。Node は手元が v26.13.0、wrangler は spike で 4.163.0 を使った）、台帳の骨組み（api.md 3 の経路の表と共通の流れ、1 の応答、4 の共通の確かめる順）と schema.md 5 の版の適用。api.md 3.4 と schema.md 5.4 の基盤の機能は spike で確かめた（2026-11-19。下の「schema.md で決めた持ち越し事項」）ので、実装では台帳の層のテストに書くだけでよい。GitHub Actions は、実装の段階ではテストのジョブだけを作り、デプロイのジョブは結合テストの後に作る（Cloudflare の API トークンは学校のアカウントが作る。PRE-11 は未定）。

schema.md で決めた持ち越し事項：終了 > 開始の制約を付けない（2.3）、記録と予約の索引（3）、版と適用（5）。DO の SQLite で外部キーが確かめられること、`AUTOINCREMENT` と `STRICT` が使えること、索引が使われること、`transactionSync` の取り消し、`stub.fetch` でヘッダと本文が届くことは、詳細設計を続ける前に spike（`/schema-check`、`/headers`）で確かめた（2026-11-19。手元と本番の基盤の両方で期待どおり。schema.md 1・3、api.md 3.4）。spike は個人のアカウントに送り直した。

（上の分け方は design/README.md「詳細設計の文書」に書いた。2026-11-19）

文書の分け方と、基本設計で作る文書の一覧は [design/README.md](design/README.md) を見る。

## 基本設計の状態

| 文書 | 状態 |
| --- | --- |
| [design/basic/platform-selection.md](design/basic/platform-selection.md) | 決定（実測済み） |
| [design/basic/architecture.md](design/basic/architecture.md) | 決定 |
| [design/basic/domain-model.md](design/basic/domain-model.md) | 決定 |
| [design/basic/time-and-concurrency.md](design/basic/time-and-concurrency.md) | 決定 |
| [design/basic/auth.md](design/basic/auth.md) | 決定 |
| [design/basic/screens-and-api.md](design/basic/screens-and-api.md) | 決定 |
| [design/basic/logging.md](design/basic/logging.md) | 決定 |
| [design/basic/testing-and-deploy.md](design/basic/testing-and-deploy.md) | 決定 |
| [design/basic/design-values.md](design/basic/design-values.md) | 作成（各文書で値が決まるたびに足す） |

機器の名前の上限（MNG-1）は詳細設計で30文字に決めた（rules.md 6.6）。OPN-1 は24時間に決めた（platform-selection.md 実測の結果 4）。

## 決まったこと（要点）

- 基盤は Cloudflare Workers の無料プランで、カードは登録しない。予約台帳は Durable Object（SQLite）に置き（D1 は使わない。実測で決定）、書き込みを順に処理する（RSV-23）。画面は Workers が配る静的ファイル。テストは Vitest、デプロイは wrangler と GitHub Actions。
- 採らなかった案と理由：Supabase は NFR-5、GAS は SEC-3 と NFR-2、Firebase は PRE-2 を満たせない。
- 構成：すべてのデータと API の処理を1つの Durable Object（台帳）に置き、Worker は静的ファイルと振り分けだけ。ルールの判定は `src/rules/` の純粋な関数、SQL は `src/store/` だけに書く。画面はフレームワークもビルドも使わない。
- データ：数値の設定は上書きせず履歴で持つ（猶予は開始時刻の時点の値を引く。RSV-26）。予約は利用者の番号だけを持ち、名前は写さない（USR-7）。猶予のうちで予約済なら本人が取り消せる（RSV-8 の読み方。確認済み）。
- 時刻と排他：時刻は UTC のミリ秒で持ち、日本時間は9時間を足す。自動の変化は、どのリクエストでも先に `nowMin` 以下の分を反映する。`await` を挟まずに処理し、ハッシュの計算だけ `blockConcurrencyWhile` で包む（リクエストの処理の中でも動くことを実測で確認）。
- 認証：共有された情報は台帳が作るランダムな値で、QR コード（利用者の画面の URL の `#k=値`）でだけ渡す。作り直すと全端末が止まる。証明は Cookie のランダムな値で、台帳は SHA-256 を持ち、版で止める。期限はなし。試行は同じ IP からの失敗を10分ごとに数える（共有された情報は200回、管理者は10回、保守用は5回）。学校のアカウントは保守用の API（`MAINT_KEY`）で管理者を作る。管理者のパスワードは PBKDF2 を10万回反復する。
- 画面と API：HTML は利用者用と管理者用の2つで、中は JavaScript で切り替える。利用者の入力（`POST /api/me`）だけで名前を置き換え、その後の操作は識別の組だけを本文で送る。`GET` は読むだけ、ほかは `POST` で動詞を URL に書く。時刻は `YYYY-MM-DDTHH:mm`（日本時間）。断る理由のコードは1つで、頭は `INPUT_`・`AUTH_`・`LIMIT_`・`NOT_FOUND_`・`STATE_`・`RULE_`。
- 記録：出来事の記録（消さない）と認証の失敗（入口・IP・10分ごとに1行。上限後は書かない。10,000行を超えたら古いものから消す）の2つの表に分ける。5年分で想定の規模は約50MB、10倍で約510MB。
- テストとデプロイ：ルール・部品・台帳の3層で自動テストし、テスト名は要件の ID で始める。画面・NFR-1・NFR-2 は手で確かめる。GitHub Actions でテストが通ったときだけ `main` からデプロイし、手元からはデプロイしない。
- 学校のアカウント（PRE-11）は未定。メールで登録できることだけを前提にしている。
- GitHub は PRE-11 の対象外とする（2026-11-17 に確認済み）。

## レビューで変えたこと（2026-11-17）

- 現在時刻は、`await` が要る準備の後、同期の区間の直前に取る。台帳の本体は時計を受け取る（`handle(request, clock)`）。処理の順と時刻の順をそろえるため（RSV-22。time-and-concurrency.md 2）。
- 予約状況の API は `GET` にし、識別の組を受け取らない。台帳は「自分の予約の印」を付けない（要件にない）。応答には利用者の内部の番号を入れておくが、v0.1.0 の画面は使わない（screens-and-api.md 5）。
- 共有された情報の試行の上限を、10分ごとに20回から200回に上げた（auth.md 7）。
- 有効な証明を持つ端末が QR コードを読み直しても、新しい証明を作らない（auth.md 2）。
- 静的ファイルは基盤の機能が返し、Worker のコードは `/api/*` だけを受ける、と書き方をそろえた（architecture.md 1）。
- 同時の操作（RSV-23）を台帳の層でテストする方法を足した（testing-and-deploy.md 1）。
- 確認済みにした読み方：GitHub は PRE-11 の対象外（platform-selection.md）、認証の失敗は上限後に書かない（logging.md）。
- 文書どうしの軽い食い違い（domain-model.md の見積もり・管理者の項目・「だれが」、platform-selection.md の残るリスク、design-values.md、design/README.md）を直した。

## 基盤の実測で決めたこと（2026-11-17〜18）

結果と理由は platform-selection.md「実測の結果」にある。測ったのは開発者の個人の Cloudflare アカウント（無料プラン）で、spike を手元から deploy した（開発者が了承）。Worker の名前は `dxplace-spike`、URL は `https://dxplace-spike.dxp-spike.workers.dev`。測り終えたら `npx wrangler delete` で消す。

- データはすべて DO の SQLite に置く。管理画面の Data Studio で読めて、SQL も実行できた（LOG-6）。
- PBKDF2 の反復回数は100,000回にする。パスワードの条件は変えない（2026-11-18 に開発者が A 案に決定）。台帳の中なら、Worker の CPU 10msの制限は効かない。
- 校内の回線から届く。応答は1秒前後。ただし応答した拠点は米国だった。
- OPN-1 は24時間にする（2026-11-18 に開発者が決定）。使われなかった後の1回目に、基盤による遅れは見えなかった。
- `blockConcurrencyWhile` は、リクエストの処理の中でも文書どおりに動く。
- 気づいたこと（未確認）：spike を送り直した直後に1回だけ、新しい Worker が古い DO を呼んだような応答が返った。デプロイの直後は、Worker と台帳の版が少しの間食い違うかもしれない。詳細設計で台帳との受け渡しの形を決めるときに考える。

## 保留していること

- **NFR-2 の確かめ方**：要件は「校内の通常の回線と手持ちのスマートフォン」で測ることを求めている。しかし手持ちのスマートフォンは、学校のルールで校内の回線につなげない。開発者は、校内の回線につながる PC と、携帯の回線につないだスマートフォンの両方で測る予定（2026-11-17）。スマートフォンは、iOS と Android の両方を用意できるかわからないので後に回す。要件どおりには測れないので、要件を決めた人と相談が要る。あわせて、利用者が実際に予約するときにどの回線を使うかも確かめる。
- **まだ確かめていないこと**：長い休みの後の最初のリクエストで、たまった自動の変化をまとめて反映する重さ（本物のコードができてから測る。DO の中なら10msではなく30秒の制限。OPN-1 の24時間の例外に収まるかも、ここで確かめる）、1日の上限を超えて止まっている間も静的ファイルが配られるか（FUT-1）。DO の1日の上限（リクエスト10万回、稼働時間 13,000 GB-s）は logging.md 5 の表に足した。
- **FUT-3 の控えの置き場所**：DO の外に置く場所が決まっていない。公開前に決める（platform-selection.md の FUT-3 の行）。30日に戻せる機能が無料プランで使えるかは、まだ確かめていない。
- **実測用のコード `spike/`**：Git の対象外で、この PC にだけある。wrangler は `spike/` の中に入れた（`spike/package.json`）。ログインは `npx wrangler login`（PC のアカウントに残っている）。2026-11-17 に、DO の中の PBKDF2（`/do-pbkdf2?iter=&rep=&bcw=&wait=`）と `idle.js` を足した。2026-11-19 に `/schema-check`（SQLite の機能）と `/headers`（台帳へのヘッダと本文の受け渡し）を足し、送り直した。実測は終わったので、Worker は `npx wrangler delete` で消してよい（開発者が決める）。

## 未解決の質問・確認事項


- architecture.md から持ち越し：PBKDF2 の `await` の間に他のリクエストが割り込みうる（管理者のパスワードを扱う操作だけ `blockConcurrencyWhile` で包むと決めた。リクエストの処理の中でも動くことは実測で確かめた。台帳の層のテストでも確かめる）。USR-7 の名前の置き換えは `POST /api/me` だけで行う（確認済み。screens-and-api.md）。

## 次のセッションの始め方

1. このファイルと [design/README.md](design/README.md) を読む。
2. 「いまの段階」の作業に着手する。設計を示すときは、構成・理由・主な代替案を簡潔に出す（CLAUDE.md「開発の進め方」）。

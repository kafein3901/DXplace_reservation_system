# 進捗と引き継ぎ

セッションを終える前（`/clear` の前）に更新し、次のセッションはここから読み始める。決定の中身は設計文書に書き、ここには「どこまで進んだか」「次に何をするか」「保留していること」だけを書く。

最終更新：2026-11-20

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

**予約の操作の5つ目、利用開始・利用終了を書いた（2026-11-19 に開発者が了承）。これで予約の操作は終わり。** rules.md 6.14（`checkBeginLength`（RSV-6）・`checkBeginOverlap`（RSV-15。`[nowMin, 開始)`）と `checkBegin`。段 2 は取消と同じ、段 3 `STATE_NOT_RESERVED`（2回目の利用開始も）、段 4・5 なし（反映した後の予約済は猶予のうち・RSV-16 の終了時刻までが必ず成り立つ）、前倒し（`nowMin < 開始`）のときだけ段 6 `RULE_BEGIN_LENGTH`（RSV-12 の緩和は使わない）→ 段 8 `RULE_BEGIN_OVERLAP`、「何分前から」の制限なし、`{ ok, start }` を返す）・6.15（`checkFinish`。段 3 `STATE_NOT_IN_USE`、段 4〜8 なし、長さ0を認める、`{ ok, end: nowMin }`）、api.md 8.34（`POST /api/reservations/{id}/begin`。本文は識別の組だけ、`status = 'in_use'`・`start_at` は返された値、記録は `reservation_status` の1行で、前倒しなら `detail` に `start_at` の `{before, after}`）・8.35（`…/finish`。`status = 'finished'`・`end_at = nowMin`・`cause = NULL`、記録の `detail` に `end_at` の `{before, after}`）・8.36（台帳の層のテスト）、error-codes.md（新しい `STATE_NOT_IN_USE`・`RULE_BEGIN_LENGTH`・`RULE_BEGIN_OVERLAP`。`NOT_FOUND_RESERVATION`・`NOT_FOUND_USER`・`STATE_NOT_RESERVED` の「返す API」に足した）。前倒しを断るコードを `RULE_OVERLAP`・`RULE_LENGTH` と分けたのは、利用開始では「開始時刻まで待てば始められる」という意味になり、画面がコードだけで文を決められるようにするため。前倒しの記録を1行にまとめるため、基本設計の logging.md 2 を先に直し（「RSV-15 の前倒し」を時間帯の変更から状態の変化の書き換えた時刻へ移した）、schema.md 2.9 を合わせた。design-values.md に足す値はない。

**管理者側の残りの1つ目、予約の管理（MNG-3）を書いた（2026-11-19 に開発者が了承）。** rules.md 6.16（`src/rules/admin-reservations.js`：`checkDeviceReservations`（段 2 `checkDeviceActive` → `NOT_FOUND_DEVICE`、予約済・利用中を開始時刻の順）・`checkAdminCancel`（段 2 `NOT_FOUND_RESERVATION`、段 3 `STATE_NOT_RESERVED`）・`checkAdminFinish`（段 3 `STATE_NOT_IN_USE`、`{ ok, end: nowMin }`、長さ0を認める）。本人の確かめはなく、利用者の関数に引数を足して兼ねない）、api.md 8.37（`GET /api/admin/devices/{id}/reservations`。応答は `{ reservations: [{ id, start, end, status, role, student_id, name }] }`、期生・`walk_in`・`now` は入れない）・8.38（`POST /api/admin/reservations/{id}/cancel`。本文 `{}`、`status = 'admin_cancelled'`・`cause = 'admin_action'`、記録は `reservation_status` の `{from, to, cause}` と `actor_admin_id`）・8.39（`…/finish`。`status = 'admin_finished'`・`end_at = nowMin`・`cause = 'admin_action'`、記録の `detail` に `end_at` の `{before, after}`）・8.40（台帳の層のテスト）、error-codes.md（`NOT_FOUND_RESERVATION`・`NOT_FOUND_DEVICE`・`STATE_NOT_RESERVED`・`STATE_NOT_IN_USE` の「返す API」と意味に管理者の API を足した。新しいコードはない）。schema.md・design-values.md に足すものはない。

**管理者側の残りの2つ目、数値の変更（RSV-25）を書いた（2026-11-19 に開発者が了承）。** rules.md 6.17（`SETTING_KEYS` を `src/rules/settings.js` に置く、`lib/` の `validateSettingValue`（1以上の整数。実用上の上限は置かず、件数は `Number.isSafeInteger`、分の2つは `v * 60000` も安全な整数の範囲を事実上の上限にする。design-values.md には足さない）、`currentSettings`、`decideSettingChange`（断らず `change`・`unchanged` と `before` を返す））、api.md 8.41（`GET /api/admin/settings`。応答は `{ max_count, grace_minutes, max_length_minutes }`、名前は `settings.key` とそろえ、履歴は返さない）・8.42（`POST /api/admin/settings`。本文 `{ key, value }` で1回に1つ、`key` の誤りと値の型の誤りは `INPUT_BODY`、`effective_at = nowMin`、`unchanged` は何も書かない、応答は GET と同じ形、記録は `setting_changed` の `{key, before, after, effective_at}`、2人の同時の変更は両方成功して後が勝つのは残るリスク）・8.43（台帳の層のテスト。猶予の変更が開始時刻の時点の値で効くこと RSV-26、確保済みの予約が残ること RSV-25）、error-codes.md の `INPUT_SETTING_VALUE`、schema.md 2.9 の `setting_changed` の `detail`。猶予の変更・確保済みの予約の扱いは今の `settingAt`・`dueTransitions`・6.13・6.14 のままで成り立ち、ほかの文書を直す必要はなかった。

**管理者側の残りの3つ目、管理者の画面からの管理者のアカウント（ADM-2）を書いた（2026-11-19 に開発者が了承）。これで screens-and-api.md 5 のすべての API の入出力が決まった。** rules.md 6.1（`checkAdminPasswordReset(admin, actorAdminId)` に引数を足し、段 8 で自分自身なら `RULE_ADMIN_SELF_RESET`、保守用は `null` を渡して断らない。`checkAdminDelete(admin, activeAdmins)`：段 2 `NOT_FOUND_ADMIN`、段 8 で削除していない管理者が1件以下なら `RULE_ADMIN_LAST`。自分自身の削除は認める）、api.md 8.44（`GET /api/admin/admins`。削除していない管理者を番号の順に `{ admins: [{ id, login_id, display_name }] }`、自分の印は入れない）・8.45（`POST /api/admin/admins`。包む、8.1 と同じ判定・値、段 8 の判定は PBKDF2 の前なので断れば自動の変化も反映しない、記録は `actor_kind = 'admin'`）・8.46（`…/{id}/reset-password`。包む、自分自身は断る＝10章の「管理者自身のパスワードの変更」を入れないため。開発者が比較のうえ決定）・8.47（`…/{id}/delete`。本文 `{}`、包まない、`deleted_at` だけ書き証明は `checkAdminSession` で止まる、自分自身を削除した成功の応答は `clearAdminCookie()`、残り2人の同時削除は後が `RULE_ADMIN_LAST` か `AUTH_REVOKED`）・8.48（台帳の層のテスト）、8.5 の「期限を延ばす」の例外に自分自身の削除を足した。error-codes.md（新しい `RULE_ADMIN_SELF_RESET`・`RULE_ADMIN_LAST`。`INPUT_LOGIN_ID`・`INPUT_NAME`・`INPUT_PASSWORD`・`NOT_FOUND_ADMIN`・`RULE_ADMIN_ID_DUPLICATE` の「返す API」に足した）。

**機能を縦に切る順を決めた（2026-11-19 に開発者が決定）。** 実際に使う順に進める：保守用の API（管理者の作成・パスワードの設定し直し）→ 管理者の認証 → 共有された情報の設定 → 利用の開始 → 利用者の入力 → 機器 → 予約の操作。理由：何にも頼らないものから積むので、各段を手元の `wrangler dev` で前の段の結果を使って手で確かめられ、食い違いをその段で設計に戻せる。PBKDF2 と処理全体を `blockConcurrencyWhile` で包む経路（architecture.md 3 の唯一の例外）を、画面のない最初の段で片付けられる。採らなかった案：利用の開始から利用者側を先に進め、管理者側を後に回す。予約のルールには早く着く（確保が4段目、こちらは7段目）が、共有された情報を作る手段が管理者の画面しかないので、管理者側ができるまで利用者の画面を手で通せない。

**予約の操作の分け方と、管理者側の残りの順を決めた（2026-11-19 に開発者が決定）。** 予約の操作は、予約のルールの大半が入り1つの作業には大きいので、5つの作業に分ける：①予約状況・確保（`lib/time.js`・`INPUT_TIME`・`GET /api/devices/{id}/day`・RSV-2〜RSV-6・VIW-1・VIW-2）→ ②予約なしの利用（RSV-17, RSV-20）→ ③自分の予約・取消（RSV-7, RSV-8）→ ④時間帯の変更（RSV-9〜RSV-12）→ ⑤利用開始・利用終了（RSV-13〜RSV-16, RSV-18, RSV-19）。①で時刻と重なりの共通の部品を固めてから後を積む。管理者側の残りは予約の操作の後に、予約の管理（MNG-3）→ 数値の変更（RSV-25）→ 管理者の画面からの管理者のアカウント（ADM-2）の順に置く。理由：MNG-3 は予約の状態と利用終了の判定を使い、RSV-25 は RSV-22・RSV-26 を利用開始と無断不使用の判定を書いた後に詰められ、ADM-2 は他に頼らない。採らなかった案：RSV-25 を予約の操作の前に置く（手で確かめるときに猶予や上限を小さくできるが、RSV-26 を無断不使用の判定より先に詰めることになり、⑤で直すおそれがある。自動テストは時計を差し替えるので影響しない）。ADM-2 を管理者側の残りの先頭に置く（中身は変わらず、得るものがない）。実装の段階（下の「進め方」3）も同じ順に進める。

**screens.md の①、枠組みと共通の動きを書いた（2026-11-19 に開発者が了承）。** 1（ファイルの分け方。画面は `<section>` を `hidden` で切り替える、自分の JS は ES モジュール、vendor は通常の `<script>`、CDN から読まない、qrcode-generator は 2.0.4 に固定し、ブラウザでそのまま読める形がなければ 1.4.4）、2（`callApi` は `{ ok, data }` か `{ ok: false, code }` を返し、500・JSON でない応答・通信の失敗は `code: null`。汎用の文は2つ（`null`・知らないコード／`NOT_FOUND_API` は再読み込み）。`.message` は画面ごとに1つ。`AUTH_REQUIRED`・`AUTH_REVOKED`・`NOT_FOUND_USER` で自動で画面を移る。開いたときの動き。押したボタンだけを止める。`confirm()` は取り消せない6つの操作だけ。`innerHTML` を使わない。時刻は文字列のまま扱い、計算は `Date.UTC`／`getUTC*`。初期値は `now` から作る。成功と `NOT_FOUND_*`・`STATE_*` の後に取り直す。画面での検証は空の欄と数だけ）、7（採らなかった案）。design/README.md の表に screens.md へのリンクを足した。

**screens.md の②、利用者の画面を書いた（2026-11-19 に開発者が了承）。** 3（3.1 全体：上の帯、利用者・選んだ機器と日・直近の `now` の変数、画面を出すたびに取り直す、利用者が要る画面は行き先を覚えて利用者の入力へ。3.2 利用の開始。3.3 利用者の入力：学籍番号は画面で前後の空白だけ除く、`maxlength` は付けない。3.4 予約状況：文字の一覧、空きは確保済みのすき間で `now` より前は出さない、日をまたぐ時間帯は切らずに日付を付ける。3.5 確保・3.6 予約なしの利用：機器は予約状況で選んだもの、初期値は `now` から。3.7 自分の予約：ボタンは `status` だけで決め利用開始は開始時刻の前でも出す、時間帯の変更は1つのフォームで開始の欄を `in_use` か `start <= now` で止める）、5.1・5.2（利用者の画面が受けるコードの文と、コードによらない文）、7 に採らなかった案を足した。あわせて api.md 8.22 `GET /api/devices` の応答に `now` を足した（`{ devices, now }`。予約状況の最初の日を端末の時計なしで決めるため。8.23 にテストの行を足した）。

**screens.md の③、管理者の画面を書いた（2026-11-19 に開発者が了承）。** 4（4.1 全体：上の帯、管理者の変数（`me`・`login` の応答。自分の行を `id` で見分ける）、3.1 の決まりをそのまま使う、行のボタンは番号をクロージャで持つ、「認証を解く」は確かめず、`AUTH_REQUIRED`・`AUTH_REVOKED` も成功と同じに扱う。4.2 認証：ID は前後の空白を除き、断られたらパスワードの欄を空にする。4.3 機器：名前の変更は一覧の下の1つのフォーム、`maxlength` なしで「30文字まで」と書く、削除の確かめに予約済が取り消されることを書く。4.4 予約の管理：ボタンは `status` だけで決める。4.5 数値：行ごとに保存、成功したら応答の3つの値で欄を入れ直す、RSV-25・RSV-26 の説明の文。4.6 管理者：自分の行に「（自分）」を付け設定し直しを出さない、作成の成功でそろえた ID を示す、自分の削除は別の確かめの文で、成功したら認証の画面へ。4.7 共有された情報：`createDataURL` を `<img>` に入れ `innerHTML` を使わない、URL を文字でも出す（カメラのない PC と手元の確認のため）、ほかの画面に移っても消さない、`code: null` なら前の QR コードを消す）、5（`messageFor(code, screen)` で管理者の画面は `AUTH_REQUIRED`・`AUTH_REVOKED` だけ置き換える、5.3 管理者の画面のコードの文、5.4 コードによらない文）、1（`js/time.js` を足した）、2.7（確かめないものに機器の追加・名前の変更・認証を解くを足した）、7 に採らなかった案を足した。上の「screens.md に回すこと」はすべて取り込んだ。

**screens.md の④、手で確かめる手順を書いた（2026-11-19 に開発者が了承）。これで詳細設計の文書はすべて書き終えた。** 6.1（準備：手元の `wrangler dev`、`MAINT_KEY` は `.dev.vars`、Cookie を分けた3つの窓（管理者・利用者A・利用者B）、時刻で変わることは数値を小さくして実際に待つ、実装の段階ではその機能の段だけ・結合テストではすべてを通す）、6.2（段 1 保守用の API → 段 2 管理者の認証 → 段 3 共有された情報 → 段 4 利用の開始 → 段 5 利用者の入力 → 段 6 機器 → 段 7 予約の操作 → 段 8 管理者側の残り → 段 9 共通（SEC-1 の `<b>`・`<img onerror>`、`innerHTML` の検索、二重送信、読み込み直し、台帳の停止）。前の段の結果を後で使う順）、6.3（NFR-1：デプロイの後に本番で、4つのブラウザのそれぞれで段 2〜9 を通す。スマートフォンは QR コードをカメラで読む）、6.4（NFR-2：本番で、機器5台・その日の予約20件を手で入れ、空きの確認は3秒・操作は2秒・OPN-1 の後の1回目は10秒、各10回で9回以上、手のストップウォッチ。PC は校内の回線、スマートフォンは携帯の回線で測り、要件との違いを書く）、7 に採らなかった案を足した。状態を「決定」にした。

**詳細設計のレビューの分け方を決めた（2026-11-19 に開発者が了承）。** 6つの観点に分けた（①要件の ID の網羅、②理由のコード、③画面と API、④表と処理、⑤基本設計との食い違い、⑥テストの観点）。

**詳細設計のレビューが終わった（2026-11-19。指摘はすべて開発者が了承して直した）。詳細設計の文書はすべて「決定」になった。** 要件の ID の抜けと、理由のコードの食い違いはなかった。直したもの：各文書の頭の「関係する要件」、古い記述（「機能ごとの設計で足す」など）、screens.md 5 の節の並び、screens.md 3.1 の `device_id` を `Number()` で持つこと・5.2 の空の日の文、api.md 3.5（自動の変化の書き込み。予約の `status` だけを変え、記録は `actor_kind = 'auto'`・`at` はルール上の時刻・`detail` は `from`・`to`）、schema.md 3（`reservations_device_status` に利用開始の前倒し）・2.9、api.md 3.2（`handle` は `ledger.js`）、テストの観点（api.md 7 に自動の変化と `auth_failures` の10,000行、rules.md 6.10 に TIM-8）。基本設計も直した：architecture.md 3 の手順を「3 入力の形式 → 4 自動の変化の反映」に入れ替えた（api.md は段 1 で断れば反映しない形で書いてあったため。PBKDF2 で包む操作の例外も書いた）。手順の番号を参照する time-and-concurrency.md 3・4、rules.md 4・5.3、api.md 3.3・8.6 も合わせた。screens-and-api.md 7 の例を `RULE_ADMIN_LAST` に、6 の `now` を入れる応答を予約状況・機器の一覧・自分の予約にした。

**実装の1つ目、土台と台帳の骨組みの方針を決めた（2026-11-19 に開発者が了承）。** 設計文書は2か所を直した：api.md 3.2（`handle(request, clock, routes = ROUTES)`。共通の流れをテストが自分の経路の表で確かめるため。`fetch` は表を渡さない）、rules.md 3.1・5.1（`settingAt` は `src/rules/settings.js`、`dueTransitions` は `src/rules/transitions.js`）。

**実装の1つ目、土台と台帳の骨組みを書いた（2026-11-19。`npm test` は 7 ファイル 87 件がすべて通る）。2026-11-19 にコミットした（bffcc45）。push と GitHub Actions の確認はまだ。** 了承した方針のとおり、`package.json`・`.nvmrc`・`wrangler.jsonc`・`vitest.config.js`・`.github/workflows/test.yml`、`src/index.js`・`src/ledger.js`（`handle`、共1〜共4。認証は「誰でも」だけで、ほかの種類は例外にして 500）、`src/api/`（`routes.js` の空の表と `findRoute`、`respond.js`、`auto.js`）、`src/lib/`（`body.js`、`time.js` の `floorMinute`）、`src/rules/`（`settingAt`・`dueTransitions`）、`src/store/`（`migrations.js` の版 1 と `applyMigrations`、`reservations.js`・`settings.js`・`events.js`）と、`test/lib/`・`test/rules/`・`test/ledger/` を書いた。テストの基盤は `@cloudflare/vitest-plugin` 1.8.5 にした。前の名前の `@cloudflare/vitest-pool-workers` は非推奨で、`npm audit` の指摘も残っていたので移した（2026-11-19 に開発者が了承。理由は platform-selection.md「追加するツール」）。移った後も 87 件は通り、`npm audit` は0件。CLAUDE.md、platform-selection.md、testing-and-deploy.md、time-and-concurrency.md のパッケージ名も直した。決めた細部：`compatibility_date` は `2026-08-15`（前のテストの基盤が対応する日付までで決めた。上げるのは別の作業にする）。本文は 16 KiB を超えた時点で読むのをやめる。`schema_migrations` は版 1 の中ではなく `applyMigrations` の最初で作る。`applyMigrations` と `handle` は、テストが版・経路を足した一覧を渡せる引数を持つ。台帳の層のテストは `newUniqueId()` で毎回新しい台帳を使う（テストの基盤にテストごとに保存場所を分ける設定がないため。testing-and-deploy.md 1 も合わせた）。索引のテストのため、自動の変化で引く SQL を `SQL_TRANSITION_CANDIDATES` として書き出した。

**実装の2つ目、保守用の API を書いた（2026-11-19。`npm test` は 13 ファイル 191 件がすべて通る）。2026-11-20 にコミットした（c2f5afe）。手での確認と push はまだ。** 了承した方針のとおり、`src/api/routes.js`（`buildRoutes({ derivePassword })` で表を作り、`ROUTES` はその既定。テストは数を数える関数を渡す）、`src/api/auth.js`（共3 の準備 `prepareAuth` と同期の `checkAuth`。保守は 未設定 → 上限 → 鍵）、`src/api/maint.js`（8.1・8.2）、`src/ledger.js`（認証を `api/auth.js` に移した）、`src/lib/`（`validate.js`・`client.js`・`hash.js`、`time.js` の `windowStart`、`body.js` の `hasStringFields`）、`src/rules/`（`admins.js` の `checkAdminCreate`・`checkAdminPasswordReset`、`auth.js` の `checkAttemptLimit`）、`src/store/`（`admins.js`・`auth-failures.js`）、`vitest.config.js`（テスト用の `MAINT_KEY` を束縛で渡す）と、そのテストを書いた。設計文書は2か所を直した：api.md 3.3 の 2・8.1・8.45（ソルトは準備では作らず、判定が通った後 PBKDF2 の直前に作る。`getRandomValues` は同期なので排他に響かない）、api.md 6.1（ヘッダの値の前後の空白は Fetch の仕様で除かれて届くので、鍵の後ろの空白は通る。テストで確かめた）。8.3 の2行目（設定し直した後の古い証明が `AUTH_REVOKED`）は、管理者の認証の実装で書く。

**実装の3つ目、管理者の認証を書いた（2026-11-20。`npm test` は 15 ファイル 244 件がすべて通る）。2026-11-20 にコミットした（1b435af）。手での確認と push はまだ。** 了承した方針のとおり、api.md 3.3 の経路の表に2列を足した。「本文を自分で確かめるか」（`ownBodyCheck`。4 の例外の上限 → 本文 → 認証の値の順を処理に任せる。利用の開始でも使う）と「API ごとの準備」（`prepare`。login の新しい証明とダミーのソルト）。あわせて、管理者の API の期限の延長は `handle` が1か所で行う（処理が `Set-Cookie` を付けた応答と 500 を除く）と書いた。コードは次のとおり。`src/lib/cookie.js`（`readCookie`・`isTokenFormat`・`adminCookie`・`clearAdminCookie`）、`newToken`（`lib/hash.js`）、`checkAdminLogin`・`checkAdminSession`（`rules/auth.js`）、`src/store/admin-sessions.js`、`recordAuthFailure` に `failure`・`loginId`、`src/api/admin-auth.js`（`login`・`me`・`logout`）、`api/auth.js` の認証の種類 `'admin'`。画面は `public/admin.html`・`css/style.css`・`js/api.js`・`js/messages.js`・`js/admin.js`（認証の画面と上の帯。帯の画面のボタンは「機器」だけで、機器の画面は空の `<section>`。ほかのボタンと文は機能ごとに足す）。`wrangler.jsonc` に `assets`（`./public`。`html_handling` は既定のままなので、`/admin.html` は `/admin` に転送される）。前の作業から回したテスト（認証が先の `AUTH_REQUIRED`、login で `INPUT_BODY`・`LIMIT_ATTEMPTS` が先、設定し直した後の `AUTH_REVOKED`）は `test/ledger/admin-auth.test.js` に入れた。

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

**実装の4つ目、共有された情報の設定を書いた（2026-11-20。`npm test` は 16 ファイル 254 件がすべて通る）。2026-11-20 に開発者が screens.md 6.2 の段 1〜3 を手で確かめ、コミットした。push はまだ。** 段 2 で認証の画面に帯が出る誤りが見つかり、直して同じコミットに入れた（`nav` の `display: flex` が `hidden` 属性に勝っていた。`css/style.css` に `[hidden] { display: none !important; }`）。了承した方針のとおり、`src/api/shared-info.js`（`prepareSharedInfo` で `newToken()`、`setSharedInfo` で自動の変化・`shared_infos` の1行・`shared_info_set` の記録）、`src/store/shared-infos.js`（`insertSharedInfo`。現在の版を引く関数は利用の開始で足す）、経路の表の行（管理者・包まない・`prepare`）、`test/ledger/shared-info.test.js`（api.md 8.10 の全行。SEC-4 の例外は `events` の表の名前を変えて起こし、`console.error` に43文字の base64url がないことを確かめる。RSV-23 はどちらの応答が後に処理されたかを外から見分けられないので、2行のハッシュが2つの値にそれぞれ当たることを確かめる）。画面は `admin.html` の帯のボタンと `screen-shared-info`、`admin.js` の 4.7 の動き、`css/style.css` の `.url`・`img`。qrcode-generator は 2.0.4 の `dist/qrcode.js`（グローバル変数 `qrcode` を作る形で、`addData`・`make`・`createDataURL` がある）を `public/js/vendor/qrcode.js` にそのまま写し、先頭に出典とライセンスを書いた。screens.md 1.2 は直さなくてよかった。手元の `wrangler dev`（作業用の場所に保存）で、QR コードと URL・成功の文が出ること、機器の画面に移って戻っても残ることだけを確かめた（`confirm` は差し替えた）。

**実装の5つ目、利用の開始を書いた（2026-11-20。`npm test` は 17 ファイル 293 件がすべて通る）。2026-11-20 にコミットした（8aba7ec）。push はまだ。** 了承した方針のとおり、`src/lib/cookie.js`（`USER_COOKIE`・`userCookie`）、`src/rules/auth.js`（`checkSharedInfo`・`checkUserSession`）、`src/store/shared-infos.js` の `findCurrentSharedInfo`、`src/store/user-sessions.js`、`src/api/auth.js`（認証の種類 `'user'`。`prepareUserCookie`・`checkUserCookie` を外から使える形にした）、`src/api/session.js`（`POST`・`GET /api/session`。どちらも認証の種類は「誰でも」で、証明の確かめと `Set-Cookie` は処理の中で行う）、`src/ledger.js`（期限の延長を利用者の API にも広げた）、経路の表の2行と、そのテスト（`test/ledger/session.test.js` に api.md 8.14 の全行。利用者の API はまだないので、共3 と期限の延長はテスト用の経路で確かめた）を書いた。設計文書は api.md 3.3 の「API ごとの準備」を直した（`prepare` に要求と読んだ本文を渡す。`k` のハッシュを本文から求めるため）。画面は `public/index.html`（利用の開始と、中身のない予約状況の `<section>`。帯は「予約状況」のボタンと「操作する人：未入力」だけ）、`public/js/user.js`（2.5 の開いたときの動きと 2.4 の `AUTH_REQUIRED`・`AUTH_REVOKED`。`NOT_FOUND_USER` の移動は利用者の入力で足す）、`messages.js` の2つの文。手元の `wrangler dev` では、`#k=` なしで「QR コードを読んでください」が出ること、`#k=abc` で URL から `#k=` が消え「QR コードが古いか…」が出ることだけを確かめた。段 4 の手での確認で、値を1文字変えた URL でも予約状況の画面が出た。利用者Bの窓に有効な `__Host-dxp_user` が残っていたためで、設計どおりの動き（api.md 8.11）だった（開発者が Cookie を確かめて特定）。screens.md 6.2 の段 4 に、開く前に Cookie がないことを確かめる手順と注を足した。

**実装の6つ目、利用者の入力を書いた（2026-11-20。`npm test` は 19 ファイル 362 件がすべて通る）。2026-11-20 にコミットした。手での確認（screens.md 6.2 の段 5）と push はまだ。** 了承した方針のとおり、`src/lib/validate.js` の `validateRole`・`validateStudentId`・`validateCohort`（rules.md 6.4）、`src/rules/users.js` の `decideUserInput`（6.5）、`src/store/users.js`（`findUserByIdentity`・`insertUser`・`updateUserProfile`。`findUserByIdentity` は 8.16 でも使う）、`src/api/me.js`（`POST /api/me`。共4 の型 → 段 1 の4つ → `transactionSync` の中で自動の変化・引く・判定・書き込みと記録）、経路の表の1行と、そのテスト（`test/lib/validate.test.js` に 6.4 の表、`test/rules/users.test.js`、`test/ledger/me.test.js` に api.md 8.17 の全行。8.14 から回した `POST /api/me` の `AUTH_REVOKED` を含む。RSV-23 はどちらが後に処理されたかを記録の順で見分ける）を書いた。8.16 の共通の引き方（識別の組を確かめて引く関数）は、使う API ができる予約の確保で作る。画面は `index.html`（帯に「自分の予約」「利用者の入力」、利用者の入力の画面、中身のない自分の予約の `<section>`）、`user.js`（利用者の変数と帯の表示、利用者が要る画面の行き先を覚える動き、2.4 の `NOT_FOUND_USER` での移動、3.3 の画面での検証と送る値）、`messages.js` の5つの文。設計文書は直していない。手元の `wrangler dev`（作業用の場所に保存）で、段 5 の手順を1つの窓で通した（未選択の文、7桁の文、全角8桁で自分の予約に移り帯に「山田（12期・生徒）」、欄が半角の `12345678` に置き換わる、教員で期生の欄が隠れる、`T-Suzuki` で帯に「鈴木（教員）」）。名前を変えたときの帯の変化と、利用者Bの窓は確かめていない。

**実装の7つ目、利用者の入力を「登録・ログイン・名前と期生の変更」に作り直した（2026-11-20。`npm test` は 19 ファイル 393 件がすべて通る）。コミットはまだ。** 了承した方針のとおり、`src/rules/users.js` の `decideUserInput` を消して `checkUserRegister`・`checkUserLogin`・`decideUserChange`（rules.md 6.5）に、`src/api/me.js` の `postMe` を消して `registerUser`・`loginUser`・`changeUser`（api.md 8.15。共4 → 段 1 → `transactionSync` の中で自動の変化・引く・判定・書き込みの流れを1つの関数にまとめ、段 2・段 8 で断るときも自動の変化を反映してから返す）に、経路の表の `POST /api/me` を `/api/me/register`・`/api/me/login`・`/api/me/change` の3行にした。`src/store/users.js` は変えていない。テストは `test/rules/users.test.js` を 6.5 の表で、`test/ledger/me.test.js` を api.md 8.17 の全行で書き直した（3つの API それぞれの `AUTH_REVOKED`・`AUTH_REQUIRED`・`AUTH_ORIGIN`、`NOT_FOUND_USER`・`RULE_USER_DUPLICATE` の応答の `Set-Cookie`、同時の登録・変更、断ったときの自動の変化を含む）。画面は `index.html`（帯を「予約状況」「自分の予約」「名前・期生の変更」「ログイン」に、`screen-input` を `screen-login`・`screen-register`・`screen-change` に）、`user.js`（3.3.1〜3.3.4。帯のボタンでログイン・登録以外の画面を選んだら覚えた行き先を消すことにした。screens.md には書いていない細部）、`messages.js`（`NOT_FOUND_USER` の文を替え、`RULE_USER_DUPLICATE` を足した）。設計文書は直していない。手元の `wrangler dev`（`.claude/launch.json` を作った。Git に入れるかは開発者が決める）で、段 5 の表の手順を1つの窓で順に通し、すべて期待どおりだった（利用者Bは同じ窓でログインし直して確かめた）。

### 次の作業

1. **利用者の入力を「登録・ログイン・名前と期生の変更」の3つの画面に分ける（2026-11-20 に開発者が決定）。** 要件の USR-3・USR-7 を変える。開発者が決めたこと：ログインは生徒か教員かと学籍番号だけを入れる（識別の組 USR-4 は変えない）。登録で、すでにいる識別の組を入れたら新しいコードで断る。名前・期生の変更は別の画面で行う。要件文書は Claude が下書きを示し、開発者が反映する（下書きは 2026-11-20 のセッションで示した）。反映されたら、基本設計（screens-and-api.md 2・4・「要件の読み方」）→ 詳細設計（api.md 8.15〜8.17、rules.md 6.5、error-codes.md、screens.md 3.3・5・6.2 の段 5）→ 実装の順に直す。設計を直すときに決めること：ログインの応答に名前を返すか（10章の「誰として操作しているかの表示」との関係も）、変更の画面が送る識別の組、新しいコードの名前。
   2026-11-20：要件の USR-7（f51b5c8）・USR-3（c10b550）が反映された。基本設計を直した（2026-11-20 に開発者が了承）：screens-and-api.md 1・2（ログイン・登録・名前と期生の変更の3つの画面）・4（`POST /api/me/register`・`/api/me/login`・`/api/me/change` に分ける。2026-11-20 に開発者が決定。今の `POST /api/me` は残さない。登録はすでにいる利用者を断る、ログインはいなければ `NOT_FOUND_USER`・何も書かず記録しない、変更は異なれば置き換えて記録）・5・7・採らなかった案・要件の読み方（USR-7 の「登録・変更のほか」の登録は初めて持たせることと読む。開発者が確認）、domain-model.md 2。logging.md・architecture.md は直さなくてよかった。次は詳細設計（api.md 8.15〜8.17、rules.md 6.5、error-codes.md、screens.md 3.3・5・6.2 の段 5）→ 実装。
   2026-11-20：詳細設計を直した（2026-11-20 に開発者が了承）。開発者が決めたこと：ログインの応答にも名前・期生を入れ、3つの API の応答を `{ id, role, student_id, name, cohort }` にそろえる。上の帯の「操作する人」の表示は残し、10章の「誰として操作しているかの表示」には当たらないものとする（screens-and-api.md「要件の読み方」に足した）。すでにいる利用者の登録を断るコードは `RULE_USER_DUPLICATE`（409、段 8）。直したもの：api.md 8.15（8.15.1 共通・8.15.2 `register`・8.15.3 `login`・8.15.4 `change`。段 2・段 8 で断っても自動の変化は反映する。登録はすでにいれば名前・期生が同じでも断る。変更は名前・期生の欄だけの画面から送る）・8.16・8.17・8.12・8.14・8.26 の VIW-2 の行・7、rules.md 6.5（`decideUserInput` をやめ、`checkUserRegister`・`checkUserLogin`・`decideUserChange`）、error-codes.md（`RULE_USER_DUPLICATE`、`INPUT_*`・`NOT_FOUND_USER` の返す API と 3.4 の注）、schema.md 2.9 の参照、screens.md（2.4・2.7・3.1 の帯のボタンを「予約状況」「自分の予約」「名前・期生の変更」「ログイン」に、3.3 を 3.3.1〜3.3.4 に、3.4・5.1・5.2・6.2 の段 5 と段 9・7）。基本設計も screens-and-api.md 4 の 2（ログインでも自動の変化は反映する）・3（ログインの応答に名前・期生）と要件の読み方を直した。表と記録の種類（`user_created`・`user_renamed`）は変えていない。
   2026-11-20：実装した（下の「実装の7つ目」）。**まだコミットしていない。**
   **次は**、作り直したログイン・登録・名前と期生の変更の手での確認（screens.md 6.2 の段 5）。開発者が行う。通ったら、次は下の 3 の「機器」の実装。
2. （済み）push と GitHub Actions の確認：2026-11-20 に開発者の指示で 36db2c1 までを push し、`test` のジョブ（`npm ci` → `npm test`）がすべて成功した。あわせて、リポジトリが公開（public）で GitHub Pages が有効になっており、push のたびに「pages build and deployment」が動くことに気づいた。止めるかは開発者が決める（下の「未解決の質問」）。
3. 以降は「機能を縦に切る順」で1つずつ実装する：（済み）利用者の入力 → **機器（api.md 8.18〜8.23）** → 予約の操作①〜⑤ → 予約の管理 → 数値の変更 → 管理者の画面からの管理者のアカウント。画面（screens.md）はその機能の実装に含める。
4. 結合テスト（上の「進め方」4）。NFR-2 の結果の控えの置き場所はこのときに決める（screens.md 6.4）。

実装の段階（上の「進め方」3）に回すこと：土台（`package.json`・`.nvmrc`・`wrangler.jsonc`・Vitest の設定。Node は手元が v26.13.0、wrangler は spike で 4.163.0 を使った。版は上の 1 で決めた）、台帳の骨組み（api.md 3 の経路の表と共通の流れ、1 の応答、4 の共通の確かめる順）と schema.md 5 の版の適用。api.md 3.4 と schema.md 5.4 の基盤の機能は spike で確かめた（2026-11-19。下の「schema.md で決めた持ち越し事項」）ので、実装では台帳の層のテストに書くだけでよい。GitHub Actions は、実装の段階ではテストのジョブだけを作り、デプロイのジョブは結合テストの後に作る（Cloudflare の API トークンは学校のアカウントが作る。PRE-11 は未定）。

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
- 画面と API：HTML は利用者用と管理者用の2つで、中は JavaScript で切り替える。名前・期生の変更（`POST /api/me/change`）だけで名前を置き換え（2026-11-20 に登録・ログイン・変更の3つに分けた）、その後の操作は識別の組だけを本文で送る。`GET` は読むだけ、ほかは `POST` で動詞を URL に書く。時刻は `YYYY-MM-DDTHH:mm`（日本時間）。断る理由のコードは1つで、頭は `INPUT_`・`AUTH_`・`LIMIT_`・`NOT_FOUND_`・`STATE_`・`RULE_`。
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

- **GitHub Pages**（2026-11-20 に気づいた）：リポジトリは公開で、Pages が有効。push のたびに「pages build and deployment」が動く。v0.1.0 は公開しないので、Pages を止めるか、リポジトリを非公開にするかを開発者が決める（設定はリポジトリの Settings → Pages で、開発者が行う）。

- architecture.md から持ち越し：PBKDF2 の `await` の間に他のリクエストが割り込みうる（管理者のパスワードを扱う操作だけ `blockConcurrencyWhile` で包むと決めた。リクエストの処理の中でも動くことは実測で確かめた。台帳の層のテストでも確かめる）。USR-7 の名前の置き換えは `POST /api/me/change` だけで行う（2026-11-20 に直した。screens-and-api.md 4）。

## 次のセッションの始め方

1. このファイルと [design/README.md](design/README.md) を読む。
2. 「いまの段階」の作業に着手する。設計を示すときは、構成・理由・主な代替案を簡潔に出す（CLAUDE.md「開発の進め方」）。

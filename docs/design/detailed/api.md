# API

- 状態：作成中（共通の部分、保守用の API、管理者の認証を決定。残りの API の入出力は、機能ごとの設計で足す）
- 日付：2026-11-19
- 関係する要件：USR-1, USR-2, ADM-2, ADM-3, RSV-21〜RSV-23, RSV-27, VIW-2, VIW-3, SEC-2〜SEC-4, LOG-4, TIM-1, NFR-4, PRE-5, FUT-1
- 前提：[architecture.md](../basic/architecture.md) 1, 3, 4（Worker は渡すだけ、手順 1〜7）、[screens-and-api.md](../basic/screens-and-api.md) 4〜7（API の一覧、応答の形）、[auth.md](../basic/auth.md) 1, 3, 6, 7（入口の種類、Cookie と Origin、保守用の鍵、試行の制限）、[time-and-concurrency.md](../basic/time-and-concurrency.md) 2, 4（時刻を取る位置、`blockConcurrencyWhile`）、[error-codes.md](error-codes.md)、[schema.md](schema.md) 5（版の適用）

ここでは、すべての API に共通の受け渡しの形、Worker と台帳の受け渡し、デプロイの直後の版の食い違いへの備え、保守用の API の `curl` 手順の形を決める。API ごとの入出力と返しうるコードは、機能ごとの設計で 8 に足す。

## 1. 応答の形

形は screens-and-api.md 7 のとおり。

| もの | 内容 |
| --- | --- |
| 成功 | HTTP 200、`{ "ok": true, "data": { … } }`。作成でも 201 などに分けない |
| 断る | コードの頭で決まる HTTP（error-codes.md 1）、`{ "ok": false, "error": { "code": "…" } }` |
| 想定していない例外 | HTTP 500、`{ "ok": false }`（error-codes.md 1） |
| ヘッダ | すべての応答に `Content-Type: application/json; charset=utf-8` と `Cache-Control: no-store`。証明を渡す・延ばす応答には `Set-Cookie`（auth.md 3） |

- `Cache-Control: no-store` を付けるのは、予約状況をいつも最新で返すため（VIW-3）と、名前などの個人の情報をブラウザや途中のキャッシュに残さないため。
- 例外は `handle` の一番外で受け止めて 500 に変える。`transactionSync` の中で起きた例外は、その前にトランザクションを取り消している（time-and-concurrency.md 4）。`blockConcurrencyWhile` の中では、包んだ処理の中で受け止める（同 4 の注意）。例外の中身は `console.error` に出すが、本文・Cookie・ヘッダの値は出さない（LOG-4, SEC-4）。

## 2. 要求の形

| もの | 決まり |
| --- | --- |
| `GET` | 本文を持たない。送られても読まない |
| `POST` | 本文は JSON のオブジェクト。16 KiB を超える本文は読まずに `INPUT_BODY`（design-values.md） |
| 知らない項目 | 無視する（断らない）。下の 5 の版の食い違いに備えるため |
| パスの `{id}` | 正の整数の形（先頭が0でない数字の並び）でなければ、その経路はないものとする（`NOT_FOUND_API`） |
| 識別の組・秘密の値 | 本文に入れ、URL（`?` の後ろ）に入れない（screens-and-api.md 4、auth.md 2） |

- `Content-Type` は確かめない。本文を JSON として読めるかどうかだけを見る。CSRF の対策は `Origin` で行う（下の 4）。
- 本文を読むときは、長さを確かめてから JSON に直す。16 KiB は、名前などの項目がいちばん長いときでも十分に収まり、大きな本文で台帳の処理を長引かせないための値。

## 3. Worker と台帳の受け渡し

### 3.1 Worker（`src/index.js`）

1. パスが `/api/` で始まらなければ、`NOT_FOUND_API` を返す（静的ファイルは基盤が先に返している。architecture.md 1）。
2. `env.LEDGER.idFromName("ledger")` で台帳を引き、`stub.fetch(request)` に要求を手を加えずに渡し、応答をそのまま返す。

Worker はこれ以外に何もしない。版の食い違い（下の 5）の影響を受けないようにするため。

### 3.2 台帳（`src/ledger.js`）

- constructor で、版の適用を `blockConcurrencyWhile` に包んで行う（schema.md 5）。
- `fetch(request)` は `handle(request, Date.now)` を呼ぶだけ。テストは `runInDurableObject` で `handle` を任意の時計で呼ぶ（time-and-concurrency.md 2, 5）。

### 3.3 経路の表（`src/api/routes.js`）

API は1つの表に並べる。1行が1つの API。

| 列 | 内容 |
| --- | --- |
| メソッド・パス | `POST /api/reservations/{id}/cancel` など |
| 認証の種類 | 誰でも／利用者／管理者／保守（auth.md 1） |
| 包むか | 処理全体を `blockConcurrencyWhile` で包むか（PBKDF2 を使う操作だけ。time-and-concurrency.md 4） |
| 処理 | `src/api/` の関数 |

`handle` はこの表を引き、すべての API に共通の流れを組む。API ごとの関数は、共通の流れの後の部分（rules.md 4 の段 1〜8 と書き込み）だけを書く。

1. 経路を引く。なければ `NOT_FOUND_API`。
2. `await` が要る準備（architecture.md 3 の手順 1）：本文を読む（壊れていても、ここでは断らずに印を付ける）、Cookie の値の SHA-256、新しく渡す証明の値とそのハッシュ、共有された情報・保守用の鍵のハッシュ（auth.md 3、下の 6.1）、パスワードを新しく設定する操作のソルト（下の 8.1）。
3. 現在時刻を `clock()` で1回だけ取る。包む API は、包んだ中で 2 の後に取る。
4. 同期の区間に入り、下の 4 の共通の順で確かめる。
5. API ごとの関数を呼ぶ（手順 3〜6 は `transactionSync` の中。time-and-concurrency.md 4）。

### 3.4 実装で確かめること

- `stub.fetch(request)` で、`CF-Connecting-IP` と `Origin` のヘッダが台帳にそのまま届くこと（台帳の層のテストでは、テストがヘッダを付けて呼ぶ）。
- Worker から台帳に渡した要求の本文を、台帳で読めること。

**基盤で確かめたこと（2026-11-19、spike の `/headers`）**：Worker が受けた要求をそのまま `stub.fetch(request)` で渡すと、台帳で `Origin`・`Cookie` のヘッダと本文が読めた。`CF-Connecting-IP` は、本番の基盤では送り元の IP の値が入り、手元の `wrangler dev` では `127.0.0.1` だった。台帳の層のテストでは、引き続きテストがヘッダを付けて呼ぶ。

## 4. 共通の確かめる順

rules.md 4 の段 1 より前に、すべての API で次の順に確かめる。コードは error-codes.md の「共1〜共4」。

| 順 | 確かめること | コード | 当てはめない API |
| --- | --- | --- | --- |
| 共1 | 経路があるか | `NOT_FOUND_API` | ― |
| 共2 | `GET` 以外で、`Origin` が自分のサイトと一致するか | `AUTH_ORIGIN` | 保守用の API |
| 共3 | 認証（利用者・管理者の API は証明が有効か。利用の開始・管理者の認証・保守用の API は試行の上限と、送られた値） | `AUTH_*`、`LIMIT_ATTEMPTS` | `GET /api/session`（証明が有効かどうかを返すだけで、断らない） |
| 共4 | 本文を読めたか | `INPUT_BODY` | `GET` |

- **本文の誤りは、認証が通ってから返す。** 本文は 3.3 の 2 で読んでおくが、壊れていたことは共3 の後に返す。認証されていない相手に、入力の形について何も教えないため。
- **例外：利用の開始（`POST /api/session`）、管理者の認証（`POST /api/admin/login`）。** 認証の値が本文に入っているので、本文が読めなければ認証を確かめられない。これらは共4 を共3 の前に確かめる。試行の上限（`LIMIT_ATTEMPTS`）は共4 より前に確かめ、上限を超えた相手には本文の誤りも教えない。
- **保守用の API は例外にしない。** 鍵は本文ではなくヘッダで送る（下の 6）ので、ほかの API と同じく、鍵が通ってから本文の誤りを返す（2026-11-19 に保守用の API の設計で直した。当初は例外に含めていた）。
- **保守用の API で `Origin` を確かめない理由。** `curl` は `Origin` を送らない。保守用の鍵はヘッダで送り、Cookie を使わないので、ほかのサイトから送らせる攻撃（CSRF）が成り立たない。
- **`Origin` の比べ方。** 要求の URL のオリジン（`new URL(request.url).origin`）と、`Origin` ヘッダの値が完全に一致すること。ヘッダがなければ断る。主要なブラウザは、同じサイトへの `fetch` の `POST` にも `Origin` を付ける。

## 5. デプロイの直後の版の食い違い

基盤の実測で、送り直した直後に新しい Worker が古い台帳を呼んだような応答が1回だけ返った（progress.md「基盤の実測で決めたこと」）。静的ファイル（画面）、Worker、台帳は、デプロイの直後の少しの間、別々の版で動くことがあるものとして扱う。

| 組み合わせ | 備え |
| --- | --- |
| Worker と台帳 | Worker は要求を手を加えずに渡すだけ（3.1）なので、どちらの版でも結果が変わらない。Worker のコードはふだん変えない |
| 画面と台帳 | API は足す形でだけ変える（下の決まり）。古い台帳は新しい項目を無視し（2）、古い画面は応答の新しい項目を無視する。新しい API を古い台帳に送ると `NOT_FOUND_API` が返るので、画面は「再読み込みしてください」と出す |
| 台帳のコードと表 | 版の適用は台帳の constructor で行う（schema.md 5）ので、1つの台帳の中でコードと表が食い違うことはない。前の版のコードに戻すときは schema.md 5.3 による |

API を変えるときの決まり：

- 既存の API の、項目の名前・意味・値の形を変えない。消さない。
- 項目を足すときは、ない場合でも前と同じに動くようにする（要求に足す項目は省略できるものにする）。
- 返すコードを足すことはできる。画面は知らないコードに汎用の文を出す（error-codes.md 1）。
- 意味を変えたいときは、新しい API を足す。

採らなかった案：画面と台帳が版の番号をヘッダで送り合い、食い違えば断る。仕組みが増えるわりに、食い違うのはデプロイの直後の短い間だけで、v0.1.0（公開しないベータ版）では得るものが小さい。

## 6. 保守用の API の鍵と手順

保守用の API（auth.md 6）は画面を作らず、`curl` で呼ぶ。

### 6.1 鍵の確かめ方（共3。ADM-2, SEC-3）

鍵は `Authorization: Bearer 鍵` のヘッダで送る。

- 鍵をヘッダで送るのは、URL に入れると基盤のアクセスの記録に残り、本文に入れると API ごとの本文の形に鍵が混ざるため。`Authorization` は Web の一般的な書き方（PRE-5）。

準備（3.3 の 2）で、`env.MAINT_KEY` と、ヘッダの `Bearer ` の後ろの値の SHA-256（UTF-8 のバイト列に対して）を求めておく。ヘッダがない、または `Bearer` と空白1つで始まらない（大文字・小文字も区別する）ときは、値がないものとして印を付ける。同期の区間で、次の順に確かめる。

| 順 | 確かめること | 断るとき | 失敗として数えるか |
| --- | --- | --- | --- |
| 1 | `MAINT_KEY` が設定されていて、43文字以上か（design-values.md） | `AUTH_MAINT_DISABLED` | 数えない（表に何も書かない） |
| 2 | 試行の上限：`auth_failures` の、`entry = 'maint'`・`client = clientKey(CF-Connecting-IP)`（rules.md 6.2）・その10分の区切りの行の `failures` が5未満か（`checkAttemptLimit`。rules.md 6.3） | `LIMIT_ATTEMPTS` | 数えない（上限後は書かない。logging.md 4） |
| 3 | ヘッダの値があり、その SHA-256 と `MAINT_KEY` の SHA-256 が `crypto.subtle.timingSafeEqual` で等しいか | `AUTH_MAINT_KEY_INVALID` | 数える |

- **両方の SHA-256 を比べる。** `timingSafeEqual` は同じ長さのバイト列しか比べられない。ハッシュにすれば長さがそろい、比べる時間から鍵の長さもわからない。鍵は256ビットのランダムな値なので、速い SHA-256 で足りる（auth.md 4 の共有された情報と同じ考え方）。
- **未設定を先に確かめ、数えない。** 比べる鍵がないので試行にならない。数えないので、未設定の間に何度呼ばれても書き込みが起きない。学校のアカウントには、試行の上限より先に本当の原因（未設定）が見える。
- **43文字より短い鍵は未設定とみなす。** 試しに `test` などを入れたまま忘れても、保守用の API が開かないようにする。43文字は32バイトを base64url にした長さ（auth.md 6「32バイト以上のランダムな値」）。
- **鍵の値は前後の空白も除かずに比べる。** 下の 6.2 の手順で作る値には空白が入らない。
- 失敗を数えるときは、`transactionSync` の中で、行がなければ `failures = 1` で足し（`first_at`・`last_at` は実際の時刻。秒を切り捨てない）、あれば `failures` を1増やして `last_at` を書く。足したときは 10,000行を超えた古い行を消す（schema.md 2.10）。`unknown_id_failures`・`wrong_password_failures` は 0、`last_login_id` は `NULL`。
- 鍵が通った後の誤り（本文、入力の形式、対象がない、重複）は失敗として数えない。鍵を知っている人の操作の誤りで、試行ではない。

### 6.2 手順（PowerShell）

学校のアカウントが Windows の PC で行う手順。`curl.exe` は Windows 10 以降に標準で入っている（PowerShell の `curl` は別のコマンドの別名なので、`.exe` まで書く）。鍵とパスワードは PowerShell の中で作り、キーボードで打たない。コマンドの履歴には変数の名前だけが残り、値は残らない。

1. 鍵を作り、クリップボードに写す。

   ```powershell
   $b = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $env:MAINT_KEY = [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_'); Set-Clipboard -Value $env:MAINT_KEY
   ```

2. Cloudflare の管理画面で、システムの Worker の「設定」→「変数とシークレット」に、種類「シークレット」、名前 `MAINT_KEY` で貼り付けて保存する。保存したらクリップボードを消す（`Set-Clipboard -Value ' '`）。`npx wrangler secret put MAINT_KEY` でも設定できる（手元のコードは送らない）。
3. 新しい管理者のパスワードを作る（24バイトを base64url にした32文字。すべてパスワードに使える文字になる）。

   ```powershell
   $b = [byte[]]::new(24); [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $pw = [Convert]::ToBase64String($b).Replace('+','-').Replace('/','_')
   ```

4. 本文をファイルに書く。管理者の作成なら次のとおり（ID と表示用の名前は置き換える）。パスワードの設定し直しなら `@{ password = $pw }` だけにする。

   ```powershell
   @{ login_id = 'tanaka'; display_name = '田中 太郎'; password = $pw } | ConvertTo-Json | Set-Content -Encoding utf8 body.json
   ```

5. 呼ぶ。パスワードの設定し直しなら、パスを `/api/maint/admins/（番号）/reset-password` にする。番号の調べ方は 8.2。

   ```powershell
   curl.exe -s -X POST https://（システムの URL）/api/maint/admins -H "Authorization: Bearer $env:MAINT_KEY" -H "Content-Type: application/json" --data-binary "@body.json"
   ```

6. 応答が `{"ok":true,"data":{"id":…,"login_id":…,"display_name":…}}` であることを確かめる。`"ok":false` なら `error.code` を error-codes.md で引く。成功したら、`$pw` を表示して管理者に伝える（ADM-2 の制約により、作った人はパスワードを知ったままになる）。
7. 後片付けをする。そのあと管理画面で `MAINT_KEY` を消す（auth.md 6「ふだんは消しておく」）。

   ```powershell
   Remove-Item body.json; Remove-Item Env:MAINT_KEY; Remove-Variable pw, b
   ```

- Windows PowerShell 5.1 の `Set-Content -Encoding utf8` は、ファイルの先頭に BOM を付ける。台帳は本文を `request.text()` で読む。UTF-8 として読むときに先頭の BOM は除かれる（Fetch の仕様）ので、BOM があっても読める。台帳の層のテストで確かめる（8.3）。
- 本文をファイルで渡すのは、パスワードをコマンドの引数に書かないため。`--data-binary` はファイルのバイト列を変えずに送る。
- macOS・Linux の端末なら、同じことを次のように書ける（鍵は `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` などで作る）。

   ```
   curl -s -X POST https://（システムの URL）/api/maint/admins \
     -H "Authorization: Bearer $MAINT_KEY" \
     -H "Content-Type: application/json" \
     --data-binary @body.json
   ```

## 7. 台帳の層のテストの観点（共通の部分）

| 観点 | 確かめること |
| --- | --- |
| 経路 | ない経路、`{id}` が整数でない経路は `NOT_FOUND_API`（404） |
| `Origin` | `POST` で `Origin` がない、違うときは `AUTH_ORIGIN`。`GET` と保守用の API は確かめない |
| 順 | 本文が壊れていて証明もないときは `AUTH_REQUIRED`（認証が先）。保守用の API でも、本文が壊れていて鍵が違えば `AUTH_MAINT_KEY_INVALID`。利用の開始・管理者の認証では `INPUT_BODY` が先。上限を超えた相手には `LIMIT_ATTEMPTS` が先 |
| 本文 | JSON でない、オブジェクトでない、16 KiB を超えるときは `INPUT_BODY`。知らない項目があっても受け付ける |
| ヘッダ | 成功でも断るときでも `Cache-Control: no-store` が付く |
| 例外 | 処理の途中で例外が起きると 500 と `{ "ok": false }` を返し、表に何も書かれていない |
| 時計 | 1つの要求で `clock()` が1回だけ呼ばれる |

テスト名は関係する要件の ID で始める。要件の ID がない仕組みのテストは `API` で始める（schema.md 5.4 の `SCHEMA` と同じ扱い）。

## 8. API ごとの入出力

機能ごとの設計で、API ごとに次を足す。

- 要求の項目（名前・型・省略できるか）
- 応答の `data` の項目
- 返しうるコード（確かめる順に）
- 記録に書くこと（LOG-1〜LOG-4）

| API | 機能 | 状態 |
| --- | --- | --- |
| `POST /api/maint/admins`、`POST /api/maint/admins/{id}/reset-password` | 保守用の API（ADM-2） | 済（8.1〜8.3） |
| `POST /api/admin/login`、`GET /api/admin/me`、`POST /api/admin/logout`、管理者の API に共通の証明の確かめ方 | 管理者の認証（ADM-2） | 済（8.4〜8.8） |
| screens-and-api.md 5 の一覧の残りすべて | rules.md 6 の表の各機能と、利用の開始・管理者の認証・利用者の入力・予約状況 | 未 |

### 8.1 `POST /api/maint/admins`（管理者の作成。ADM-2）

学校のアカウントが、システムの外から管理者のアカウントを作る（最初の管理者と、全員が認証できなくなったときの復旧）。経路の表（3.3）では、認証の種類は「保守」、包むかは「包む」。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `login_id` | 文字列 | できない | 管理者の ID。全角・大文字で送っても、そろえて保存する（rules.md 6.2） |
| `display_name` | 文字列 | できない | 表示用の名前（USR-5 と同じ条件）。前後の空白を除いて保存する |
| `password` | 文字列 | できない | パスワード（auth.md 5） |

処理（すべて `blockConcurrencyWhile` の中。例外は中で受け止めて 500 にする。time-and-concurrency.md 4）：

1. 準備：本文を読む。鍵の SHA-256 を求める（6.1）。新しいソルト（ランダムな16バイト）を作る。
2. `clock()` で現在時刻を取る。
3. 同期で確かめる（下の「返しうるコード」の順）。`login_id` はそろえた値で、store が同じ ID の行を削除した行も含めて引き、`checkAdminCreate` に渡す（rules.md 6.1）。
4. すべて通ったときだけ、PBKDF2-HMAC-SHA256 を設定値の反復回数（100,000回。design-values.md）で計算する（`await`）。断る要求には計算しない（auth.md 7）。
5. `transactionSync` の中で、自動の変化を反映し（rules.md 5）、`admins` に1行足し（`password_version = 1`、`password_iterations` は使った回数、`created_at` は 2 の時刻）、記録を書く。
6. 成功を返す。

- 断るときは、鍵の失敗を数える（6.1）ほかは何も書かない。自動の変化も反映しない。応答に予約の情報を含まず、次の要求で反映されるので RSV-21 に反しない。
- 包んだ中で 3 から 5 まで割り込まれないので、同じ ID の作成がほぼ同時に届いても、後の要求は 3 で `RULE_ADMIN_ID_DUPLICATE` になる（RSV-23）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `id` | 管理者の番号（`admins.id`）。パスワードの設定し直し（8.2）で使う |
| `login_id` | そろえた後の ID。管理者はこの値で認証する |
| `display_name` | 前後の空白を除いた名前 |

パスワードとハッシュは返さない。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_MAINT_DISABLED` | 共3（6.1 の 1） |
| 3 | `LIMIT_ATTEMPTS` | 共3（6.1 の 2） |
| 4 | `AUTH_MAINT_KEY_INVALID` | 共3（6.1 の 3） |
| 5 | `INPUT_BODY`（JSON のオブジェクトでない、項目がない、文字列でない） | 共4 |
| 6 | `INPUT_LOGIN_ID` | 1 |
| 7 | `INPUT_NAME` | 1 |
| 8 | `INPUT_PASSWORD` | 1 |
| 9 | `RULE_ADMIN_ID_DUPLICATE` | 8 |

記録（`events`。schema.md 2.9）：`at` は 2 の時刻、`actor_kind = 'maint'`、`actor_admin_id = NULL`、`kind = 'admin_created'`、`admin_id` は作った管理者の番号、`detail` は `{"login_id": …, "display_name": …}`。パスワード・ハッシュ・ソルト・鍵は入れない（SEC-4, LOG-4）。ADM-2 によりこの操作は LOG-4 の対象ではないが、追跡のため保守用の API によることを残す（auth.md 6）。

### 8.2 `POST /api/maint/admins/{id}/reset-password`（パスワードの設定し直し。ADM-2）

学校のアカウントが、管理者のパスワードを設定し直す。ID は変わらない。経路の表では、認証の種類は「保守」、包むかは「包む」。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `password` | 文字列 | できない | 新しいパスワード（auth.md 5） |

処理は 8.1 と同じ流れで、次が違う。

- 3 で、store が `{id}` の管理者の行を削除した行も含めて引き、`checkAdminPasswordReset` に渡す（rules.md 6.1）。
- 5 で、その行の `password_hash`・`password_salt`・`password_iterations` を上書きし、`password_version` を1増やす。これでその管理者の認証した状態は、すべての端末で直ちに止まる（次の要求から `AUTH_REVOKED`。ADM-2、auth.md 3）。

応答の `data` は 8.1 と同じ（`id`・`login_id`・`display_name`）。

返しうるコード（確かめる順）：`NOT_FOUND_API`（`{id}` が正の整数の形でないときも）→ `AUTH_MAINT_DISABLED` → `LIMIT_ATTEMPTS` → `AUTH_MAINT_KEY_INVALID` → `INPUT_BODY` → `INPUT_PASSWORD`（段 1）→ `NOT_FOUND_ADMIN`（段 2。いない、または削除済み）。

記録：8.1 と同じ形で、`kind = 'admin_password_reset'`、`admin_id` は対象の管理者、`detail` は `{"login_id": …, "display_name": …}`。

**番号の調べ方。** 作成したときの応答の `id` を控えておく。わからなければ、Cloudflare の管理画面の Data Studio（logging.md 6）で次の SQL を実行する。Data Studio を使える権限は、`MAINT_KEY` を設定できる権限と同じ（PRE-11）。

```sql
SELECT id, login_id, display_name, deleted_at FROM admins ORDER BY id;
```

削除した管理者（`deleted_at` が入っている）のパスワードは設定し直せない。その人を戻したいときは、別の ID で作り直す（ADM-2「削除したアカウントの ID は再び使えない」）。

### 8.3 台帳の層のテストの観点（保守用の API）

| ID | 確かめること |
| --- | --- |
| ADM-2 | 作成すると `admins` に1行でき（版 1、反復回数 100,000、ID はそろえた値、名前は前後の空白を除いた値）、応答の `data` がその値になる。設定し直すと版が1増え、ハッシュとソルトが変わる |
| ADM-2 | 設定し直すと、その管理者の前の版の証明（`admin_sessions` にテストが直接入れた行）で管理者の API を呼ぶと `AUTH_REVOKED` になる。ほかの管理者の証明は止まらない（管理者の認証の機能ができてから、その機能のテストに含めてもよい） |
| ADM-2 | `Tanaka` で作った後に `tanaka` や `ＴＡＮＡＫＡ` で作ると `RULE_ADMIN_ID_DUPLICATE`。削除した管理者の ID でも同じ（`deleted_at` をテストが入れる） |
| ADM-2 | ない番号、削除した管理者の番号への設定し直しは `NOT_FOUND_ADMIN`。`{id}` が `0`・`01`・`abc` なら `NOT_FOUND_API` |
| ADM-2 | `MAINT_KEY` がない、42文字のときは `AUTH_MAINT_DISABLED` で、`auth_failures` に行が増えない |
| SEC-3 | 鍵が違う、ヘッダがない、`Bearer` の形でないときは `AUTH_MAINT_KEY_INVALID` で、失敗が1増える。5回失敗した後は、正しい鍵でも `LIMIT_ATTEMPTS`。別の IP（IPv6 は別の /64）は止まらない。次の10分の区切りでは通る。上限後の試行で失敗の行が変わらない |
| SEC-3 | 鍵が通った後の誤り（`INPUT_*`、`NOT_FOUND_ADMIN`、`RULE_ADMIN_ID_DUPLICATE`）では失敗が増えない |
| SEC-3 | 本文が壊れていて鍵も違うときは `AUTH_MAINT_KEY_INVALID`（鍵が先）。`Origin` がなくても、違っても断らない |
| RSV-23 | 同じ ID の作成を2つ同時に送ると、片方が成功し、もう片方が `RULE_ADMIN_ID_DUPLICATE` |
| LOG-4 | 成功すると `events` に `actor_kind = 'maint'` の行が1つでき、`detail` に `login_id`・`display_name` だけがある。`events`・`auth_failures` のどの列にも、パスワード・鍵の値が入っていない |
| API | 先頭に BOM の付いた UTF-8 の本文を読める。断る要求では `admins`・`events` に何も書かれていない |
| API | PBKDF2 は、断る要求では呼ばれない（テストで計算の関数を差し替えて数える） |

### 8.4 `POST /api/admin/login`（管理者の認証。ADM-2, SEC-3）

管理者が ID とパスワードで認証し、管理者の認証した状態（証明）を受け取る。経路の表（3.3）では、認証の種類は「誰でも」、包むかは「包む」。確かめる順は 4 の例外（上限 → 本文 → ID とパスワード）。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `login_id` | 文字列 | できない | 管理者の ID。全角・大文字で送っても、そろえて引く（rules.md 6.2） |
| `password` | 文字列 | できない | パスワード。そろえずに使う |

処理（すべて `blockConcurrencyWhile` の中。例外は中で受け止めて 500 にする）：

1. 準備：本文を読む。新しい証明の値（ランダムな32バイトを base64url にした43文字）とその SHA-256 を作る。ダミーのソルト（ランダムな16バイト）を作る。
2. `clock()` で現在時刻を取る。
3. 同期で確かめる。
   - `Origin`（共2）。
   - 試行の上限：`auth_failures` の、`entry = 'admin_login'`・`client = clientKey(CF-Connecting-IP)`・`windowStart(now)` の行を引き、`checkAttemptLimit(行, 10)`（rules.md 6.3）。
   - 本文（共4）：JSON のオブジェクトで、`login_id`・`password` がどちらも文字列であること。
   - `validateLoginId(login_id)`。通れば、store がそろえた ID で管理者の行を引く（削除した行も含む）。通らなければ管理者は `null` とする。`INPUT_LOGIN_ID` は返さない。
4. PBKDF2-HMAC-SHA256 を必ず1回計算する（`await`）。入力は `password` の UTF-8 のバイト列。使える管理者（行があり、削除していない）がいればその行の `password_salt`・`password_iterations` で計算する。いなければダミーのソルトと設定値の反復回数（100,000回）で計算する。
5. 使える管理者がいれば `equalBytes(結果, password_hash)` を求め、いなければ偽とする。`checkAdminLogin(管理者, 結果)` で判定する（rules.md 6.3）。
6. `transactionSync` の中で書く。
   - 成功のとき：自動の変化を反映する（rules.md 5）。`admin_sessions` に1行足す（`token_hash` は 1 のハッシュ、`admin_id`、`password_version` はその管理者の現在の値、`created_at` は 2 の時刻、`ended_at` は `NULL`）。記録を書く。
   - 失敗のとき：失敗を数える（6.1 と同じ書き方）。あわせて、`failure` が `unknown_id` なら `unknown_id_failures` を、`wrong_password` なら `wrong_password_failures` を1増やす。`last_login_id` には、3 で形式が通ればそろえた ID を、通らなければ `'(invalid)'` を書く。自動の変化は反映しない（8.1 と同じ）。
7. 応答を返す。成功なら `Set-Cookie: adminCookie(1 の値)`（rules.md 6.3）を付ける。

決めたことと理由：

- **ID がないときも PBKDF2 を計算する。** 計算しないと、ID がないときだけ応答が約30ms速くなり、ID の有無が時間からわかる（auth.md 8 の趣旨に反する）。形式が合わない、ない、削除した、のどれでも、ある ID と同じ1回の計算をする。CPU の負担は試行の上限（10分ごとに10回）で抑えられる。上限を超えた相手と本文が読めない要求には計算しない（auth.md 7）。
- **形式の誤りも `AUTH_ADMIN_FAILED` にして、失敗として数える。** `INPUT_LOGIN_ID`・`INPUT_PASSWORD` を返すと、ID やパスワードの条件を外から確かめられる。パスワードの形式（`validatePassword`）は確かめない。条件に合わない値は保存してあるハッシュと一致しないので、確かめなくても結果は同じになる。本文の長さは 16 KiB までなので、PBKDF2 の入力が長くなりすぎることはない。
- **本文が読めないとき（`INPUT_BODY`）は数えない。** ID もパスワードも試していないので、試行にならない。PBKDF2 も計算しない。
- **形式に合わない ID は `'(invalid)'` と書き、そのまま残さない。** ID の欄にパスワードを打ち間違えた値などが記録に残らないようにする（SEC-4）。列の長さも32文字までに収まる。
- **有効な Cookie を持ったまま呼ばれても、ふつうに処理する。** 古い証明の行はそのまま残る。新しい `Set-Cookie` でブラウザの値が上書きされるので、古い値はもう送られない。画面は、`GET /api/admin/me` で認証していないとわかったときだけ認証の画面を出すので、ふだんはこの場合が起きない。
- **成功しても、その相手の失敗の数を戻さない。** 固定の10分の区切りのまま、仕組みを単純にする（auth.md 7）。
- **同時に届いた試行も上限をすり抜けない。** 処理全体を包むので、3 で上限を確かめてから 6 で数えるまでの間に、ほかの試行が割り込まない（auth.md 7）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `id` | 管理者の番号 |
| `login_id` | そろえた後の ID |
| `display_name` | 表示用の名前 |

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `LIMIT_ATTEMPTS` | 共3（上限） |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `AUTH_ADMIN_FAILED` | 共3（ID とパスワード） |

記録：

- 成功（`events`）：`at` は 2 の時刻、`actor_kind = 'admin'`、`actor_admin_id` と `admin_id` は認証した管理者の番号、`kind = 'admin_login'`、`detail` は `{"ip": …}`。`ip` は `CF-Connecting-IP` の値をそのまま入れる（ないときは `"unknown"`）。IPv6 を /64 にまとめない。追跡に使うので、細かいほうがよい。
- 失敗（`auth_failures`）：上の 6。LOG-4 の「失敗の記録」にあたる。上限に達した後の試行は書かない（logging.md 4）。
- どちらにも、パスワード・ハッシュ・証明の値を入れない（SEC-4, LOG-4）。

### 8.5 管理者の API に共通の証明の確かめ方（共3。ADM-2）

`GET /api/admin/me`・`POST /api/admin/logout` と、これから足す管理者の API（機器・予約の管理・数値・管理者のアカウント・共有された情報）は、すべて次のように確かめる。

1. 準備（3.3 の 2）：`readCookie(Cookie, '__Host-dxp_admin')` で値を取り出す。`isTokenFormat` を通れば、その SHA-256 を求める。通らなければ、Cookie がないものとする（rules.md 6.3）。
2. 共3：store がハッシュで `admin_sessions` の行を引き、あればその `admin_id` の管理者の行も引く（削除した行も含む）。`checkAdminSession(行, 管理者)` で判定する。Cookie がないときは行を `null` として渡す。
3. 通ったら、API ごとの関数に、管理者の番号と証明の行の番号を渡す。記録の `actor_admin_id` はこの管理者の番号にする（LOG-4）。

- **期限を延ばす。** 共3 を通った後の応答には、成功でも、後の段で断るとき（`INPUT_`・`RULE_` など）でも、`Set-Cookie: adminCookie(受け取った値)` を付ける（auth.md 3「使うたびに延ばす」）。表には書かない（schema.md 2.8）。例外の 500 には付けない（付けなくても、それまでの期限が残る）。
- **共3 で断るときは `Set-Cookie` を付けない。** 画面は `AUTH_REQUIRED`・`AUTH_REVOKED` を受けたら認証の画面に移る。`AUTH_REVOKED` では「パスワードが設定し直されたか、アカウントが削除されたため」と案内できる（error-codes.md 3.2）。
- **自動の変化は、共3 を通った後に反映する。** 管理者の API はすべて、API ごとの `transactionSync` の最初で反映する（architecture.md 手順 3）。
- **パスワードの版で止める。** パスワードの設定し直し（8.2 と、管理者の画面からの設定し直し）で版が増えると、その管理者の証明は次の要求から `AUTH_REVOKED` になる。削除も `deleted_at` で同じく止まる（ADM-2「すべての端末で直ちに止める」）。

### 8.6 `GET /api/admin/me`（認証の状態。ADM-2）

管理者の画面を開いたときに呼び、認証しているかと、だれとして認証しているかを返す。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

処理：準備（8.5 の 1）→ `clock()` → 共3（8.5 の 2）→ `transactionSync` の中で自動の変化を反映する → 成功を返す（`Set-Cookie` で期限を延ばす）。

応答の `data` は 8.4 と同じ（`id`・`login_id`・`display_name`）。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_REQUIRED` → `AUTH_REVOKED`。`GET` なので `Origin` と本文は確かめない。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.7 `POST /api/admin/logout`（認証を解く。ADM-2）

その端末の管理者の認証した状態を解く。ほかの端末の証明は止めない（ADM-2「認証した状態を解ける」）。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求の本文：項目なし。画面は `{}` を送る（共4 を例外にしないため。2）。

処理：準備 → `clock()` → 共2 → 共3 → 共4 → `transactionSync` の中で、自動の変化を反映し、その証明の行の `ended_at` に 2 の時刻を書き、記録を書く → 成功を返す。

- 応答の `data` は `{}`。`Set-Cookie: clearAdminCookie()`（rules.md 6.3）で端末の Cookie を消す。
- 行は消さず、`ended_at` を入れるだけにする（LOG-5）。Cookie が消せなかった端末から同じ値が送られても、次の要求から `AUTH_REVOKED` になる。
- すでに解いた証明で呼ばれたら `AUTH_REVOKED` を返す。画面は、成功と同じく認証の画面に移る。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_ORIGIN` → `AUTH_REQUIRED` → `AUTH_REVOKED` → `INPUT_BODY`。

記録（`events`）：`at` は 2 の時刻、`actor_kind = 'admin'`、`actor_admin_id` と `admin_id` はその管理者の番号、`kind = 'admin_logout'`、`detail` は `{"ip": …}`（8.4 と同じ）。

### 8.8 台帳の層のテストの観点（管理者の認証）

| ID | 確かめること |
| --- | --- |
| ADM-2 | 保守用の API で作った管理者の ID とパスワードで認証すると、`admin_sessions` に1行でき（版は管理者の現在の版）、`Set-Cookie` に `__Host-dxp_admin`・`HttpOnly`・`Secure`・`SameSite=Strict`・`Path=/`・`Max-Age=34560000` が付く。その Cookie で `GET /api/admin/me` が通り、`data` が管理者の値になる |
| ADM-2 | `TANAKA` や全角の `ＴＡＮＡＫＡ` で認証しても通る。パスワードは大文字・小文字を区別する |
| ADM-2 | ID がない、形式に合わない、削除した管理者（正しいパスワードでも）、パスワードが違う、パスワードが14文字や空白入り、のどれも `AUTH_ADMIN_FAILED`（401）で、応答の本文が同じ |
| ADM-2 | ID がないときも、ある ID と同じく PBKDF2 が1回呼ばれる（テストで計算の関数を差し替えて数える）。`INPUT_BODY`・`LIMIT_ATTEMPTS`・`AUTH_ORIGIN` では呼ばれない |
| ADM-2 | `logout` の後、同じ Cookie の値で `me` を呼ぶと `AUTH_REVOKED`。応答に `Max-Age=0` の `Set-Cookie` が付く。同じ管理者のほかの証明は止まらない |
| ADM-2 | 保守用の API でパスワードを設定し直すと、その管理者のすべての証明が `AUTH_REVOKED` になる。`deleted_at` をテストが入れても同じ。ほかの管理者の証明は止まらない |
| ADM-2 | Cookie がない、形が違う（42文字など）、表にない値は `AUTH_REQUIRED` |
| ADM-2 | 共3 を通った管理者の API の応答には、同じ値の `Set-Cookie` が付く（`logout` の成功を除く）。共3 で断る応答には付かない |
| SEC-3 | 失敗すると `auth_failures` の `entry = 'admin_login'` の行が1増え、ID がないなら `unknown_id_failures`、パスワードが違えば `wrong_password_failures` が増える。`last_login_id` はそろえた ID、形式に合わなければ `'(invalid)'` |
| SEC-3 | 10回失敗した後は、正しい ID とパスワードでも `LIMIT_ATTEMPTS`（429）で、行が変わらない。別の IP は止まらない。次の10分の区切りでは通る。成功しても失敗の数は戻らない |
| SEC-3 | 上限を超えた相手には、本文が壊れていても `LIMIT_ATTEMPTS`（上限が先）。上限の前なら、本文が壊れていると `INPUT_BODY` で、失敗は増えない |
| SEC-3 | `logout` で `Origin` がないと `AUTH_ORIGIN`。`login` も同じ。`me`（`GET`）は確かめない |
| RSV-23 | 9回失敗した相手から認証を2つ同時に送ると、1つ目の失敗で上限に達し、2つ目は `LIMIT_ATTEMPTS` になる（包んでいるので割り込まない） |
| LOG-4 | 成功すると `admin_login`、`logout` で `admin_logout` が `actor_admin_id` 付きで1行でき、`detail` は `ip` だけ。`events`・`auth_failures` のどの列にも、パスワード・証明の値・そのハッシュが入っていない |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で、認証の成功や `me` を呼ぶと無断不使用になる。認証の失敗では変わらない |

## 採らなかった案

| 案 | 理由 |
| --- | --- |
| 作成の成功を 201、本文なしを 204 などに分ける | 画面の扱いが増えるだけで、v0.1.0 の画面は `ok` を見れば足りる |
| 知らない項目があれば断る | デプロイの直後に、新しい画面が古い台帳に項目を足して送ると断られる |
| 本文の誤りを認証より先に返す（どの API でも） | 認証されていない相手に入力の形を教えることになる |
| `Content-Type: application/json` を必須にする | CSRF の対策は `Origin` で足りる。確かめる項目が増えるだけ |
| Worker でも経路や認証を確かめる | 処理が2か所に分かれ（architecture.md 採らなかった案）、版の食い違いの影響も受ける |
| 画面と台帳で版の番号を突き合わせる | 上の 5 |
| 保守用の鍵を本文や URL に入れる | 上の 6 |
| 保守用の API でも、本文の誤りを鍵より先に返す | 鍵はヘッダにあり、本文がなくても確かめられる。鍵を知らない相手に入力の形を教えることになる（4） |
| `MAINT_KEY` の未設定と鍵の誤りを同じコードにする | 学校のアカウントが、シークレットの設定し忘れに気づけない（6.1） |
| パスワードの設定し直しの相手をパスの login_id で指す | 基本設計の経路（`{id}`）が変わり、管理者の画面からの設定し直しと形がそろわない。番号は応答と Data Studio でわかる（8.2） |
| 保守用に管理者の一覧の API を足す | 要件にない。Data Studio で足りる（8.2） |
| PBKDF2 を、ソルトが手元にあるので準備（3.3 の 2）で計算する | 鍵を確かめる前に計算すると、鍵を知らない相手に CPU を使わせる（auth.md 7） |
| 管理者の認証で、ID がないときは PBKDF2 を計算しない | 応答の時間から ID の有無がわかる（8.4） |
| 管理者の認証で、ID・パスワードの形式の誤りを `INPUT_` で返す | ID とパスワードの条件を外から確かめられる（8.4） |
| 有効な Cookie を持ったまま認証したら、古い証明を解く | 古い値はブラウザで上書きされて送られなくなるので、得るものが小さく、分岐が増える（8.4） |
| 認証に成功したら、その相手の失敗の数を戻す | 仕組みが増える。固定の区切りで足りる（auth.md 7） |
| `logout` だけ本文を求めない | 共4 の例外が増える。画面は `{}` を送れば足りる（8.7） |
| 記録の `ip` を `clientKey` でまとめた値にする | 追跡に使うので、細かい値のほうがよい（8.4） |
| 共3 で断るときに Cookie を消す | 画面は `AUTH_REQUIRED`・`AUTH_REVOKED` で認証の画面に移るので要らない（8.5） |

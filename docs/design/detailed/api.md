# API

- 状態：作成中（共通の部分と、screens-and-api.md 5 の一覧のすべての API の入出力を決定。詳細設計のレビューで見直す）
- 日付：2026-11-19
- 関係する要件：USR-1〜USR-7, LOG-1〜LOG-4, MNG-1〜MNG-3, VIW-1, RSV-2〜RSV-20, TIM-1〜TIM-7, ADM-2, ADM-3, RSV-21〜RSV-23, RSV-27, VIW-2, VIW-3, SEC-2〜SEC-4, LOG-4, TIM-1, NFR-4, PRE-5, FUT-1
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
- 例外は `handle` の一番外で受け止めて 500 に変える。`transactionSync` の中で起きた例外は、その前にトランザクションを取り消している（time-and-concurrency.md 4）。`blockConcurrencyWhile` の中では、包んだ処理の中で受け止める（同 4 の注意）。例外の中身は `console.error` に出すが、要求と応答の本文・Cookie・ヘッダの値は出さない（LOG-4, SEC-4。応答の本文には共有された情報の値が入ることがある。8.9）。

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
- **例外：利用の開始（`POST /api/session`）、管理者の認証（`POST /api/admin/login`）。** 認証の値が本文に入っているので、本文が読めなければ認証を確かめられない。これらは共4 を共3 の前に確かめる。試行の上限（`LIMIT_ATTEMPTS`）は共4 より前に確かめ、上限を超えた相手には本文の誤りも教えない。利用の開始では、さらに上限より前に、すでに有効な証明を持つかを確かめ、持っていれば成功を返す（8.11）。
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
| `POST /api/admin/shared-info` | 共有された情報の設定・変更（ADM-3） | 済（8.9〜8.10） |
| `POST /api/session`、`GET /api/session`、利用者の API に共通の証明の確かめ方 | 利用の開始（USR-2） | 済（8.11〜8.14） |
| `POST /api/me`、利用者の操作の API に共通の利用者の引き方 | 利用者の入力（USR-3〜USR-7, LOG-1） | 済（8.15〜8.17） |
| `GET /api/admin/devices`、`POST /api/admin/devices`、`POST /api/admin/devices/{id}/rename`、`…/delete`、`GET /api/devices` | 機器（MNG-1, MNG-2, VIW-1 の機器の一覧） | 済（8.18〜8.23） |
| `GET /api/devices/{id}/day`、`POST /api/reservations` | 予約状況・確保（VIW-1, VIW-2, RSV-2〜RSV-6） | 済（8.24〜8.26） |
| `POST /api/walk-ins` | 予約なしの利用（RSV-17, RSV-20） | 済（8.27〜8.28） |
| `POST /api/my/reservations`、`POST /api/reservations/{id}/cancel` | 自分の予約・取消（RSV-7, RSV-8） | 済（8.29〜8.31） |
| `POST /api/reservations/{id}/change` | 時間帯の変更（RSV-9〜RSV-12） | 済（8.32〜8.33） |
| `POST /api/reservations/{id}/begin`、`…/finish` | 利用開始・利用終了（RSV-13〜RSV-16, RSV-18, RSV-19） | 済（8.34〜8.36） |
| `GET /api/admin/devices/{id}/reservations`、`POST /api/admin/reservations/{id}/cancel`、`…/finish` | 予約の管理（MNG-3） | 済（8.37〜8.40） |
| `GET /api/admin/settings`、`POST /api/admin/settings` | 数値の変更（RSV-25, RSV-26） | 済（8.41〜8.43） |
| `GET /api/admin/admins`、`POST /api/admin/admins`、`POST /api/admin/admins/{id}/reset-password`、`…/delete` | 管理者のアカウント（ADM-2） | 済（8.44〜8.48） |

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

- 3 で、store が `{id}` の管理者の行を削除した行も含めて引き、`checkAdminPasswordReset(行, null)` に渡す（rules.md 6.1。操作する管理者がいないので、自分自身の設定し直しの段 8 で断らない）。
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

1. 準備：本文を読む。新しい証明の値とその SHA-256 を `newToken()`（rules.md 6.3。ランダムな32バイトを base64url にした43文字）で作る。ダミーのソルト（ランダムな16バイト）を作る。
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

- **期限を延ばす。** 共3 を通った後の応答には、成功でも、後の段で断るとき（`INPUT_`・`RULE_` など）でも、`Set-Cookie: adminCookie(受け取った値)` を付ける（auth.md 3「使うたびに延ばす」）。表には書かない（schema.md 2.8）。例外の 500 には付けない（付けなくても、それまでの期限が残る）。`logout`（8.7）の成功と、自分自身の削除（8.47）の成功では、延ばさずに `clearAdminCookie()` を付ける。
- **共3 で断るときは `Set-Cookie` を付けない。** 画面は `AUTH_REQUIRED`・`AUTH_REVOKED` を受けたら認証の画面に移る。`AUTH_REVOKED` では「パスワードが設定し直されたか、アカウントが削除されたため」と案内できる（error-codes.md 3.2）。
- **自動の変化は、共3 を通った後に反映する。** 管理者の API はすべて、API ごとの `transactionSync` の最初で反映する（architecture.md 手順 3）。
- **パスワードの版で止める。** パスワードの設定し直し（8.2 と 8.46）で版が増えると、その管理者の証明は次の要求から `AUTH_REVOKED` になる。削除（8.47）も `deleted_at` で同じく止まる（ADM-2「すべての端末で直ちに止める」）。

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
| ADM-2 | 共3 を通った管理者の API の応答には、同じ値の `Set-Cookie` が付く（`logout` の成功と自分自身の削除の成功を除く。8.48）。共3 で断る応答には付かない |
| SEC-3 | 失敗すると `auth_failures` の `entry = 'admin_login'` の行が1増え、ID がないなら `unknown_id_failures`、パスワードが違えば `wrong_password_failures` が増える。`last_login_id` はそろえた ID、形式に合わなければ `'(invalid)'` |
| SEC-3 | 10回失敗した後は、正しい ID とパスワードでも `LIMIT_ATTEMPTS`（429）で、行が変わらない。別の IP は止まらない。次の10分の区切りでは通る。成功しても失敗の数は戻らない |
| SEC-3 | 上限を超えた相手には、本文が壊れていても `LIMIT_ATTEMPTS`（上限が先）。上限の前なら、本文が壊れていると `INPUT_BODY` で、失敗は増えない |
| SEC-3 | `logout` で `Origin` がないと `AUTH_ORIGIN`。`login` も同じ。`me`（`GET`）は確かめない |
| RSV-23 | 9回失敗した相手から認証を2つ同時に送ると、1つ目の失敗で上限に達し、2つ目は `LIMIT_ATTEMPTS` になる（包んでいるので割り込まない） |
| LOG-4 | 成功すると `admin_login`、`logout` で `admin_logout` が `actor_admin_id` 付きで1行でき、`detail` は `ip` だけ。`events`・`auth_failures` のどの列にも、パスワード・証明の値・そのハッシュが入っていない |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で、認証の成功や `me` を呼ぶと無断不使用になる。認証の失敗では変わらない |

### 8.9 `POST /api/admin/shared-info`（共有された情報の設定・変更。ADM-3, SEC-3, SEC-4, LOG-4）

管理者が共有された情報を設定・変更する。最初の設定も変更も同じ操作で行う（ADM-3）。値は台帳が作り、この応答で1回だけ返す（auth.md 2）。経路の表（3.3）では、認証の種類は「管理者」、包むかは「包まない」（ハッシュは SHA-256 だけで、準備で求められる。time-and-concurrency.md 4）。

要求の本文：項目なし。画面は `{}` を送る（8.7 と同じく、共4 を例外にしないため）。

処理：

1. 準備：Cookie の値のハッシュを求める（8.5 の 1）。新しい共有された情報の値とその SHA-256 を `newToken()`（rules.md 6.3）で作る。成功するかどうかにかかわらず、ここで作る（auth.md 3）。
2. `clock()` で現在時刻を取る。
3. 共2（`Origin`）→ 共3（8.5 の 2）→ 共4（本文）の順に確かめる。
4. `transactionSync` の中で、自動の変化を反映し（rules.md 5）、`shared_infos` に1行足し（`hash` は 1 のハッシュ、`created_at` は 2 の時刻）、記録を書く。足した行の `id` が新しい版になる（schema.md 2.6）。
5. 成功を返す（`Set-Cookie` で管理者の Cookie の期限を延ばす。8.5）。

- **判定はない。** 共3 を通れば必ず受け付ける。`src/rules/` に新しい関数は作らない（rules.md 6 の表）。
- **確保済みの予約は変えない（ADM-3）。** この API は予約の表に触れない（自動の変化の反映はほかの API と同じく行う）。
- **管理者の認証は止めない（ADM-3）。** `admin_sessions` に触れない。
- **利用を始めた端末は版で止まる。** `user_sessions` の行は消さず、書き換えもしない。始めた版が現在の版と違う証明は、利用者の API で `AUTH_REVOKED` になる（auth.md 3。確かめ方は 8.12）。
- **値の扱い（SEC-4）。** 台帳はハッシュだけを保存する。値は応答の本文にだけ入れ、記録・`console` に出さない（1）。応答には、ほかの応答と同じく `Cache-Control: no-store` が付く。応答が届かなかった（通信の断など）ときも行は足されているので、値はもうどこからも取り出せない。管理者はもう一度この操作をする（ADM-3「わからなくなったら設定し直す」）。
- **URL は画面が作る。** 利用者の画面の URL の後ろに `#k=値` を付ける（auth.md 2）。台帳は利用者の画面のパスを知らなくてよい。QR コードの描き方と、押す前の確かめを置くかは screens.md で決める（影響範囲の事前表示は10章で除かれている）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `value` | 新しい共有された情報の値（43文字の base64url） |

版の番号は返さない（画面で使わない。テストは表で確かめる）。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_ORIGIN` → `AUTH_REQUIRED` → `AUTH_REVOKED` → `INPUT_BODY`。新しいコードはない。

記録（`events`）：`at` は 2 の時刻、`actor_kind = 'admin'`、`actor_admin_id` は操作した管理者の番号、`kind = 'shared_info_set'`、`admin_id`・`reservation_id`・`device_id`・`user_id` は `NULL`、`detail` は `{"version": 足した行の id}`。値もハッシュも入れない（SEC-4、logging.md 3）。

**同時に押したとき（RSV-23）。** 2人の管理者がほぼ同時に操作すると、1つずつ処理されて2行でき、どちらにも成功と値が返る。後の行が現在の値になるので、先の管理者が表示している QR コードはすでに使えない。要件の範囲では扱わず、残るリスクとする（下の「採らなかった案」）。

### 8.10 台帳の層のテストの観点（共有された情報の設定）

| ID | 確かめること |
| --- | --- |
| ADM-3 | 未設定の台帳で呼ぶと `shared_infos` が0行から1行になる。応答の `value` は43文字の base64url で、その SHA-256 が `hash` と等しい |
| ADM-3 | 2回目を呼ぶと `id` が1つ大きい行が足され、値もハッシュも1回目と違う。1回目の行は残る |
| ADM-3 | 呼ぶ前後で、予約済・利用中の予約の行（状態・時刻）が変わらない（自動の変化の対象にならない予約で確かめる） |
| ADM-3 | 呼んだ管理者の Cookie でも、ほかの管理者の Cookie でも、その後の `GET /api/admin/me` が通る。応答に同じ値の `Set-Cookie` が付く |
| ADM-3 | 古い版で始めた証明が止まること（`AUTH_REVOKED`）は、利用の開始の機能のテスト（8.14）で確かめる |
| ADM-2 | Cookie がないと `AUTH_REQUIRED`、解いた証明では `AUTH_REVOKED` で、`shared_infos`・`events` に行が増えない |
| API | `Origin` がないと `AUTH_ORIGIN`。本文が壊れていて証明もないと `AUTH_REQUIRED`（認証が先）。証明が有効で本文が壊れていると `INPUT_BODY`。どれも行が増えない |
| LOG-4 | 成功すると `events` に `kind = 'shared_info_set'`・`actor_admin_id` 付きの行が1つでき、`detail` は `version` だけで、足した行の `id` と等しい。`events` のどの列にも値とハッシュが入っていない |
| SEC-4 | 処理の途中で例外が起きたとき、`console.error` の出力に値が含まれない（テストで出力を受け取って確かめる）。行も増えない |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で呼ぶと、無断不使用になる |
| RSV-23 | 2つ同時に送ると、どちらも成功して2行でき、2つの値は違う。`id` の大きい行のハッシュが、後に処理された応答の値の SHA-256 と等しい |

### 8.11 `POST /api/session`（利用の開始。USR-2, ADM-3, SEC-3, SEC-4）

利用者の端末が、QR コードの URL の `#k=値`（auth.md 2）を送り、利用を始めた証明を受け取る。経路の表（3.3）では、認証の種類は「誰でも」、包むかは「包まない」（PBKDF2 がなく、SHA-256 は準備で求めるので、確かめてから書くまでに `await` がない。auth.md 7）。確かめる順は 4 の例外（有効な証明 → 上限 → 本文 → 値）。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `k` | 文字列 | できない | 共有された情報の値。URL の `#k=` の後ろの値をそのまま送る。そろえずに使う |

- 名前を `k` にするのは、URL の `#k=` と同じにして、画面が読んだ値をそのまま送れるようにするため。

処理：

1. 準備（3.3 の 2）：
   - 本文を読む。
   - 利用者の Cookie の値のハッシュを求める（8.12 の 1）。
   - 本文の `k` が文字列で `isTokenFormat`（rules.md 6.3）を通るときだけ、その UTF-8 のバイト列の SHA-256 を求める。通らなければハッシュはないものとする。
   - 新しい証明の値とその SHA-256 を `newToken()` で作る。成功するかどうかにかかわらず、ここで作る（auth.md 3）。
2. `clock()` で現在時刻を取る。
3. 同期で、次の順に確かめる。
   1. `Origin`（共2）。
   2. 有効な証明：8.12 の 2 と同じく `checkUserSession` で判定する。通れば、下の 4 の「有効な証明があったとき」に進み、ii 以降を確かめない。通らなければ（`AUTH_REQUIRED`・`AUTH_REVOKED`）、断らずに ii に進む。
   3. 試行の上限：`auth_failures` の、`entry = 'shared_info'`・`client = clientKey(CF-Connecting-IP)`・`windowStart(now)` の行を引き、`checkAttemptLimit(行, 200)`。
   4. 本文（共4）：JSON のオブジェクトで、`k` が文字列であること。
   5. 値：store が現在の共有された情報の行（`shared_infos` の `id` の最も大きい行。なければ `null`）を引く。1 のハッシュがあって行もあれば `equalBytes(1 のハッシュ, 行の hash)` を求め、どちらかがなければ偽とする。`checkSharedInfo(行, 一致したか)`（rules.md 6.3）で判定する。
4. `transactionSync` の中で書く。
   - 有効な証明があったとき（3 の ii）：自動の変化を反映する（rules.md 5）。表にはほかに何も書かない。
   - 成功のとき：自動の変化を反映する。`user_sessions` に1行足す（`token_hash` は 1 の新しい証明のハッシュ、`shared_info_id` は 3 の v の行の `id`、`created_at` は 2 の時刻）。
   - 失敗のとき（`checkSharedInfo` が `failure` を返したとき）：失敗を数える（6.1 と同じ書き方。`entry = 'shared_info'`）。自動の変化は反映しない（8.1 と同じ）。
   - ほかで断るとき（`AUTH_ORIGIN`・`LIMIT_ATTEMPTS`・`INPUT_BODY`・`AUTH_SHARED_INFO_UNSET`）：何も書かない。
5. 応答を返す。有効な証明があったときは `Set-Cookie: userCookie(受け取った値)` で期限を延ばし、成功のときは `Set-Cookie: userCookie(1 の新しい値)` を付ける（rules.md 6.3）。

決めたことと理由：

- **有効な証明があれば、値を確かめずに成功を返す（auth.md 2）。** 新しい行も作らない。QR コードは掲示物で、来るたびに読む人が多いため。送られた値が古くても違っても成功にする。その端末はすでに現在の版で認証されている。
- **有効な証明の確認を、上限より先にする。** 校内の回線では利用者が外から同じ相手に見えるので、上限に達したときに、すでに使えている端末まで止めないため（SEC-3「正規の利用者の利用を妨げない」）。その端末は認証されているので、本文の誤りを確かめる必要もない。
- **止められた証明（古い版）は、ないものと同じに扱う。** 共有された情報が変わった後に新しい QR コードを読み直す流れがこれに当たる。新しい行を足し、新しい `Set-Cookie` でブラウザの値を上書きする。古い行は消さない（LOG-5）。
- **未設定は失敗として数えない。** 比べる値がないので試行にならない（6.1 の `AUTH_MAINT_DISABLED` と同じ考え方）。未設定の間は `entry = 'shared_info'` の失敗の行ができないので、上限より後に確かめても結果は変わらない。順は 4 の例外（上限 → 本文 → 値）に合わせる。
- **形が違う `k` も `AUTH_SHARED_INFO_WRONG` にして数える。** 管理者の認証（8.4）と同じく `INPUT_` を返さない。カメラが URL の一部しか読めなかったときもここに当たる。
- **古い版の値と、まったく違う値を区別しない。** 区別するには過去の版のハッシュとすべて比べる必要があり、要件にもない。画面の文は「QR コードが古いか、正しくありません」とする（screens.md）。
- **同時に届いた試行も上限をすり抜けない。** 3 から 4 までが同期の区間なので、包まなくても割り込まれない（auth.md 7）。

応答の `data`：`{}`。有効な証明があったときと、新しく始めたときで同じにする（画面はどちらかを知らなくてよい）。

返しうるコード（確かめる順）：

| 順 | コード | 段 | 失敗として数えるか |
| --- | --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 | ― |
| 2 | `AUTH_ORIGIN` | 共2 | 数えない |
| 3 | `LIMIT_ATTEMPTS` | 共3（上限） | 数えない（上限後は書かない。logging.md 4） |
| 4 | `INPUT_BODY` | 共4 | 数えない |
| 5 | `AUTH_SHARED_INFO_UNSET` | 共3（値） | 数えない |
| 6 | `AUTH_SHARED_INFO_WRONG` | 共3（値） | 数える |

記録：

- 成功は記録しない（logging.md 2。LOG-4 の対象は管理者の認証）。証明の表に作った時刻が残る。
- 失敗（`auth_failures`）：上の 4。`unknown_id_failures`・`wrong_password_failures` は 0、`last_login_id` は `NULL`。
- どちらにも、共有された情報の値・そのハッシュ・証明の値を入れない（SEC-4, LOG-4）。

### 8.12 利用者の API に共通の証明の確かめ方（共3。USR-2, ADM-3）

`GET /api/session` を除く利用者の API（`POST /api/me`、機器の一覧・予約状況、予約の操作）は、すべて次のように確かめる。

1. 準備（3.3 の 2）：`readCookie(Cookie, '__Host-dxp_user')` で値を取り出す。`isTokenFormat` を通れば、その SHA-256 を求める。通らなければ、Cookie がないものとする（rules.md 6.3）。
2. 共3：store がハッシュで `user_sessions` の行を引き、あわせて現在の共有された情報の版（`shared_infos` の最も大きい `id`。なければ `null`）を引く。`checkUserSession(行, 現在の版)` で判定する。Cookie がないときは行を `null` として渡す。
3. 通ったら、API ごとの関数に進む。

- **期限を延ばす。** 共3 を通った後の応答には、成功でも、後の段で断るとき（`INPUT_`・`NOT_FOUND_`・`STATE_`・`RULE_`）でも、`Set-Cookie: userCookie(受け取った値)` を付ける（8.5 と同じ。auth.md 3「使うたびに延ばす」）。表には書かない（schema.md 2.8 の後の注）。例外の 500 と、共3 で断る応答には付けない。
- **共有された情報の版で止める。** 共有された情報を設定し直す（8.9）と現在の版が変わり、それまでの証明は次の要求から `AUTH_REVOKED` になる（ADM-3「すでに利用を始めている端末も含めてすべての端末で止まる」）。行は書き換えない。
- **画面の扱い。** `AUTH_REQUIRED` を受けたら「QR コードを読んでください」、`AUTH_REVOKED` を受けたら「QR コードが新しくなったので読み直してください」と案内する（error-codes.md 3.2）。
- **自動の変化は、共3 を通った後に反映する。** 8.5 と同じ。
- 利用者の API は管理者の証明を受け付けない（auth.md 1。`__Host-dxp_admin` は見ない）。管理者の API も利用者の証明を見ない。

### 8.13 `GET /api/session`（利用を始めているか。USR-2）

利用者の画面を開いたときに呼び、その端末の証明が有効かを返す。経路の表では、認証の種類は「誰でも」、包むかは「包まない」。共3 で断らない（4 の表）。

処理：準備（8.12 の 1）→ `clock()` → 8.12 の 2 と同じく `checkUserSession` で判定 → 有効なら `transactionSync` の中で自動の変化を反映する → 応答を返す。

応答の `data`：

| 場合 | `data` | `Set-Cookie` |
| --- | --- | --- |
| 有効 | `{ "active": true }` | `userCookie(受け取った値)` で延ばす |
| 有効でない | `{ "active": false, "reason": コード }`。コードは `checkUserSession` が返した `AUTH_REQUIRED` か `AUTH_REVOKED` | 付けない |

- **`reason` にはエラーのコードをそのまま入れる。** 画面は `messages.js` の文を使い回して、「QR コードを読んでください」と「読み直してください」を出し分けられる。`active` が偽でも HTTP は 200 で、`ok` は真。
- **未設定は区別しない。** 未設定の間は証明が作られないので、`reason` は必ず `AUTH_REQUIRED` になる。QR コードを読めば `POST` が `AUTH_SHARED_INFO_UNSET` を返す。
- **有効でないときは自動の変化を反映しない。** 共3 を通った後に反映する（8.5）のと合わせる。
- `#k=` 付きで開かれたときは、画面はこの API を呼ばずに `POST /api/session` を送る（有効な証明があれば `POST` が値を見ずに成功を返す）。

返しうるコード：`NOT_FOUND_API` だけ。`GET` なので `Origin` と本文は確かめない。

記録：書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.14 台帳の層のテストの観点（利用の開始）

| ID | 確かめること |
| --- | --- |
| USR-2 | 共有された情報の設定（8.9）で返った値で `POST /api/session` を呼ぶと、`user_sessions` に1行でき（`shared_info_id` は現在の版）、`Set-Cookie` に `__Host-dxp_user`・`HttpOnly`・`Secure`・`SameSite=Strict`・`Path=/`・`Max-Age=34560000` が付く。その Cookie で `GET /api/session` が `active: true` |
| USR-2 | 有効な Cookie を持ったまま、同じ値・違う値・形の違う値・壊れた本文で `POST` しても成功し、行が増えず、失敗も増えない。`Set-Cookie` は受け取った値と同じ |
| USR-2 | 共有された情報が未設定の台帳では `AUTH_SHARED_INFO_UNSET`（401）で、`auth_failures` に行ができない |
| ADM-3 | 共有された情報を設定し直すと、前の版で始めた証明で `GET /api/session` が `active: false, reason: AUTH_REVOKED` になり、利用者の API が `AUTH_REVOKED` になる（利用者の API は、利用者の入力の機能ができてから `POST /api/me` で確かめる。この段では `GET /api/session` と、`checkUserSession` のルールの層のテストで確かめる）。応答に `Set-Cookie` が付かない |
| ADM-3 | 設定し直した後、前の値で `POST` すると `AUTH_SHARED_INFO_WRONG`、新しい値なら成功して新しい行ができ、前の行は残る。管理者の証明は止まらない（`GET /api/admin/me` が通る） |
| USR-2 | Cookie がない、形が違う（42文字など）、表にない値は、`GET /api/session` で `active: false, reason: AUTH_REQUIRED`、利用者の API で `AUTH_REQUIRED` |
| USR-2 | 共3 を通った利用者の API の応答には、同じ値の `Set-Cookie` が付く。共3 で断る応答には付かない |
| ADM-1 | 利用者の API は管理者の Cookie だけでは `AUTH_REQUIRED`。管理者の API は利用者の Cookie だけでは `AUTH_REQUIRED` |
| SEC-3 | 値が違う、形の違う `k` は `AUTH_SHARED_INFO_WRONG` で、`entry = 'shared_info'` の行の `failures` が1増える。`INPUT_BODY`（本文が壊れている、`k` がない、文字列でない）・`AUTH_ORIGIN`・`AUTH_SHARED_INFO_UNSET` では増えない |
| SEC-3 | 200回失敗した後は、正しい値でも `LIMIT_ATTEMPTS`（429）で、行が変わらない。本文が壊れていても `LIMIT_ATTEMPTS`（上限が先）。別の IP（IPv6 は別の /64）は止まらない。次の10分の区切りでは通る |
| SEC-3 | 上限に達した相手からでも、有効な証明を持つ端末の `POST` は成功する |
| RSV-23 | 199回失敗した相手から違う値を2つ同時に送ると、1つ目の失敗で上限に達し、2つ目は `LIMIT_ATTEMPTS` になる |
| SEC-4 | `POST /api/session` の処理の途中で例外が起きたとき、`console.error` の出力に送られた値が含まれない。行も増えない |
| LOG-4 | 成功しても `events` に行ができない。`auth_failures`・`user_sessions`・`events` のどの列にも、共有された情報の値・証明の値が入っていない（`user_sessions.token_hash` は証明の値の SHA-256） |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で、利用の開始の成功、有効な証明での `POST`、`active: true` の `GET` を呼ぶと無断不使用になる。失敗と `active: false` では変わらない |

### 8.15 `POST /api/me`（利用者の入力。USR-3〜USR-7, LOG-1）

利用者の入力の画面で決定したときに呼ぶ。利用者を引き、いなければ作り、名前・期生がそれまでと違えば置き換える（screens-and-api.md 4）。名前・期生を置き換えるのはこの API だけ。経路の表（3.3）では、認証の種類は「利用者」、包むかは「包まない」（PBKDF2 がない）。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `role` | 文字列 | できない | `student`（生徒）か `teacher`（教員） |
| `student_id` | 文字列 | できない | 学籍番号。全角・大文字で送っても、そろえて引く（rules.md 6.4） |
| `name` | 文字列 | できない | 名前（USR-5）。前後の空白を除いて保存する |
| `cohort` | 数値 | 生徒はできない。教員は読まない | 期生（USR-6）。型も段 1 で確かめる（rules.md 6.4） |

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻を取る。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id`・`name` が文字列であること。`cohort` の型はここでは見ない）。
4. 段 1：`validateRole` → `validateStudentId` → `validateName` → `validateCohort` の順に確かめる（rules.md 6.2, 6.4）。画面の入力欄の並びと同じにする。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が `(role, そろえた学籍番号)` で `users` の行を引く（なければ `null`）。
   3. `decideUserInput(行, { name, cohort })`（rules.md 6.5）の `action` に従って書く。
      - `create`：`users` に1行足す（`created_at` は 2 の時刻）。記録 `user_created` を書く。
      - `rename`：その行の `name`・`cohort` を上書きする。記録 `user_renamed` を書く。
      - `unchanged`：何も書かない。
6. 成功を返す（`Set-Cookie` で利用者の Cookie の期限を延ばす。8.12）。

決めたことと理由：

- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.1 と同じ。応答に予約の情報を含まず、次の要求で反映されるので RSV-21 に反しない）。名前の誤りで断った要求で、期生だけが置き換わることもない。
- **ほぼ同時の入力（RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ識別の組が2つ届くと、先の要求が `create`、後の要求は先の行を見て `rename` か `unchanged` になる。`users` の `UNIQUE (role, student_id)`（schema.md 2.1）は最後の守り。
- **他の人の名前を書き換えうる。** 学籍番号を打ち間違えると、確かめずに他の利用者の名前・期生を置き換える。要件が承知のうえとしている制約（USR-7）で、置き換える前の確認は作らない（10章）。記録から前の値をたどれる。
- **端末ごとに利用者を覚えない（USR-3）。** 証明の行と利用者を結びつけない。画面は応答を変数に持つだけ。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `id` | 利用者の内部の番号（`users.id`）。v0.1.0 の画面は使わない（screens-and-api.md 5） |
| `role` | 生徒か教員か |
| `student_id` | そろえた後の学籍番号。画面はこの値を以後の操作の識別の組に使う |
| `name` | 現在の名前（前後の空白を除いた値） |
| `cohort` | 現在の期生。教員は `null` |

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` | 1 |
| 6 | `INPUT_STUDENT_ID` | 1 |
| 7 | `INPUT_NAME` | 1 |
| 8 | `INPUT_COHORT` | 1 |

記録（`events`。LOG-1, USR-7）：

| 場合 | `kind` | `detail` |
| --- | --- | --- |
| `create` | `user_created` | `{"name": …, "cohort": …}` |
| `rename` | `user_renamed` | `{"before": {"name": …, "cohort": …}, "after": {"name": …, "cohort": …}}` |

- どちらも `at` は 2 の時刻（切り捨てない。TIM-5）、`actor_kind = 'user'`、`user_id` はその利用者の番号、ほかの番号の列は `NULL`。
- `rename` では、片方だけが変わったときも名前と期生の両方の前後を入れる。1件だけ見れば、その時点の名前・期生がわかるようにするため。
- 学籍番号は `detail` に入れない（`user_id` から `users` を引けばわかる）。
- `unchanged` では書かない。

### 8.16 利用者の操作の API に共通の利用者の引き方（USR-3, USR-4, USR-7）

予約の確保・予約なしの利用・自分の予約・取消・時間帯の変更・利用開始・利用終了の API（`POST /api/me` と予約状況・機器の一覧を除く利用者の API）は、すべて次のように利用者を引く。

要求の本文に、識別の組を必ず入れる。

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `role` | 文字列 | できない | `POST /api/me` と同じ |
| `student_id` | 文字列 | できない | 画面は `POST /api/me` の応答の値を送る。全角・大文字のままでも、そろえて引く |

1. 共4 で、`role`・`student_id` が文字列であることを確かめる。
2. 段 1 の最初に `validateRole` → `validateStudentId`（rules.md 6.4）を確かめる。その API のほかの項目（時刻など）は、その後に確かめる。
3. store が `(role, そろえた学籍番号)` で `users` の行を引き（なければ `null`）、操作ごとの関数に渡す。操作ごとの関数は段 2 の最初で、`null` なら `NOT_FOUND_USER` を返す（rules.md 2）。予約が本人のものかどうかは、その後に確かめる。

- **名前・期生は読まない。** 送られても、知らない項目として無視する（2）。入力や変更を伴わない操作では置き換えない（USR-7、screens-and-api.md 4）。
- **記録の `user_id` は、ここで引いた利用者の番号にする。** 予約の出来事では、予約の `user_id` と同じになる（本人の予約しか操作できないため。schema.md 2.9）。
- 操作ごとの関数での確かめ方は、それぞれの機能の設計で rules.md 6 に書く。

### 8.17 台帳の層のテストの観点（利用者の入力）

| ID | 確かめること |
| --- | --- |
| USR-3 | 生徒で呼ぶと `users` に1行でき、応答の `data` が `id`・`role`・そろえた `student_id`・前後の空白を除いた `name`・`cohort` になる。教員では `cohort` が `null` |
| USR-4 | `１２３４５６７８` で作った後に `12345678` で呼ぶと、同じ行を引く（行が増えない）。教員の `Tanaka.T` と `tanaka.t` も同じ |
| USR-4 | `00000001` は受け付け、`0000001`（7桁）は `INPUT_STUDENT_ID`。生徒と教員で同じ `12345678` を入れると別の行になる。生徒で英字を含む値は `INPUT_STUDENT_ID` |
| USR-5 | 名前が空白だけ、31文字、改行入りなら `INPUT_NAME` で、表が変わらない |
| USR-6 | 生徒で `cohort` がない、0、1.5、`"1"` なら `INPUT_COHORT`。教員で `cohort` に 5 や `"abc"` を送っても受け付け、`NULL` で保存される |
| USR-7 | 同じ値で2回呼ぶと、行も `events` も増えない。名前だけ・期生だけを変えると行が上書きされ、`user_renamed` が1行でき、`detail` の `before`・`after` が前後の値になる。作ったときは `user_created` が1行 |
| USR-7 | 段 1 で断った要求（名前は正しく期生が誤りなど）では、名前も置き換わらない |
| LOG-1 | 記録の `actor_kind` は `user`、`user_id` は対象の利用者、`at` は秒を切り捨てていない時刻。`detail` に学籍番号が入っていない |
| ADM-3 | 共有された情報を設定し直すと、前の版で始めた証明で `POST /api/me` が `AUTH_REVOKED` になる（8.14 から回したもの）。`Set-Cookie` が付かず、表が変わらない |
| USR-2 | Cookie がないと `AUTH_REQUIRED`。本文が壊れていて Cookie もないと `AUTH_REQUIRED`（認証が先）。`Origin` がないと `AUTH_ORIGIN` |
| USR-2 | 段 1 で断る応答（`INPUT_*`）にも、受け取った値と同じ `Set-Cookie` が付く |
| RSV-23 | 同じ識別の組を違う名前で2つ同時に送ると、行は1つで、`user_created` と `user_renamed` が1行ずつでき、残る名前は後に処理された要求の値 |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で、成功（`unchanged` を含む）すると無断不使用になる。段 1 で断ったときは変わらない |

`NOT_FOUND_USER`（8.16）は、それを返す最初の API（予約の確保）のテストで確かめる（8.26）。

### 8.18 `GET /api/admin/devices`（機器の一覧。MNG-1）

管理者の画面で、機器の管理と予約の管理（MNG-3）の選択肢に使う。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

処理：準備（8.5 の 1）→ `clock()` → 共3（8.5 の 2）→ `transactionSync` の中で自動の変化を反映し、store が削除していない機器を番号の順に引く → 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `devices` | 削除していない機器の配列。番号の順（作った順。機器の順番は10章で除かれている）。1つは `{ id, name }` |

- 削除した機器は出さない。削除した機器の名前は記録（`events`）と `devices` の行に残る（LOG-2）。
- 機器が1つもなければ空の配列。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_REQUIRED` → `AUTH_REVOKED`。`GET` なので `Origin` と本文は確かめない。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.19 `POST /api/admin/devices`（機器の追加。MNG-1, LOG-4）

経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `name` | 文字列 | できない | 機器の名前。前後の空白を除いて保存する（rules.md 6.6） |

処理：

1. 準備：本文を読む。管理者の Cookie の値のハッシュを求める（8.5 の 1）。
2. `clock()` で現在時刻を取る。
3. 共2（`Origin`）→ 共3（8.5 の 2）→ 共4（本文が JSON のオブジェクトで、`name` が文字列であること）。
4. 段 1：`validateDeviceName`（rules.md 6.6）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が、削除していない機器から、前後の空白を除いた名前と完全に一致する行を引く（なければ `null`）。
   3. `checkDeviceCreate(行)`（rules.md 6.7）。断られたら、そのコードを返す（反映した自動の変化は残る）。
   4. `devices` に1行足し（`created_at` は 2 の時刻、`deleted_at` は `NULL`）、記録を書く。
6. 成功を返す（`Set-Cookie` で期限を延ばす）。

- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.15 と同じ）。
- **段 2・段 8 で断るときも、反映した自動の変化は残す。** 反映は操作と関係なく正しい変化で、取り消す理由がない。断るのは戻り値で行い、例外を投げないので `transactionSync` は取り消されない（rules.md 1.1）。8.20・8.21 も同じ。
- **ほぼ同時の追加（RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、同じ名前を2つ同時に送ると、後の要求は先の行を見て `RULE_DEVICE_NAME_DUPLICATE` になる。`devices_name_current`（schema.md 2.2）は最後の守りで、判定とコードは rules が持つ。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `id` | 機器の番号（`devices.id`） |
| `name` | 前後の空白を除いた名前 |

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_DEVICE_NAME` | 1 |
| 6 | `RULE_DEVICE_NAME_DUPLICATE` | 8 |

記録（`events`。LOG-4）：`at` は 2 の時刻、`actor_kind = 'admin'`、`actor_admin_id` は操作した管理者の番号、`kind = 'device_created'`、`device_id` は足した機器の番号、ほかの番号の列は `NULL`、`detail` は `{"name": …}`。

### 8.20 `POST /api/admin/devices/{id}/rename`（機器の名前の変更。MNG-1, LOG-4）

経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求の本文：8.19 と同じ（`name`）。

処理は 8.19 と同じ流れで、5 が次のようになる。

1. 自動の変化を反映する。
2. store が `{id}` の機器の行を削除した行も含めて引き（なければ `null`）、あわせて 8.19 の 5.2 と同じく同じ名前の行を引く。
3. `checkDeviceRename(機器, 同じ名前の行)`（rules.md 6.7）。断られたら、そのコードを返す。
4. `action` が `rename` なら、その行の `name` を上書きし、記録を書く。`unchanged` なら何も書かない。

- **名前は行を上書きし、前の名前は記録に残す。** 予約や記録には機器の現在の名前を出す（MNG-1）ので、予約の側に名前を写さない。表示する API は `devices.name` を引く。
- **削除した機器の名前は変えられない。** `NOT_FOUND_DEVICE` で断る。削除した機器の名前は、削除の時点の名前のまま残る（MNG-1）。

応答の `data`：8.19 と同じ（`id`・`name`）。`unchanged` でも同じ形で返す。

返しうるコード（確かめる順）：`NOT_FOUND_API`（`{id}` が正の整数の形でないときも）→ `AUTH_ORIGIN` → `AUTH_REQUIRED`・`AUTH_REVOKED` → `INPUT_BODY` → `INPUT_DEVICE_NAME`（段 1）→ `NOT_FOUND_DEVICE`（段 2。ない、または削除済み）→ `RULE_DEVICE_NAME_DUPLICATE`（段 8）。

記録：`rename` のときだけ、8.19 と同じ形で `kind = 'device_renamed'`、`device_id` は対象の機器、`detail` は `{"before": {"name": …}, "after": {"name": …}}`（8.15 の `user_renamed` と形をそろえる）。

### 8.21 `POST /api/admin/devices/{id}/delete`（機器の削除。MNG-1, MNG-2, LOG-2, LOG-3, LOG-4）

経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求の本文：項目なし。画面は `{}` を送る（8.7 と同じ）。

処理：

1. 準備：本文を読む。管理者の Cookie の値のハッシュを求める。
2. `clock()` で現在時刻を取る。
3. 共2 → 共3 → 共4。段 1 に当たるものはない。
4. `transactionSync` の中で：
   1. 自動の変化を反映する。
   2. store が `{id}` の機器の行を削除した行も含めて引き（なければ `null`）、その機器の予約済・利用中の予約を全件引く（`reservations_device_status`。schema.md 3）。
   3. `checkDeviceDelete(機器, 予約の一覧)`（rules.md 6.7）。断られたら、そのコードを返す。
   4. 機器の `deleted_at` に 2 の時刻を書き、記録 `device_deleted` を書く。
   5. `cancel` の予約を番号の順に1件ずつ、`status = 'admin_cancelled'`・`cause = 'device_deleted'` にし、1件ごとに記録 `reservation_status` を書く。
5. 成功を返す。

- **利用中があれば何も変えない（MNG-2）。** 4.3 で断るので、予約済の予約も取り消されない。
- **判定と書き込みを分けない（RSV-23）。** 4 の中に `await` がないので、削除と同時に送られた確保・予約なしの利用・利用開始は、削除の前か後のどちらかに処理される。前なら削除の判定に入り（利用中なら断る、予約済なら取り消す）、後なら機器が削除済みとして断られる（予約の操作の設計で `NOT_FOUND_DEVICE` を返す）。
- **自動の変化が先（RSV-22）。** 終了時刻が `nowMin` 以下の利用中は 4.1 で終了になるので、削除を妨げない。猶予を過ぎた予約済は無断不使用になり、管理者による取消にはならない。
- **時刻は秒を切り捨てない（TIM-5）。** `deleted_at` と記録の `at` は 2 の時刻のまま。取消は時間帯の境界を決めないので、予約の `start_at`・`end_at` は変えない。
- **取り消した件数は返さない。** 影響範囲の事前表示は10章で除かれており、後から示すことも要件にない。取り消したことは記録に残る。
- **行は消さない（LOG-2）。** 機器・予約とも状態の列を書き換えるだけ。

応答の `data`：8.19 と同じ（`id`・`name`。`name` は削除の時点の名前）。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_ORIGIN` → `AUTH_REQUIRED`・`AUTH_REVOKED` → `INPUT_BODY` → `NOT_FOUND_DEVICE`（段 2。ない、またはすでに削除済み）→ `RULE_DEVICE_IN_USE`（段 8）。

記録（`events`。LOG-2〜LOG-4）：どれも `at` は 2 の時刻、`actor_kind = 'admin'`、`actor_admin_id` は操作した管理者の番号。原因が先に読めるよう、機器の削除を先に書き、取消をその後に番号の順に書く。

| 何 | `kind` | 番号の列 | `detail` |
| --- | --- | --- | --- |
| 機器の削除 | `device_deleted` | `device_id` | `{"name": 削除の時点の名前}` |
| 予約済の取消（1件ごと） | `reservation_status` | `reservation_id`・`device_id`・`user_id`（その予約の値） | `{"from": "reserved", "to": "admin_cancelled", "cause": "device_deleted"}` |

### 8.22 `GET /api/devices`（利用者の機器の一覧。VIW-1）

利用者の画面で、予約状況・確保・予約なしの利用の機器の選択肢に使う。経路の表では、認証の種類は「利用者」、包むかは「包まない」。識別の組は受け取らない（見るだけで、利用者として操作しない。screens-and-api.md 5 の予約状況と同じ考え方）。

処理：準備（8.12 の 1）→ `clock()` で現在時刻を取り、`nowMin = floorMinute(now)` → 共3（8.12 の 2）→ `transactionSync` の中で自動の変化を反映し、store が削除していない機器を番号の順に引く → 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `devices` | 8.18 と同じ形（1つは `{ id, name }`）。管理者の一覧と同じ中身で、学籍番号などの利用者の情報は含まない |
| `now` | 台帳の現在時刻（`formatDateTime(nowMin)`。8.24 と同じ） |

- **`now` を返す（2026-11-19 に screens.md 3 の設計で足した）。** 予約状況（8.24）は `date` を送らないと呼べないが、`now` はその応答で初めて得られる。画面は予約状況を出す前に必ずこの一覧を呼ぶので、ここで今日の日を決め、端末の時計を読まずに済む（TIM-1、screens.md 2.8）。管理者の一覧（8.18）には足さない（管理者の画面は日を使わない）。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_REQUIRED` → `AUTH_REVOKED`。

記録：読むだけなので書かない。

予約状況（`GET /api/devices/{id}/day`）は予約の操作の機能で決めた（8.24）。予約の状態・日本時間の日の範囲・利用者の名前を扱い、予約がないうちは手で確かめられないため。機器ごとの予約の管理者向けの一覧（`GET /api/admin/devices/{id}/reservations`）は、予約の管理（MNG-3）の機能で決めた（8.37）。

### 8.23 台帳の層のテストの観点（機器）

| ID | 確かめること |
| --- | --- |
| MNG-1 | 追加すると `devices` に1行でき（名前は前後の空白を除いた値、`deleted_at` は `NULL`）、応答の `data` がその値になる。`GET /api/admin/devices`・`GET /api/devices` に番号の順で出る |
| TIM-1 | `GET /api/devices` の `now` が、差し替えた時計の時刻の秒を切り捨てた日本時間の `YYYY-MM-DDTHH:mm`（例：UTC 15:00:59 → 翌日の `00:00`） |
| MNG-1 | 同じ名前（前後の空白だけ違うものを含む）の追加は `RULE_DEVICE_NAME_DUPLICATE`（409）で、行が増えない。大文字と小文字、全角と半角だけが違う名前は追加できる |
| MNG-1 | 削除した機器と同じ名前は追加できる。名前の変更でも、削除した機器の名前に変えられる |
| MNG-1 | 名前を変えると行が上書きされ、`device_renamed` の `before`・`after` が前後の名前。ほかの機器の名前への変更は `RULE_DEVICE_NAME_DUPLICATE`。今と同じ名前への変更は成功し、`events` が増えない |
| MNG-1 | 名前が空白だけ、31文字、改行入りなら `INPUT_DEVICE_NAME`（400）で、表が変わらない |
| MNG-1 | ない番号、削除した機器の名前の変更・削除は `NOT_FOUND_DEVICE`（404） |
| MNG-1 | 削除した機器は2つの一覧に出ない。`devices` の行は残り、`name` は削除の時点の名前 |
| MNG-2 | 予約済の予約が2件ある機器を削除すると、2件とも `admin_cancelled`・`cause = 'device_deleted'` になり、`start_at`・`end_at` は変わらない。ほかの機器の予約は変わらない。終了・取消などの予約は変わらない |
| MNG-2 | 利用中の予約がある機器の削除は `RULE_DEVICE_IN_USE`（409）で、機器も予約済の予約も変わらず、`events` が増えない（反映した自動の変化の記録を除く） |
| MNG-2 | 終了時刻がちょうど `nowMin` の利用中の予約は、削除の前に終了になり（記録は自動・終了時刻）、削除できる（RSV-22） |
| MNG-2 | 開始時刻＋猶予を過ぎた予約済の予約は、削除の前に無断不使用になり、管理者による取消にならない |
| LOG-3 | 削除の記録は `device_deleted` が1行、取消ごとに `reservation_status`（`from`・`to`・`cause`）が1行で、`device_deleted` の `id` が最も小さい。取消の行に予約・機器・利用者の番号が入っている |
| LOG-4 | 追加・名前の変更・削除の記録に `actor_kind = 'admin'` と `actor_admin_id` が入り、`at` は秒を切り捨てていない時刻 |
| RSV-23 | 同じ名前の追加を2つ同時に送ると、1つは成功し、もう1つは `RULE_DEVICE_NAME_DUPLICATE`。行は1つ |
| ADM-1 | `GET /api/devices` は管理者の Cookie だけでは `AUTH_REQUIRED`。機器の管理者の API は利用者の Cookie だけでは `AUTH_REQUIRED` |
| API | 追加・名前の変更・削除で `Origin` がないと `AUTH_ORIGIN`。証明が有効で本文が壊れていると `INPUT_BODY`。本文に `name` がない、文字列でないときも `INPUT_BODY`。2つの一覧（`GET`）は `Origin` を確かめない |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で、2つの一覧、追加の成功、`RULE_DEVICE_NAME_DUPLICATE` で断った追加を呼ぶと無断不使用になる。`INPUT_DEVICE_NAME` で断ったときは変わらない |

テストの予約の行は、予約の操作の API ができるまでは、テストが `runInDurableObject` で表に直接入れる。

### 8.24 `GET /api/devices/{id}/day?date=YYYY-MM-DD`（予約状況。VIW-1〜VIW-3, TIM-1）

利用者の画面の「機器の予約状況」で、機器と日を選んだとき・「最新にする」を押したとき・操作の後に呼ぶ（VIW-3）。経路の表では、認証の種類は「利用者」、包むかは「包まない」。識別の組は受け取らない（8.22 と同じ。screens-and-api.md 5）。

要求：

| もの | 内容 |
| --- | --- |
| パスの `{id}` | 機器の番号。正の整数の形でなければ `NOT_FOUND_API`（2） |
| クエリの `date` | 日本時間の日（`YYYY-MM-DD`。screens-and-api.md 6）。日は個人の情報ではないので URL に入れる。ないときも `INPUT_DATE`。同じ名前が2つあれば最初の値（`URLSearchParams.get`） |

処理：

1. 準備：利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻を取り、`nowMin = floorMinute(now)`。
3. 共3（8.12 の 2）。`GET` なので共2・共4 はない。
4. 段 1：`parseDate(date)`（rules.md 6.8）。日の範囲は `[dayStart, dayStart + DAY_MS)`。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が `{id}` の機器を削除した行も含めて引く（なければ `null`）。`checkDeviceActive`（rules.md 6.9）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   3. store が、その機器の予約を `device_id = ? AND end_at >= dayStart AND start_at < dayEnd` で引き（`reservations_device_end`。schema.md 3）、`users` を結合して `name`・`cohort` を付ける。状態では絞らない。
   4. `daySlots(予約, dayStart, dayEnd)`（rules.md 6.9）で、表示する予約を選んで並べる。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **SQL の条件は `end_at >= dayStart`。** 長さ0の利用を開始時刻を含む日に出す（rules.md 6.9）ため、`>` ではなく `>=` にする。終了がちょうど日の始まりの予約（長さが正）も引かれるが、`daySlots` が落とす。`daySlots` が残すものを落とさない絞り方（rules.md 3）。
- **状態は SQL で絞らない。** VIW-1 の「表示する状態」は判定なので rules に置く（rules.md 3）。その日にかかる予約だけなので、取消などを含めても NFR-3 の規模で小さい（1日20件、10倍でも200件）。先の予約も `end_at >= dayStart` に入るが、その機器の未来の予約だけで、履歴はたどらない。
- **応答の項目は `api/` が選ぶ（VIW-2）。** 下の表の項目だけを入れ、`users.student_id`・`role` は SQL でも引かない。
- **名前・期生は現在の値（USR-7）。** 予約は利用者の番号だけを持ち、表示のたびに `users` から引く（domain-model.md）。
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.15 と同じ）。
- **削除した機器は `NOT_FOUND_DEVICE`。** 8.22 の一覧に出ない機器で、画面は一覧を読み直す（screens.md）。削除の時点の予約は、記録と予約の行に残る（LOG-2）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `date` | 引いた日（`formatDate(dayStart)`。送られた値と同じ） |
| `now` | 台帳の現在時刻（`formatDateTime(nowMin)`）。画面は、日の初期値（今日）・時刻の入力の初期値・過去の時間帯の表示をこれから作り、端末の時計に頼らない（TIM-1、screens-and-api.md 6） |
| `slots` | `daySlots` が返した順の配列。1つは下の表 |

`slots` の1つ：

| 項目 | 内容 |
| --- | --- |
| `start`・`end` | `formatDateTime` の値。日をまたいでも切らない（画面が切って描く）。終了・管理者による終了では、利用した時間帯の終わり（schema.md 2.3） |
| `status` | `reserved`・`in_use`・`finished`・`admin_finished` のどれか（schema.md 2.3 の値）。画面は前の2つを確保済み、後の2つを利用があった時間帯として区別して描く（VIW-1） |
| `user_id` | 利用者の内部の番号。v0.1.0 の画面は使わない（screens-and-api.md 5） |
| `name` | その利用者の現在の名前（VIW-2） |
| `cohort` | その利用者の現在の期生。教員は `null`（VIW-2「生徒は期生も」） |

- 学籍番号・生徒か教員か・予約の番号・予約なしの利用で始めたかは入れない。VIW-2 で学籍番号を除くほかは、要件の表示に要らないため。空きは返さない（rules.md 6.9）。
- 予約がなければ `slots` は空の配列。

返しうるコード（確かめる順）：`NOT_FOUND_API`（`{id}` が正の整数の形でないときも）→ `AUTH_REQUIRED`・`AUTH_REVOKED` → `INPUT_DATE`（段 1）→ `NOT_FOUND_DEVICE`（段 2）。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.25 `POST /api/reservations`（予約の確保。RSV-2〜RSV-6, RSV-23, TIM-6, LOG-3）

利用者の画面の「確保」で決定したときに呼ぶ。経路の表では、認証の種類は「利用者」、包むかは「包まない」。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `role`・`student_id` | 文字列 | できない | 識別の組（8.16） |
| `device_id` | 数値 | できない | 機器の番号。正の整数（`Number.isSafeInteger` で1以上） |
| `start` | 文字列 | できない | 開始時刻（`YYYY-MM-DDTHH:mm`、日本時間） |
| `end` | 文字列 | できない | 終了時刻（同じ形） |

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id`・`start`・`end` が文字列、`device_id` が正の安全な整数であること）。
4. 段 1：`validateRole` → `validateStudentId`（8.16）→ `parseDateTime(start)` → `parseDateTime(end)`（rules.md 6.8）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：識別の組の利用者（8.16）、`device_id` の機器（削除した行も含む）、数値の履歴の全件、その利用者の予約済・利用中の全件（`reservations_user_status`）、その機器の予約済・利用中の全件（`reservations_device_status`）。利用者が `null` なら利用者の予約は空の配列とする（段 2 で断られるので使われない）。機器が `null` のときも同じ。
   3. `checkReserve`（rules.md 6.10）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   4. `reservations` に1行足す：`device_id`、`user_id`、`start_at`・`end_at` は段 1 で直したミリ秒、`status = 'reserved'`、`cause = NULL`、`walk_in = 0`、`created_at = now`。記録を書く。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **`device_id` の形は共4 で確かめる。** パスの `{id}` は形が違えば `NOT_FOUND_API` にする（2）が、本文の項目は型の誤りとして `INPUT_BODY` にする（error-codes.md 3.1）。小数・0・負の数・文字列もここで断るので、store は整数で引くだけでよい。
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.15 と同じ）。
- **ほぼ同時の確保（RSV-3, RSV-4, RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ機器の重なる時間帯を2つ同時に送ると、後の要求は先の行を見て `RULE_OVERLAP` になる。同じ人が件数の上限 − 1 の状態で別の機器を2つ同時に送ると、後の要求は `RULE_COUNT` になる。予約の表には重なりを禁じる制約がない（domain-model.md 4）ので、守りはこの判定だけ。
- **機器の削除と同時の確保（RSV-23）。** 削除の後に処理されれば `NOT_FOUND_DEVICE`、前なら削除で `admin_cancelled` になる（8.21）。
- **自動の変化が先（RSV-22）。** 終了時刻がちょうど `nowMin` の利用中は 5.1 で終了になり、その時刻から始まる確保を妨げない。猶予を過ぎた予約済は無断不使用になり、件数にも重なりにも入らない。
- **時刻は入力どおり。** 確保は境界を台帳が決めない（TIM-4 の対象でない）。`created_at` と記録の `at` は `now`（秒を切り捨てない。TIM-5）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `id` | 予約の番号 |
| `device_id` | 機器の番号 |
| `start`・`end` | `formatDateTime` の値（送られた値と同じ） |
| `status` | `reserved` |

画面は成功したら予約状況を取り直す（VIW-3、screens-and-api.md 2）。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` → `INPUT_STUDENT_ID` → `INPUT_TIME` | 1 |
| 6 | `NOT_FOUND_USER` → `NOT_FOUND_DEVICE` | 2 |
| 7 | `RULE_PAST` | 4 |
| 8 | `RULE_TIME_ORDER` | 5 |
| 9 | `RULE_LENGTH` | 6 |
| 10 | `RULE_COUNT` | 7 |
| 11 | `RULE_OVERLAP` | 8 |

記録（`events`。LOG-1, LOG-3）：`at = now`、`actor_kind = 'user'`、`kind = 'reservation_created'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`actor_admin_id`・`admin_id` は `NULL`、`detail` は `{"start_at": ミリ秒, "end_at": ミリ秒}`（schema.md 2.9）。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.26 台帳の層のテストの観点（予約状況・確保）

| ID | 確かめること |
| --- | --- |
| RSV-2, RSV-5 | 確保すると `reservations` に1行でき（`reserved`、`walk_in = 0`、`start_at`・`end_at` は日本時間の入力をミリ秒に直した値、`created_at` は秒を切り捨てていない時刻）、応答の `data` がその値になる。`reservation_created` が1行でき、`detail` が `start_at`・`end_at` |
| RSV-3 | 同じ機器の [10:00, 11:00) の後に [10:30, 11:30) は `RULE_OVERLAP`（409）で、行が増えない。[11:00, 12:00) は成功（TIM-2）。同じ人でも断る。別の機器なら同じ人の同じ時間帯も成功 |
| RSV-4 | 上限（3件）まで成功し、4件目は `RULE_COUNT`。予約なしの利用で始めた利用中の行（テストが表に入れる）は数えない。1件を取消の状態にすると（テストが書き換える）また確保できる |
| RSV-6 | 1440分は成功、1441分は `RULE_LENGTH`。数値の履歴に `max_length_minutes = 60` の行（`effective_at` が `nowMin`）を入れると61分を断る |
| TIM-6 | 開始がちょうど `nowMin`（時計は 10:00:30、開始 10:00）は成功。開始が1分前、終了がちょうど `nowMin` は `RULE_PAST` |
| TIM-7 | 終了 = 開始は `RULE_TIME_ORDER` |
| TIM-3 | `start` に秒がある、`2026-02-30T10:00` などは `INPUT_TIME`（400）。`start` が数値なら `INPUT_BODY`。`device_id` が `"1"`・1.5・0 なら `INPUT_BODY` |
| USR-4 | 識別の組の利用者がいなければ `NOT_FOUND_USER`（404）（8.17 から回したもの）。全角の学籍番号でも、そろえて同じ利用者を引く |
| MNG-1 | ない機器・削除した機器への確保は `NOT_FOUND_DEVICE`（404） |
| RSV-23 | 同じ機器の重なる時間帯を2つ同時に送ると、1つが成功し、もう1つが `RULE_OVERLAP`。上限 − 1 件の利用者が別の機器を2つ同時に送ると、1つが成功し、もう1つが `RULE_COUNT` |
| RSV-22 | 終了時刻がちょうど `nowMin` の利用中の予約がある機器で、その時刻から始まる確保が成功し、先の予約は終了（記録は自動・終了時刻）。開始時刻＋猶予がちょうど `nowMin` の予約済は無断不使用になり、件数に数えず、その時間帯も確保できる |
| RSV-21 | 段 2 以降で断った確保と予約状況でも、反映した自動の変化が残る。段 1 で断ったときは変わらない |
| VIW-1 | 予約状況に、予約済・利用中・終了・管理者による終了が開始時刻の順で出て、取消・無断不使用・管理者による取消は出ない。終了は利用した時間帯の終わりで出る。日をまたぐ予約は両方の日に出る。長さ0の終了は開始時刻を含む日にだけ出る。0:00 に終わる予約は次の日に出ない |
| VIW-2 | 予約状況の応答の本文（JSON の文字列）に、どの利用者の学籍番号も含まれない。`name`・`cohort` は現在の値（`POST /api/me` で置き換えた後は新しい名前） |
| VIW-1 | `now` が `formatDateTime(nowMin)`。`date` がない、`2026-11-31` なら `INPUT_DATE`（400）。ない機器・削除した機器は `NOT_FOUND_DEVICE` |
| VIW-1 | 予約状況の SQL を `EXPLAIN QUERY PLAN` で見ると `reservations_device_end` を使う（schema.md 3） |
| USR-2 | 予約状況・確保は、Cookie がないと `AUTH_REQUIRED`。管理者の Cookie だけでも `AUTH_REQUIRED`（ADM-1）。確保で `Origin` がないと `AUTH_ORIGIN`。予約状況（`GET`）は `Origin` を確かめない |
| API | 確保で本文が壊れていて Cookie もないと `AUTH_REQUIRED`（認証が先） |

### 8.27 `POST /api/walk-ins`（予約なしの利用。RSV-17, RSV-20, RSV-3, RSV-6, RSV-23, TIM-4, TIM-6, LOG-3）

利用者の画面の「予約なしの利用」で決定したときに呼ぶ。経路の表では、認証の種類は「利用者」、包むかは「包まない」。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `role`・`student_id` | 文字列 | できない | 識別の組（8.16） |
| `device_id` | 数値 | できない | 機器の番号。8.25 と同じ |
| `end` | 文字列 | できない | 終了時刻（`YYYY-MM-DDTHH:mm`、日本時間） |

開始時刻は受け取らない。`start` が送られても、知らない項目として無視する（2）。

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id`・`end` が文字列、`device_id` が正の安全な整数であること）。
4. 段 1：`validateRole` → `validateStudentId`（8.16）→ `parseDateTime(end)`（rules.md 6.8）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：識別の組の利用者（8.16）、`device_id` の機器（削除した行も含む）、数値の履歴の全件、その機器の予約済・利用中の全件（`reservations_device_status`）。利用者の予約は引かない（件数を数えない。RSV-17）。機器が `null` なら機器の予約は空の配列とする（段 2 で断られるので使われない）。
   3. `checkWalkIn`（rules.md 6.11）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   4. `reservations` に1行足す：`device_id`、`user_id`、`start_at` は `checkWalkIn` が返した `start`（= `nowMin`）、`end_at` は段 1 で直したミリ秒、`status = 'in_use'`、`cause = NULL`、`walk_in = 1`、`created_at = now`。記録を書く。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **開始時刻は台帳が決める（RSV-17, TIM-4, RSV-24）。** 画面から開始を受け取ると、RSV-17 の「現在時刻から」を画面の改ざんで破れる。`api/` は `checkWalkIn` が返した値を書き、自分で時刻を決めない（rules.md 1.1）。
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.25 と同じ）。
- **ほぼ同時の予約なしの利用・確保（RSV-3, RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ機器に2人が同時に送ると、後の要求は先の行（現在時刻を含む利用中）を見て `RULE_DEVICE_BUSY` になる。同じ機器への確保と同時なら、後の方が先の行との重なりで断られる。
- **時刻を取る位置（time-and-concurrency.md 2）。** 2 で同期の区間の直前に取るので、遅い時刻の自動の変化が反映された後に早い時刻の予約なしの利用が処理されることはない。
- **自動の変化が先（RSV-22）。** 終了時刻がちょうど `nowMin` の利用中は終了に、猶予の終わりがちょうど `nowMin` の予約済は無断不使用になり、その分から使い始められる。
- **機器の削除と同時（RSV-23）。** 削除の後に処理されれば `NOT_FOUND_DEVICE`。前に処理されれば利用中の予約ができ、削除は `RULE_DEVICE_IN_USE` になる（8.21）。
- **状態の変化の記録は書かない。** 予約なしの利用は最初から利用中で、状態が移らない（domain-model.md 4 の `[*] --> 利用中`）。`walk_in_started` の1行で足りる（確保の `reservation_created` と同じ）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `id` | 予約の番号 |
| `device_id` | 機器の番号 |
| `start`・`end` | `formatDateTime` の値（`start` は `nowMin`、`end` は送られた値と同じ） |
| `status` | `in_use` |

8.25 と同じ形にする。画面は成功したら予約状況を取り直す（VIW-3）。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` → `INPUT_STUDENT_ID` → `INPUT_TIME` | 1 |
| 6 | `NOT_FOUND_USER` → `NOT_FOUND_DEVICE` | 2 |
| 7 | `RULE_PAST` | 4 |
| 8 | `RULE_LENGTH` | 6 |
| 9 | `RULE_DEVICE_BUSY` → `RULE_OVERLAP` | 8 |

`RULE_TIME_ORDER`・`RULE_COUNT` は返さない（rules.md 6.11）。

記録（`events`。LOG-1, LOG-3）：`at = now`、`actor_kind = 'user'`、`kind = 'walk_in_started'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`actor_admin_id`・`admin_id` は `NULL`、`detail` は `{"start_at": ミリ秒, "end_at": ミリ秒}`（schema.md 2.9）。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.28 台帳の層のテストの観点（予約なしの利用）

| ID | 確かめること |
| --- | --- |
| RSV-17 | 時計が 10:00:30 のとき、`reservations` に1行でき（`in_use`、`walk_in = 1`、`start_at` は 10:00、`end_at` は入力をミリ秒に直した値、`created_at` は秒を切り捨てていない時刻）、応答の `data` の `start` が `…T10:00`。`walk_in_started` が1行でき、`detail` が `start_at`・`end_at`。`reservation_status` は書かれない。本文に `start` を入れても無視される |
| RSV-17（件数） | 予約済が上限（3件）ある利用者でも成功する。その後の確保も、予約なしの利用の行を数えずに判定される（8.26 の RSV-4 と合わせて） |
| RSV-20 | 現在時刻を含む利用中・予約済（猶予の間）がある機器は `RULE_DEVICE_BUSY`（409）で、行が増えない。自分の予約でも断る |
| RSV-3 | 10:30 に始まる予約済がある機器で、終了 10:30 は成功、10:31 は `RULE_OVERLAP` |
| RSV-6 | 1440分は成功、1441分は `RULE_LENGTH` |
| TIM-6 | 終了がちょうど `nowMin` は `RULE_PAST`（`RULE_TIME_ORDER` ではない） |
| TIM-3 | `end` に秒がある、ありえない日時は `INPUT_TIME`。`end` がない・数値なら `INPUT_BODY`。`device_id` が `"1"`・1.5・0 なら `INPUT_BODY` |
| USR-4 | 識別の組の利用者がいなければ `NOT_FOUND_USER` |
| MNG-1 | ない機器・削除した機器は `NOT_FOUND_DEVICE` |
| RSV-23 | 同じ機器に2つ同時に送ると、1つが成功し、もう1つが `RULE_DEVICE_BUSY` |
| RSV-22 | 終了時刻がちょうど `nowMin` の利用中がある機器、猶予の終わりがちょうど `nowMin` の予約済がある機器で成功し、先の予約はそれぞれ終了・無断不使用（記録は自動・ルール上の時刻） |
| RSV-21 | 段 2 以降で断っても、反映した自動の変化が残る。段 1 で断ったときは変わらない |
| VIW-1 | 予約なしの利用が予約状況に利用中として出る |
| USR-2 | Cookie がないと `AUTH_REQUIRED`。`Origin` がないと `AUTH_ORIGIN` |

### 8.29 `POST /api/my/reservations`（自分の予約の一覧。RSV-7, MNG-1, TIM-1）

利用者の画面の「自分の予約」を開いたとき・「最新にする」を押したとき・操作の後に呼ぶ（VIW-3）。経路の表では、認証の種類は「利用者」、包むかは「包まない」。識別の組を送るので `POST` にする（screens-and-api.md 4）。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `role`・`student_id` | 文字列 | できない | 識別の組（8.16） |

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id` が文字列であること）。
4. 段 1：`validateRole` → `validateStudentId`（8.16）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：識別の組の利用者（8.16）、その利用者の予約済・利用中の全件（`reservations_user_status`。schema.md 3）に `devices` を結合して機器の `name` を付けたもの。利用者が `null` なら予約は空の配列とする。
   3. `checkMyReservations`（rules.md 6.12）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **`POST` でも `Origin` を確かめる（共2）。** 読むだけの API だが、`GET` 以外は共2 を当てはめるという決まり（4）の例外を作らない。
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.25 と同じ）。
- **自動の変化を反映してから引く（RSV-21）。** 猶予を過ぎた予約済は無断不使用、終了時刻を過ぎた利用中は終了になっていて、一覧に出ない。
- **機器の名前は現在の値（MNG-1）。** 予約は機器の番号だけを持ち、表示のたびに `devices` から引く。予約済・利用中の予約がある機器は削除されていない（rules.md 6.12）。
- **予約なしの利用で始めたものも出す（rules.md 6.12）。**

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `now` | 台帳の現在時刻（`formatDateTime(nowMin)`）。画面は、どの操作を出すか（開始時刻の前か、など）をこれと各予約の時刻から決め、端末の時計に頼らない（TIM-1。8.24 と同じ） |
| `reservations` | `checkMyReservations` が返した順の配列。1つは下の表。なければ空の配列 |

`reservations` の1つ：

| 項目 | 内容 |
| --- | --- |
| `id` | 予約の番号。取消などの API のパスに使う |
| `device_id` | 機器の番号 |
| `device_name` | 機器の現在の名前 |
| `start`・`end` | `formatDateTime` の値 |
| `status` | `reserved`・`in_use` のどちらか |

- 名前・期生・学籍番号・`walk_in` は入れない。本人のもので、要件の表示に要らない（8.24 と同じ考え方）。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_ORIGIN` → `AUTH_REQUIRED`・`AUTH_REVOKED` → `INPUT_BODY` → `INPUT_ROLE` → `INPUT_STUDENT_ID`（段 1）→ `NOT_FOUND_USER`（段 2）。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.30 `POST /api/reservations/{id}/cancel`（取消。RSV-8, RSV-23, LOG-3）

利用者の画面の「自分の予約」で、予約済の予約の「取消」を押したときに呼ぶ。経路の表では、認証の種類は「利用者」、包むかは「包まない」。

要求：

| もの | 内容 |
| --- | --- |
| パスの `{id}` | 予約の番号。正の整数の形でなければ `NOT_FOUND_API`（2） |
| 本文の `role`・`student_id` | 識別の組（8.16）。文字列で、省略できない |

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id` が文字列であること）。
4. 段 1：`validateRole` → `validateStudentId`（8.16）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：識別の組の利用者（8.16）、`{id}` の予約（状態を問わない。なければ `null`）。
   3. `checkCancel`（rules.md 6.12）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   4. 予約の `status` を `cancelled` にする。`cause` は `NULL` のまま、`start_at`・`end_at` は変えない。記録を書く。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **予約は番号だけで引き、本人のものかは rules が確かめる（rules.md 2）。** SQL に `user_id = ?` を入れると、判定が SQL に入る（rules.md 3）。
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.25 と同じ）。
- **自動の変化が先（RSV-22）。** 猶予の終わりがちょうど `nowMin` の予約済は 5.1 で無断不使用になり、取消は `STATE_NOT_RESERVED` になる。猶予の中なら開始時刻を過ぎていても取り消せる。
- **直ちに解放する（RSV-8）。** 状態を `cancelled` にした時点で重なり・件数の対象から外れる（rules.md 6.10 は状態で数える）。同じ時間帯を続けて確保できる。
- **ほぼ同時の操作（RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ予約への取消を2つ同時に送ると、後の要求は `STATE_NOT_RESERVED`。取消と利用開始・機器の削除・管理者による取消が同時なら、先に処理された方の結果の状態を見て、後の方が断られる。
- **時刻は秒を切り捨てない（TIM-5）。** 取消は時間帯の境界を決めないので、記録の `at` は `now` のまま。

応答の `data`：8.25 と同じ形（`id`・`device_id`・`start`・`end`・`status`）。`status` は `cancelled`。画面は成功したら自分の予約と予約状況を取り直す（VIW-3）。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API`（`{id}` が正の整数の形でないときも） | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` → `INPUT_STUDENT_ID` | 1 |
| 6 | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` | 2 |
| 7 | `STATE_NOT_RESERVED` | 3 |

記録（`events`。LOG-1, LOG-3）：`at = now`、`actor_kind = 'user'`、`kind = 'reservation_status'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`actor_admin_id`・`admin_id` は `NULL`、`detail` は `{"from": "reserved", "to": "cancelled"}`（時刻を書き換えないので `start_at`・`end_at` は入れない。schema.md 2.9）。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.31 台帳の層のテストの観点（自分の予約・取消）

| ID | 確かめること |
| --- | --- |
| RSV-7 | 予約済2件（別の機器）と予約なしの利用の利用中1件がある利用者で呼ぶと、3件が開始時刻の順で出る。取消・無断不使用・終了・管理者による取消・管理者による終了の予約、他の利用者の予約は出ない。予約がなければ `reservations` は空の配列 |
| RSV-7 | `now` が `formatDateTime(nowMin)`。1つの項目が `id`・`device_id`・`device_name`・`start`・`end`・`status` だけで、学籍番号・名前を含まない |
| MNG-1 | 機器の名前を変えた後の一覧では、`device_name` が新しい名前 |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済、終了時刻を過ぎた利用中は一覧に出ず、それぞれ無断不使用・終了になっている（記録は自動・ルール上の時刻）。段 1 で断ったときは変わらない |
| RSV-8 | 本人の予約済を取り消すと `status` が `cancelled`（`cause` は `NULL`、`start_at`・`end_at` は変わらない）になり、応答の `status` が `cancelled`。`reservation_status` が1行でき、`detail` が `{"from":"reserved","to":"cancelled"}`、`actor_kind = 'user'`、`at` は秒を切り捨てていない時刻 |
| RSV-8 | 取り消した直後に、同じ人が同じ機器の同じ時間帯を確保できる（解放）。件数の上限に達していた人が、1件取り消すと確保できる |
| RSV-8 | 開始時刻を過ぎて猶予の中の予約済は取り消せる。開始時刻＋猶予がちょうど `nowMin` の予約済は無断不使用になり（記録は自動）、取消は `STATE_NOT_RESERVED`（409） |
| RSV-8 | 2回目の取消、利用中（予約なしの利用で始めたものを含む）の取消は `STATE_NOT_RESERVED` で、表と `events` が変わらない |
| RSV-8 | 他の利用者の予約（予約済でも取消済みでも）、ない番号は `NOT_FOUND_RESERVATION`（404）で、表が変わらない |
| USR-4 | 識別の組の利用者がいなければ、一覧・取消とも `NOT_FOUND_USER` |
| RSV-23 | 同じ予約への取消を2つ同時に送ると、1つが成功し、もう1つが `STATE_NOT_RESERVED`。記録の `reservation_status` は1行 |
| USR-2 | 一覧・取消とも、Cookie がないと `AUTH_REQUIRED`、`Origin` がないと `AUTH_ORIGIN`。管理者の Cookie だけでも `AUTH_REQUIRED`（ADM-1） |
| API | 取消の `{id}` が `0`・`01`・`abc` なら `NOT_FOUND_API`。証明が有効で本文に `role` がないと `INPUT_BODY` |
| RSV-7 | 自分の予約の SQL を `EXPLAIN QUERY PLAN` で見ると `reservations_user_status` を使う（schema.md 3） |

### 8.32 `POST /api/reservations/{id}/change`（時間帯の変更。RSV-9〜RSV-12, RSV-3, RSV-6, RSV-23, TIM-6, LOG-3）

利用者の画面の「自分の予約」で、予約済・利用中の予約の時間帯を変えて決定したときに呼ぶ。経路の表では、認証の種類は「利用者」、包むかは「包まない」。

要求：

| もの | 内容 |
| --- | --- |
| パスの `{id}` | 予約の番号。正の整数の形でなければ `NOT_FOUND_API`（2） |
| 本文の `role`・`student_id` | 識別の組（8.16）。文字列で、省略できない |
| 本文の `start` | 変更後の開始時刻（`YYYY-MM-DDTHH:mm`、日本時間）。文字列で、省略できない。変えないなら今の値（8.29 の `start`）を送る |
| 本文の `end` | 変更後の終了時刻（同じ形）。文字列で、省略できない。変えないなら今の値を送る |

機器は受け取らない（RSV-9）。`device_id` が送られても、知らない項目として無視する（2）。

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id`・`start`・`end` が文字列であること）。
4. 段 1：`validateRole` → `validateStudentId`（8.16）→ `parseDateTime(start)` → `parseDateTime(end)`（rules.md 6.8）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：識別の組の利用者（8.16）、`{id}` の予約（状態を問わない。なければ `null`）、数値の履歴の全件、その予約の `device_id` の機器の予約済・利用中の全件（`reservations_device_status`。その予約自身を含む）。予約が `null` なら機器の予約は空の配列とする（段 2 で断られるので使われない）。
   3. `checkChange`（rules.md 6.13）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   4. `action` が `change` なら、予約の `start_at`・`end_at` を段 1 で直したミリ秒にする。`status`・`cause`・`walk_in`・`device_id` は変えない。記録を書く。`unchanged` なら何も書かない。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **開始・終了の両方を受け取り、今と同じ値の側を「変えない時刻」とする（rules.md「要件の読み方」）。** 比べるのは段 1 で直したミリ秒どうし（rules.md 6.13）なので、文字列の書き方の違いは起きない（`parseDateTime` は1つの形しか受け付けない）。
- **予約は番号だけで引き、本人のものかは rules が確かめる（8.30 と同じ）。**
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.25 と同じ）。
- **両方とも変えないときは成功を返し、何も書かない。** 記録もしない（8.20 の機器の名前の変更の `unchanged` と同じ）。画面が終了の欄を触らずに決定しても、エラーにしない。
- **ほぼ同時の操作（RSV-3, RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ機器で2つの予約を同時に同じ空きへ広げると、後の要求は先に書かれた時間帯を見て `RULE_OVERLAP` になる。変更と確保・予約なしの利用が同時でも、後の方が先の行との重なりで断られる。変更と取消・機器の削除が同時なら、先に処理された方の結果の状態を見て、後の変更は `STATE_NOT_ACTIVE` になる（機器の削除で `admin_cancelled` になった場合も）。
- **自動の変化が先（RSV-22）。** 終了時刻がちょうど `nowMin` の利用中は 5.1 で終了になり、その延長は `STATE_NOT_ACTIVE`。開始時刻＋猶予がちょうど `nowMin` の予約済も無断不使用になり、変えられない。終了時刻がちょうど `nowMin` の他の予約は解放されていて、そこへ広げることを妨げない。
- **猶予は変更後の開始時刻で引かれる（RSV-26）。** 猶予は予約に写していない（domain-model.md）ので、書き換えた `start_at` から次の要求の反映で引かれる。
- **時刻は入力どおり。** 時間帯の変更は境界を台帳が決めない（TIM-4 の対象でない）。記録の `at` は `now`（秒を切り捨てない。TIM-5）。

応答の `data`：8.25 と同じ形（`id`・`device_id`・`start`・`end`・`status`）。`start`・`end` は変更後の値（`unchanged` なら今の値）、`status` は `reserved`・`in_use` のどちらか（変わらない）。画面は成功したら自分の予約と予約状況を取り直す（VIW-3）。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API`（`{id}` が正の整数の形でないときも） | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` → `INPUT_STUDENT_ID` → `INPUT_TIME` | 1 |
| 6 | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` | 2 |
| 7 | `STATE_NOT_ACTIVE` | 3 |
| 8 | `RULE_START_PASSED` → `RULE_PAST` | 4 |
| 9 | `RULE_TIME_ORDER` | 5 |
| 10 | `RULE_LENGTH` | 6 |
| 11 | `RULE_OVERLAP` | 8 |

`RULE_COUNT` は返さない（RSV-12）。

記録（`events`。LOG-1, LOG-3）：`action` が `change` のときだけ、`at = now`、`actor_kind = 'user'`、`kind = 'reservation_time_changed'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`actor_admin_id`・`admin_id` は `NULL`、`detail` は `{"before": {"start_at": ミリ秒, "end_at": ミリ秒}, "after": {"start_at": ミリ秒, "end_at": ミリ秒}}`（片方だけ変えても両方を入れる。8.15 の `user_renamed` と同じ。schema.md 2.9）。状態は変わらないので `reservation_status` は書かない。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.33 台帳の層のテストの観点（時間帯の変更）

時計は例として 10:00:30（`nowMin` = 10:00）。

| ID | 確かめること |
| --- | --- |
| RSV-9 | 本人の予約済 [11:00, 12:00) を [13:00, 14:30) にすると、`start_at`・`end_at` が変わり、`status`・`walk_in`・`device_id` は変わらない。応答の `data` が変更後の値。`reservation_time_changed` が1行でき、`detail` の `before`・`after` が前後の `start_at`・`end_at`、`actor_kind = 'user'`、`at` は秒を切り捨てていない時刻。`reservation_status` は書かれない |
| RSV-9 | 終了だけを変えても `detail` の `before`・`after` に両方の時刻が入る。両方とも今と同じ値を送ると成功し、表と `events` が変わらない。本文に別の `device_id` を入れても機器は変わらない |
| RSV-10 | 利用中（予約なしの利用で始めたものを含む）の終了を延長・短縮できる。開始を変えようとすると `RULE_START_PASSED`（409）で、表が変わらない |
| RSV-11 | 開始時刻を過ぎて猶予の中の予約済は、終了だけ変えられ、開始を変えようとすると `RULE_START_PASSED`。開始がちょうど 10:00 の予約済の開始の変更も `RULE_START_PASSED` |
| TIM-6 | 開始をちょうど `nowMin` にする変更は成功。開始を1分前、終了をちょうど `nowMin` にすると `RULE_PAST` |
| TIM-7 | 開始だけを今の終了と同じ時刻にずらすと `RULE_TIME_ORDER` |
| RSV-12 | 数値の履歴に `max_length_minutes = 60` の行（`effective_at` が `nowMin`）を入れると、120分の予約済の時間帯をずらす・短くするのは成功し、121分にすると `RULE_LENGTH`。30分の予約を61分にすると `RULE_LENGTH`、60分は成功 |
| RSV-12 | 予約済・利用中が上限（3件）ある利用者の変更も成功する。予約なしの利用で始めたものの終了を延ばした後も、確保の件数に数えない（8.26 の RSV-4 と合わせて） |
| RSV-3 | 同じ機器の [12:00, 13:00) の予約がある機器で、[11:00, 12:00) を [11:00, 12:01) にすると `RULE_OVERLAP`、[10:30, 11:30) は成功（自分自身とは重ならない）。既存が同じ人の予約でも断る。別の機器の予約とは重なってもよい |
| RSV-9 | 取消・無断不使用・終了・管理者による取消・管理者による終了の予約の変更は `STATE_NOT_ACTIVE`（409） |
| RSV-9 | 他の利用者の予約（予約済でも取消済みでも）、ない番号は `NOT_FOUND_RESERVATION`（404）で、表が変わらない |
| RSV-23 | 同じ機器の2つの予約を同じ空きへ同時に広げると、1つが成功し、もう1つが `RULE_OVERLAP`。同じ予約への変更と取消を同時に送ると、取消が先なら変更は `STATE_NOT_ACTIVE`、変更が先なら取消が成功する |
| RSV-22 | 終了時刻がちょうど `nowMin` の利用中の延長は、先に終了になって `STATE_NOT_ACTIVE`（記録は自動・終了時刻）。終了時刻がちょうど `nowMin` の他の利用中がある機器で、その時刻から始まるようにずらす変更は成功する |
| RSV-26 | 猶予 15分の予約済の開始を 11:00 から 12:00 にすると、時計を 12:14 にしても予約済のまま、12:15 で無断不使用になる（記録は自動・12:15）。開始を変えた後に猶予の数値を変えると、変更後の開始時刻の時点の値が使われる |
| RSV-16 | 猶予の中の予約済の終了を、開始＋猶予より前に短くすると、その終了時刻に無断不使用になる |
| RSV-21 | 段 2 以降で断っても、反映した自動の変化が残る。段 1 で断ったときは変わらない |
| TIM-3 | `start`・`end` に秒がある、ありえない日時は `INPUT_TIME`。`end` がない・数値なら `INPUT_BODY` |
| USR-4 | 識別の組の利用者がいなければ `NOT_FOUND_USER` |
| USR-2 | Cookie がないと `AUTH_REQUIRED`、`Origin` がないと `AUTH_ORIGIN`。管理者の Cookie だけでも `AUTH_REQUIRED`（ADM-1） |
| API | `{id}` が `0`・`01`・`abc` なら `NOT_FOUND_API` |

### 8.34 `POST /api/reservations/{id}/begin`（利用開始。RSV-14〜RSV-16, RSV-6, RSV-23, TIM-4, LOG-3）

利用者の画面の「自分の予約」で、予約済の予約の「利用開始」を押したときに呼ぶ。経路の表では、認証の種類は「利用者」、包むかは「包まない」。

要求：

| もの | 内容 |
| --- | --- |
| パスの `{id}` | 予約の番号。正の整数の形でなければ `NOT_FOUND_API`（2） |
| 本文の `role`・`student_id` | 識別の組（8.16）。文字列で、省略できない |

開始時刻は受け取らない（RSV-15、TIM-4、RSV-24）。`start` が送られても、知らない項目として無視する（2）。

処理：

1. 準備：本文を読む。利用者の Cookie の値のハッシュを求める（8.12 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.12 の 2）→ 共4（本文が JSON のオブジェクトで、`role`・`student_id` が文字列であること）。
4. 段 1：`validateRole` → `validateStudentId`（8.16）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：識別の組の利用者（8.16）、`{id}` の予約（状態を問わない。なければ `null`）、数値の履歴の全件、その予約の `device_id` の機器の予約済・利用中の全件（`reservations_device_status`。その予約自身を含む）。予約が `null` なら機器の予約は空の配列とする（8.32 と同じ）。
   3. `checkBegin`（rules.md 6.14）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   4. 予約の `status` を `in_use` に、`start_at` を返された `start` にする（前倒しでなければ値は変わらない）。`end_at`・`cause`・`walk_in`・`device_id` は変えない。記録を書く。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.12）。

決めたことと理由：

- **予約は番号だけで引き、本人のものかは rules が確かめる（8.30 と同じ）。**
- **段 1 で断るときは何も書かない。** 自動の変化も反映しない（8.25 と同じ）。
- **開始時刻は rules が返した値を書く（rules.md 1.1）。** `api/` は前倒しかどうかを自分で決めない。
- **自動の変化が先（RSV-22）。** 開始時刻＋猶予（猶予より短い予約は終了時刻。RSV-16）がちょうど `nowMin` の予約済は 5.1 で無断不使用になり、利用開始は `STATE_NOT_RESERVED` になる。`[nowMin, 開始)` にかかる他の予約のうち、終了時刻がちょうど `nowMin` の利用中、無断不使用になる時刻がちょうど `nowMin` の予約済は、先に解放されていて前倒しを妨げない。
- **ほぼ同時の操作（RSV-3, RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。前倒しと、同じ機器の `[nowMin, 開始)` にかかる確保・予約なしの利用・時間帯の変更が同時なら、先に処理された方の行を見て、後の方が断られる（後が前倒しなら `RULE_BEGIN_OVERLAP`、後が確保などなら `RULE_OVERLAP`・`RULE_DEVICE_BUSY`）。同じ予約への利用開始と取消・機器の削除が同時なら、後の方が状態で断られる。同じ予約への利用開始を2つ同時に送ると、後の要求は `STATE_NOT_RESERVED`。
- **時刻。** 前倒しの開始時刻は `nowMin`（秒を切り捨てる。TIM-4）。記録の `at` は `now`（秒を切り捨てない。TIM-5）。

応答の `data`：8.25 と同じ形（`id`・`device_id`・`start`・`end`・`status`）。`start` は書いた後の値（前倒しなら `formatDateTime(nowMin)`）、`status` は `in_use`。画面は成功したら自分の予約と予約状況を取り直す（VIW-3）。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API`（`{id}` が正の整数の形でないときも） | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` → `INPUT_STUDENT_ID` | 1 |
| 6 | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` | 2 |
| 7 | `STATE_NOT_RESERVED` | 3 |
| 8 | `RULE_BEGIN_LENGTH` | 6 |
| 9 | `RULE_BEGIN_OVERLAP` | 8 |

記録（`events`。LOG-1, LOG-3）：`at = now`、`actor_kind = 'user'`、`kind = 'reservation_status'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`actor_admin_id`・`admin_id` は `NULL`。`detail` は次の形：

| 場合 | `detail` |
| --- | --- |
| 前倒し（開始時刻を書き換えた） | `{"from": "reserved", "to": "in_use", "start_at": {"before": ミリ秒, "after": ミリ秒}}` |
| 前倒しでない | `{"from": "reserved", "to": "in_use"}` |

前倒しでも `reservation_time_changed` は書かない（1回の操作を1行にする。schema.md 2.9、logging.md 2）。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.35 `POST /api/reservations/{id}/finish`（利用終了。RSV-18, RSV-19, RSV-23, TIM-4, TIM-7, LOG-3）

利用者の画面の「自分の予約」で、利用中の予約の「利用終了」を押したときに呼ぶ。経路の表では、認証の種類は「利用者」、包むかは「包まない」。

要求：8.34 と同じ（パスの `{id}` と本文の識別の組だけ）。終了時刻は受け取らない（RSV-18、TIM-4）。`end` が送られても無視する（2）。

処理：8.34 と同じ流れで、5 を次のようにする。

1. 自動の変化を反映する（rules.md 5）。
2. store が引く：識別の組の利用者（8.16）、`{id}` の予約（状態を問わない。なければ `null`）。数値の履歴と機器の予約は引かない。
3. `checkFinish`（rules.md 6.15）。断られたら、そのコードを返す（反映した自動の変化は残る）。
4. 予約の `status` を `finished` に、`end_at` を返された `end`（`nowMin`）にする。`cause` は `NULL` のまま、`start_at`・`walk_in`・`device_id` は変えない。記録を書く。

決めたことと理由：

- **終了は本人の操作でも自動でも `finished`（schema.md 2.3、domain-model.md 4.1）。** どちらによるかは記録の `actor_kind` で区別する。
- **自動の変化が先（RSV-19, RSV-22）。** 終了時刻がちょうど `nowMin` の利用中は 5.1 で自動で終了になり（`end_at` は変わらない）、利用終了は `STATE_NOT_IN_USE` になる。
- **直ちに解放する（RSV-19）。** 状態を `finished` にした時点で重なりの対象から外れる。`[nowMin, 元の終了)` は、その場で確保・予約なしの利用ができる。
- **長さ0を認める（TIM-7）。** 予約なしの利用・前倒しの利用開始と同じ分に終えると `start_at = end_at` になる。表に「終了 > 開始」の制約はない（schema.md 2.3）。予約状況では開始時刻を含む日に出る（rules.md 6.9）。
- **ほぼ同時の操作（RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ予約への利用終了を2つ同時に送ると、後の要求は `STATE_NOT_IN_USE`。利用終了と終了時刻の延長が同時なら、先に処理された方の結果を見て、後の延長は `STATE_NOT_ACTIVE`、後の利用終了は延長後の予約を終える。
- **時刻。** 終了時刻は `nowMin`（TIM-4）。記録の `at` は `now`（TIM-5）。

応答の `data`：8.25 と同じ形。`end` は `formatDateTime(nowMin)`、`status` は `finished`。画面は成功したら自分の予約と予約状況を取り直す（VIW-3）。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API`（`{id}` が正の整数の形でないときも） | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_ROLE` → `INPUT_STUDENT_ID` | 1 |
| 6 | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` | 2 |
| 7 | `STATE_NOT_IN_USE` | 3 |

記録（`events`。LOG-1, LOG-3）：`at = now`、`actor_kind = 'user'`、`kind = 'reservation_status'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`actor_admin_id`・`admin_id` は `NULL`、`detail` は `{"from": "in_use", "to": "finished", "end_at": {"before": ミリ秒, "after": ミリ秒}}`（予定していた終了時刻を `before` に残す。schema.md 2.3）。自動の終了（RSV-19）は `end_at` を書き換えないので、その記録の `detail` に `end_at` は入らない。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.36 台帳の層のテストの観点（利用開始・利用終了）

時計は例として 10:00:30（`nowMin` = 10:00）、猶予は初期値（15分）。

| ID | 確かめること |
| --- | --- |
| RSV-14 | 本人の予約済 [10:00, 11:00) を利用開始すると、`status` が `in_use`、`start_at` は 10:00 のまま、応答の `status` が `in_use`。`reservation_status` が1行でき、`detail` が `{"from":"reserved","to":"in_use"}`（`start_at` を含まない）、`actor_kind = 'user'`、`at` は秒を切り捨てていない時刻 |
| RSV-13 | 開始 9:50 の予約済（猶予のうち）は利用開始でき、`start_at` は 9:50 のまま。開始 9:45 の予約済（猶予の終わりがちょうど `nowMin`）は無断不使用になり（記録は自動・9:45＋15分 = 10:00）、利用開始は `STATE_NOT_RESERVED`（409） |
| RSV-16 | [9:55, 10:05) の予約済（猶予より短い）は 10:00 に利用開始できる。利用開始しないまま時計を 10:05 にすると無断不使用になり（記録の `at` は 10:05）、利用開始は `STATE_NOT_RESERVED` |
| RSV-15 | 予約済 [10:30, 11:00) を利用開始すると、`start_at` が 10:00 になり、応答の `start` が `formatDateTime(nowMin)`。記録は `reservation_status` の1行だけで、`detail` が `{"from":"reserved","to":"in_use","start_at":{"before":10:30 のミリ秒,"after":10:00 のミリ秒}}`。`reservation_time_changed` は書かれない |
| RSV-15 | 同じ機器に [10:00, 10:30) の予約済（他の人でも同じ人でも）があると、[10:30, 11:00) の利用開始は `RULE_BEGIN_OVERLAP`（409）で、表と `events` が変わらない。既存が別の機器、または取消済みなら成功する |
| RSV-22 | 同じ機器に、終了時刻がちょうど 10:00 の利用中 [9:00, 10:00) があっても、[10:30, 11:00) の前倒しは成功する（先に自動で終了になる。記録は自動・10:00） |
| RSV-6 | [10:30, 翌 10:00) の予約済の前倒しは成功、[10:30, 翌 10:01) は `RULE_BEGIN_LENGTH`。数値の履歴に `max_length_minutes = 60` の行（`effective_at` が `nowMin`）を入れると、確保済みの [10:00, 12:00) は開始ちょうどに利用開始でき、[10:30, 11:31) の前倒しは `RULE_BEGIN_LENGTH` |
| RSV-5 | 予約で始めた利用中は、確保の件数に数え続ける（`walk_in` が 0 のまま。8.26 の RSV-4 と合わせて） |
| RSV-14 | 利用中（2回目の利用開始）、取消・終了などの予約の利用開始は `STATE_NOT_RESERVED`。他の利用者の予約、ない番号は `NOT_FOUND_RESERVATION`（404） |
| RSV-18 | 本人の利用中 [9:00, 11:00) を利用終了すると、`status` が `finished`（`cause` は `NULL`）、`end_at` が 10:00、応答の `end` が `formatDateTime(nowMin)`・`status` が `finished`。`reservation_status` が1行でき、`detail` が `{"from":"in_use","to":"finished","end_at":{"before":11:00 のミリ秒,"after":10:00 のミリ秒}}`、`actor_kind = 'user'` |
| RSV-19 | 利用終了した直後に、同じ機器の [10:00, 11:00) を別の人が確保・予約なしの利用で使える |
| RSV-19 | 終了時刻がちょうど 10:00 の利用中は自動で終了になり（`end_at` は変わらない、記録は `actor_kind = 'auto'`・`at` は 10:00・`detail` に `end_at` を含まない）、利用終了は `STATE_NOT_IN_USE`（409） |
| TIM-7 | 時計 10:00:10 に予約なしの利用を始め、10:00:50 に利用終了すると `start_at = end_at` = 10:00 で成功する。その日の予約状況に `finished` として出る |
| RSV-17 | 予約なしの利用で始めた利用中も利用終了できる |
| RSV-18 | 予約済・2回目の利用終了は `STATE_NOT_IN_USE`。他の利用者の予約、ない番号は `NOT_FOUND_RESERVATION` |
| RSV-23 | 同じ予約への利用開始を2つ同時に送ると、1つが成功し、もう1つが `STATE_NOT_RESERVED`（記録は1行）。前倒しの利用開始と、同じ機器の [10:00, 10:30) の確保を同時に送ると、どちらか1つだけが成功する。利用終了を2つ同時に送ると、1つが `STATE_NOT_IN_USE` |
| RSV-21 | 段 2 以降で断っても、反映した自動の変化が残る。段 1 で断ったときは変わらない |
| USR-4 | 識別の組の利用者がいなければ、どちらも `NOT_FOUND_USER` |
| USR-2 | どちらも、Cookie がないと `AUTH_REQUIRED`、`Origin` がないと `AUTH_ORIGIN`。管理者の Cookie だけでも `AUTH_REQUIRED`（ADM-1） |
| API | `{id}` が `0`・`01`・`abc` なら `NOT_FOUND_API`。本文に `start`・`end` を入れても無視される（前倒しの開始は `nowMin`、終了は `nowMin`） |

### 8.37 `GET /api/admin/devices/{id}/reservations`（機器ごとの予約の一覧。MNG-3, TIM-1）

管理者の画面の「予約の管理」で、機器を選んだとき・「最新にする」を押したとき・取消や終了の後に呼ぶ（VIW-3 と同じ考え方）。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求：

| もの | 内容 |
| --- | --- |
| パスの `{id}` | 機器の番号。正の整数の形でなければ `NOT_FOUND_API`（2） |

処理：

1. 準備：管理者の Cookie の値のハッシュを求める（8.5 の 1）。
2. `clock()` で現在時刻を取り、`nowMin = floorMinute(now)`。
3. 共3（8.5 の 2）。`GET` なので共2・共4 はない。段 1 に当たるものはない。
4. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が引く：`{id}` の機器（削除した行も含む。なければ `null`）、その機器の予約済・利用中の全件（`reservations_device_status`。schema.md 3）に `users` を結合して `role`・`student_id`・`name` を付けたもの。機器が `null` なら予約は空の配列とする。
   3. `checkDeviceReservations`（rules.md 6.16）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
5. 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

決めたことと理由：

- **学籍番号を返す（MNG-3）。** 管理者の表示では、名前が重なりうるので学籍番号で利用者を見分ける。VIW-2 は一般の利用者への応答の決まりで、管理者の API には当てはまらない。
- **自動の変化を反映してから引く（RSV-21）。** 猶予を過ぎた予約済、終了時刻を過ぎた利用中は一覧に出ない。
- **名前は現在の値（USR-7）。** 表示のたびに `users` から引く。
- **期生・`walk_in`・`now` を入れない（2026-11-19 に開発者が了承）。** MNG-3 が挙げる項目は「生徒か教員か、学籍番号、名前」だけで、利用者は学籍番号で見分けられる。出す操作は `status` だけで決まり（予約済なら取消、利用中なら終了）、時刻によらない。
- **過去の予約は出さない。** MNG-3 は対象を選ぶための一覧で、予約済・利用中だけを求めている。履歴は記録に残る（FUT-4）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `reservations` | `checkDeviceReservations` が返した順の配列。1つは下の表。なければ空の配列 |

`reservations` の1つ：

| 項目 | 内容 |
| --- | --- |
| `id` | 予約の番号。取消・終了の API のパスに使う |
| `start`・`end` | `formatDateTime` の値 |
| `status` | `reserved`・`in_use` のどちらか |
| `role` | 利用者の `student`・`teacher`（MNG-3「生徒か教員かの区別」） |
| `student_id` | 利用者のそろえた学籍番号（schema.md 2.1） |
| `name` | 利用者の現在の名前 |

返しうるコード（確かめる順）：`NOT_FOUND_API`（`{id}` が正の整数の形でないときも）→ `AUTH_REQUIRED`・`AUTH_REVOKED` → `NOT_FOUND_DEVICE`（段 2。ない、または削除済み）。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.38 `POST /api/admin/reservations/{id}/cancel`（管理者による取消。MNG-3, RSV-23, LOG-3, LOG-4）

管理者の画面の「予約の管理」で、予約済の予約の「取消」を押したときに呼ぶ。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求：

| もの | 内容 |
| --- | --- |
| パスの `{id}` | 予約の番号。正の整数の形でなければ `NOT_FOUND_API`（2） |
| 本文 | 項目なし。画面は `{}` を送る（8.21 と同じ） |

処理：

1. 準備：本文を読む。管理者の Cookie の値のハッシュを求める（8.5 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.5 の 2）→ 共4（本文が JSON のオブジェクトであること）。段 1 に当たるものはない。
4. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が `{id}` の予約を引く（状態を問わない。なければ `null`）。
   3. `checkAdminCancel`（rules.md 6.16）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19）。
   4. 予約の `status` を `admin_cancelled`、`cause` を `admin_action` にする。`start_at`・`end_at` は変えない。記録を書く。
5. 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

決めたことと理由：

- **本人の確かめはない（MNG-3）。** 予約は番号だけで引き、どの利用者の予約でも取り消せる。
- **自動の変化が先（RSV-22）。** 猶予の終わりがちょうど `nowMin` の予約済は無断不使用になり、管理者による取消は `STATE_NOT_RESERVED` になる。猶予の中なら開始時刻を過ぎていても取り消せる。
- **直ちに解放する。** 状態を `admin_cancelled` にした時点で重なり・件数の対象から外れる（rules.md 6.10 は状態で数える）。
- **ほぼ同時の操作（RSV-23）。** 3 の後から 4 の終わりまでに `await` がないので、包まなくても割り込まれない。管理者による取消と、同じ予約への本人の取消・利用開始・時間帯の変更・機器の削除・ほかの管理者による取消が同時なら、先に処理された方の結果の状態を見て、後の方が断られる（後が管理者による取消なら `STATE_NOT_RESERVED`）。
- **時刻は秒を切り捨てない（TIM-5）。** 取消は時間帯の境界を決めないので、記録の `at` は `now` のまま。

応答の `data`：8.25 と同じ形（`id`・`device_id`・`start`・`end`・`status`）。`status` は `admin_cancelled`。画面は成功したら一覧を取り直す。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API`（`{id}` が正の整数の形でないときも） | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `NOT_FOUND_RESERVATION` | 2 |
| 6 | `STATE_NOT_RESERVED` | 3 |

記録（`events`。LOG-3, LOG-4）：`at = now`、`actor_kind = 'admin'`、`actor_admin_id` は操作した管理者の番号、`kind = 'reservation_status'`、`reservation_id`・`device_id`・`user_id` はその予約の値、`admin_id` は `NULL`、`detail` は `{"from": "reserved", "to": "admin_cancelled", "cause": "admin_action"}`（時刻を書き換えないので `start_at`・`end_at` は入れない。schema.md 2.9）。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.39 `POST /api/admin/reservations/{id}/finish`（管理者による終了。MNG-3, RSV-23, TIM-4, TIM-7, LOG-3, LOG-4）

管理者の画面の「予約の管理」で、利用中の予約の「終了」を押したときに呼ぶ。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求：8.38 と同じ（パスの `{id}` と本文 `{}`）。終了時刻は受け取らない（MNG-3、TIM-4）。`end` が送られても無視する（2）。

処理：8.38 と同じ流れで、4 を次のようにする。

1. 自動の変化を反映する（rules.md 5）。
2. store が `{id}` の予約を引く（状態を問わない。なければ `null`）。
3. `checkAdminFinish`（rules.md 6.16）。断られたら、そのコードを返す（反映した自動の変化は残る）。
4. 予約の `status` を `admin_finished`、`end_at` を返された `end`（`nowMin`）、`cause` を `admin_action` にする。`start_at`・`walk_in`・`device_id` は変えない。記録を書く。

決めたことと理由：

- **自動の変化が先（RSV-19, RSV-22）。** 終了時刻がちょうど `nowMin` の利用中は自動で終了（`finished`）になり、管理者による終了は `STATE_NOT_IN_USE` になる。結果の状態は `admin_finished` ではなく `finished` のまま。
- **直ちに解放する。** 状態を `admin_finished` にした時点で重なりの対象から外れ、`[nowMin, 元の終了)` は、その場で確保・予約なしの利用ができる。機器が使えなくなったときにその後の利用を止める手段は、機器の削除のほかにない（MNG-4。承知のうえの制約）。
- **長さ0を認める（TIM-7）。** 予約なしの利用・前倒しの利用開始と同じ分に終了させると `start_at = end_at` になる。予約状況では開始時刻を含む日に `admin_finished` として出る（rules.md 6.9）。
- **ほぼ同時の操作（RSV-23）。** 3 の後から 4 の終わりまでに `await` がないので、包まなくても割り込まれない。同じ予約への本人の利用終了・ほかの管理者による終了が同時なら、後の方が `STATE_NOT_IN_USE`。終了時刻の延長と同時なら、先に処理された方の結果を見て、後の延長は `STATE_NOT_ACTIVE`、後の管理者による終了は延長後の予約を終える（8.35 と同じ）。
- **時刻。** 終了時刻は `nowMin`（TIM-4）。記録の `at` は `now`（TIM-5）。

応答の `data`：8.25 と同じ形。`end` は `formatDateTime(nowMin)`、`status` は `admin_finished`。画面は成功したら一覧を取り直す。

返しうるコード（確かめる順）：8.38 と同じで、6 が `STATE_NOT_IN_USE`（段 3）。

記録（`events`。LOG-3, LOG-4）：8.38 と同じ形で、`detail` は `{"from": "in_use", "to": "admin_finished", "cause": "admin_action", "end_at": {"before": ミリ秒, "after": ミリ秒}}`（予定していた終了時刻を `before` に残す。8.35 と形をそろえる。logging.md 2）。断ったときは書かない（反映した自動の変化の記録を除く）。

### 8.40 台帳の層のテストの観点（予約の管理）

時計は例として 10:00:30（`nowMin` = 10:00）、猶予は初期値（15分）。

| ID | 確かめること |
| --- | --- |
| MNG-3 | 機器 A に、生徒の予約済・教員の予約済・予約なしの利用の利用中があり、機器 B にも予約済があるとき、A の一覧は A の3件だけを開始時刻の順に返す。取消・無断不使用・終了・管理者による取消・管理者による終了の予約は出ない。予約がなければ `reservations` は空の配列 |
| MNG-3 | 一覧の1つが `id`・`start`・`end`・`status`・`role`・`student_id`・`name` だけで、`student_id` はそろえた値、`name` は名前を置き換えた後の現在の値 |
| MNG-3 | 削除した機器、ない番号の一覧は `NOT_FOUND_DEVICE`（404） |
| MNG-3 | 予約済を管理者が取り消すと、`status` が `admin_cancelled`・`cause` が `admin_action`、`start_at`・`end_at` は変わらず、応答の `status` が `admin_cancelled`。`reservation_status` が1行でき、`detail` が `{"from":"reserved","to":"admin_cancelled","cause":"admin_action"}` |
| MNG-3 | 取り消した直後に、同じ機器の同じ時間帯を別の人が確保できる。取り消された人の件数（RSV-4）から外れる |
| MNG-3 | 開始時刻を過ぎて猶予の中の予約済は取り消せる。開始時刻＋猶予がちょうど `nowMin` の予約済は無断不使用になり（記録は自動）、取消は `STATE_NOT_RESERVED`（409） |
| MNG-3 | 利用中・2回目の管理者による取消・本人が取り消した予約の取消は `STATE_NOT_RESERVED` で、表と `events` が変わらない。ない番号は `NOT_FOUND_RESERVATION`（404） |
| MNG-3, TIM-4 | 利用中 [9:00, 11:00) を管理者が終了させると、`status` が `admin_finished`・`cause` が `admin_action`・`end_at` が 10:00、応答の `end` が `formatDateTime(nowMin)`。`reservation_status` の `detail` が `{"from":"in_use","to":"admin_finished","cause":"admin_action","end_at":{"before":11:00 のミリ秒,"after":10:00 のミリ秒}}` |
| MNG-3 | 終了させた直後に、同じ機器の [10:00, 11:00) を別の人が確保・予約なしの利用で使える。その日の予約状況に `admin_finished` として出る |
| MNG-3, RSV-22 | 終了時刻がちょうど 10:00 の利用中は自動で終了になり（`status` は `finished`、記録は `actor_kind = 'auto'`）、管理者による終了は `STATE_NOT_IN_USE`（409） |
| TIM-7 | 時計 10:00:10 に予約なしの利用を始め、10:00:50 に管理者が終了させると `start_at = end_at` = 10:00 で成功する |
| MNG-3 | 予約済・2回目の管理者による終了は `STATE_NOT_IN_USE`。ない番号は `NOT_FOUND_RESERVATION` |
| LOG-4 | 取消・終了の記録に `actor_kind = 'admin'` と、操作した管理者の番号の `actor_admin_id` が入り、`at` は秒を切り捨てていない時刻 |
| RSV-23 | 同じ予約への管理者による取消と本人の利用開始を同時に送ると、1つが成功し、もう1つが `STATE_NOT_RESERVED`。管理者による終了と本人の利用終了を同時に送ると、1つが `STATE_NOT_IN_USE`。記録の `reservation_status` はそれぞれ1行 |
| RSV-21 | 一覧・取消・終了とも、段 2 以降で断っても、反映した自動の変化が残る |
| ADM-1 | 3つの API とも、利用者の Cookie だけでは `AUTH_REQUIRED`。管理者の証明を解いた後は `AUTH_REVOKED` |
| API | 取消・終了で `Origin` がないと `AUTH_ORIGIN`、本文が壊れていると `INPUT_BODY`。一覧（`GET`）は `Origin` を確かめない。`{id}` が `0`・`01`・`abc` なら `NOT_FOUND_API`。終了の本文に `end` を入れても無視される |
| MNG-3 | 一覧の SQL を `EXPLAIN QUERY PLAN` で見ると `reservations_device_status` を使う（schema.md 3） |

### 8.41 `GET /api/admin/settings`（数値の現在の値。RSV-25）

管理者の画面の「数値」で、3つの数値の欄の初期値に使う。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

処理：準備（8.5 の 1）→ `clock()` で `now` を取り、`nowMin = floorMinute(now)` → 共3（8.5 の 2）→ `transactionSync` の中で自動の変化を反映し、store が数値の履歴の全件を引き、`currentSettings(履歴, nowMin)`（rules.md 6.17）→ 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `max_count` | 件数の上限（RSV-4）。件 |
| `grace_minutes` | 猶予（RSV-13）。分 |
| `max_length_minutes` | 長さの上限（RSV-6）。分 |

- 名前は `settings.key`（schema.md 2.4）とそろえる。画面と台帳で項目の名前を読み替えない。
- 有効になった時刻・履歴は返さない。要件の画面は「現在の値と変更」だけ（screens-and-api.md 3）。履歴は記録（`setting_changed`）と `settings` の行に残る。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_REQUIRED` → `AUTH_REVOKED`。`GET` なので `Origin` と本文は確かめない。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.42 `POST /api/admin/settings`（数値の変更。RSV-25, RSV-26, RSV-22, LOG-4）

経路の表では、認証の種類は「管理者」、包むかは「包まない」。

要求の本文：

| 項目 | 型 | 省略 | 内容 |
| --- | --- | --- | --- |
| `key` | 文字列 | できない | `max_count`・`grace_minutes`・`max_length_minutes` のどれか（rules.md 6.17 の `SETTING_KEYS`） |
| `value` | 数値 | できない | 新しい値。1以上の整数（rules.md 6.17） |

1回の要求で1つの数値だけを変える。

処理：

1. 準備：本文を読む。管理者の Cookie の値のハッシュを求める（8.5 の 1）。
2. `clock()` で現在時刻 `now` を取り、`nowMin = floorMinute(now)`。
3. 共2（`Origin`）→ 共3（8.5 の 2）→ 共4（本文が JSON のオブジェクトで、`key` が文字列で `SETTING_KEYS` のどれかであること、`value` が数値であること）。
4. 段 1：`validateSettingValue(key, value)`（rules.md 6.17）。断ったら何も書かず、自動の変化も反映しない（8.15 と同じ）。
5. `transactionSync` の中で：
   1. 自動の変化を反映する（rules.md 5）。
   2. store が数値の履歴の全件を引く。
   3. `decideSettingChange({ settings, key, value, nowMin })`（rules.md 6.17）。断らない。
   4. `action` が `change` なら、`settings` に `(key, value, effective_at = nowMin)` の1行を足し、記録を書く。`unchanged` なら何も書かない。
   5. 足した後の履歴で `currentSettings(履歴, nowMin)` を求める。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

決めたことと理由：

- **1回に1つの数値だけを変える。** 3つをまとめて送る形では、ほかの管理者が直前に変えた値を、古い画面に残った前の値で戻してしまう。1つでも誤りがあったときに、残りをどうするかも決めることになる。画面は欄ごとに保存のボタンを置く（screens.md に回す）。
- **`key` の誤りは `INPUT_BODY`。** `key` は画面が固定の値を送るもので、利用者が入力しない。確保の `device_id` の形の誤り（8.25）と同じ扱いにする。
- **変更は `nowMin` から有効（RSV-26）。** 5.1 で自動の変化を反映してから行を足すので、`nowMin` 以下に起きる変化は前の値で確定している（RSV-22。数値の変更も「操作」で、同じ時刻の自動の変化より後）。開始時刻がちょうど `nowMin` の予約には変更後の猶予が使われ、開始を過ぎた予約の猶予は変わらない（rules.md 3.1）。
- **確保済みの予約を変えない（RSV-25）。** 予約の表には触れない。上限を下げても取り消さない（rules.md 6.17）。
- **同じ値への変更は `unchanged` で、成功として返す。** 行も記録も足さない（8.20 と同じ）。
- **ほぼ同時の変更（RSV-23）。** 3 の後から 5 の終わりまでに `await` がないので、割り込まれない。2人の管理者が同じ数値を同時に変えると、両方とも成功し、後に処理されたほうの値が残る。後の記録の `before` には先の値が入るので、記録からたどれる。後の操作を断る仕組み（直前の値を要求に入れさせるなど）は置かない（要件にない。8.9 の共有された情報と同じく、残るリスクとして受け入れる）。数値の変更とほかの操作（確保など）が同時なら、先に処理された方の値でもう一方が判定される。
- **記録の時刻は切り捨てない（TIM-5）。** 記録の `at` は `now`。`effective_at` は `nowMin`（境界の時刻。time-and-concurrency.md 1）。

応答の `data`：8.41 と同じ形（変更後の3つの値）。`unchanged` でも同じ形で返す。画面は応答で欄を更新し、取り直さなくてよい。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_SETTING_VALUE` | 1 |

記録（`events`。LOG-4）：`change` のときだけ、`at = now`、`actor_kind = 'admin'`、`actor_admin_id` は操作した管理者の番号、`kind = 'setting_changed'`、`reservation_id`・`device_id`・`user_id`・`admin_id` は `NULL`、`detail` は `{"key": …, "before": 変更前の値, "after": 変更後の値, "effective_at": nowMin のミリ秒}`（schema.md 2.9）。

### 8.43 台帳の層のテストの観点（数値の変更）

時計は例として 10:00:30（`nowMin` = 10:00）。

| ID | 確かめること |
| --- | --- |
| RSV-25 | 初期データだけなら GET が `{ max_count: 3, grace_minutes: 15, max_length_minutes: 1440 }`。`max_count` を 5 にすると、応答と次の GET が 5 で、`settings` に `effective_at` が 10:00 の行が1行足される |
| RSV-25, LOG-4 | 変更の記録が1行で、`actor_kind = 'admin'`、`actor_admin_id` が操作した管理者、`at` が秒を切り捨てていない時刻、`detail` が `{"key":"max_count","before":3,"after":5,"effective_at":10:00 のミリ秒}`。番号の列はすべて `NULL` |
| RSV-25 | 今と同じ値への変更は成功し、`settings` と `events` が変わらない |
| RSV-25 | 3件を確保している利用者がいるとき `max_count` を 1 にしても、3件とも予約済のまま残る。その利用者の新しい確保は `RULE_COUNT`、1件も持たない利用者は1件確保できて2件目が `RULE_COUNT` |
| RSV-25 | 120分の予約済があるとき `max_length_minutes` を 60 にしても残り、開始時刻ちょうどに利用開始できる。新しい確保は61分で `RULE_LENGTH`、60分は成功 |
| RSV-26 | 猶予 15分のとき、開始 9:58 の予約済があり、10:00 に猶予を 5分にしても、10:03 では予約済のまま、10:12 でも予約済、10:13 で無断不使用（猶予は開始時刻の時点の 15分。記録は自動・10:13） |
| RSV-26 | 10:00 に猶予を 5分にすると、開始 10:00 ちょうどの予約済は 10:05 で無断不使用（記録は自動・10:05）。開始 10:01 の予約済は 10:06 で無断不使用 |
| RSV-22 | 開始 9:45 の予約済（猶予 15分）は、10:00 の数値の変更の前に無断不使用になる（記録は自動・10:00 で、`setting_changed` より番号が小さい） |
| RSV-26 | 同じ分に 15 → 5 → 20 と変えると、`settings` に `effective_at` が 10:00 の行が2つ足され、GET が 20。開始 10:00 の予約済の猶予は 20分。記録は2行で、2行目の `before` が 5 |
| RSV-25 | `value` が 0・−1・1.5・`Number.MAX_SAFE_INTEGER + 1` なら `INPUT_SETTING_VALUE`（400）。`grace_minutes` に `Math.floor(Number.MAX_SAFE_INTEGER / 60000) + 1` も `INPUT_SETTING_VALUE`。どれも `settings`・`events` が変わらず、自動の変化も反映されない |
| API | `key` がない・`"max"` などの知らない名前・数値、`value` がない・`"3"`・`null` なら `INPUT_BODY`。`Origin` がないと `AUTH_ORIGIN`。GET は `Origin` を確かめない |
| ADM-1 | 2つの API とも、利用者の Cookie だけでは `AUTH_REQUIRED`。管理者の証明を解いた後は `AUTH_REVOKED` |
| RSV-23 | 2人の管理者が同じ数値を同時に変えると、両方とも成功し、`settings` に2行、`events` に2行。後の記録の `before` が先の値 |
| RSV-21 | GET でも、反映した自動の変化が残る |

### 8.44 `GET /api/admin/admins`（管理者の一覧。ADM-2）

管理者の画面の「管理者」で、一覧と、削除・パスワードの設定し直しの対象を選ぶのに使う。経路の表では、認証の種類は「管理者」、包むかは「包まない」。

処理：準備（8.5 の 1）→ `clock()` → 共3（8.5 の 2）→ `transactionSync` の中で自動の変化を反映し、store が削除していない管理者を番号の順に引く → 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

応答の `data`：

| 項目 | 内容 |
| --- | --- |
| `admins` | 削除していない管理者の配列。番号の順（作った順）。1つは `{ id, login_id, display_name }` |

- 削除した管理者は出さない。削除した管理者の ID と名前は、記録（`admin_deleted`）と `admins` の行に残る（LOG-2）。8.18 の機器の一覧と同じ扱い。
- 自分の行の印は入れない。画面は `GET /api/admin/me` の `id` と比べて見分ける。
- 作った日時・パスワードの版は返さない。ADM-2 の一覧に要る項目ではない。
- 認証が通っている間は自分が必ずいるので、空の配列になることはない。

返しうるコード（確かめる順）：`NOT_FOUND_API` → `AUTH_REQUIRED` → `AUTH_REVOKED`。`GET` なので `Origin` と本文は確かめない。

記録：読むだけなので書かない。反映した自動の変化は記録する（logging.md 2）。

### 8.45 `POST /api/admin/admins`（管理者の作成。ADM-2, LOG-4）

管理者が、管理者の画面から別の管理者のアカウントを作る。経路の表では、認証の種類は「管理者」、包むかは「包む」（PBKDF2 を使うため。time-and-concurrency.md 4）。

要求の本文：8.1 と同じ（`login_id`・`display_name`・`password`）。

処理（すべて `blockConcurrencyWhile` の中。例外は中で受け止めて 500 にする）：

1. 準備：本文を読む。管理者の Cookie の値のハッシュを求める（8.5 の 1）。新しいソルト（ランダムな16バイト）を作る。
2. `clock()` で現在時刻を取る。
3. 同期で確かめる。共2（`Origin`）→ 共3（8.5 の 2）→ 共4（本文が JSON のオブジェクトで、3つの項目がどれも文字列であること）→ 段 1（`validateLoginId` → `validateName` → `validatePassword`。rules.md 6.2）→ store がそろえた ID で管理者の行を削除した行も含めて引き、`checkAdminCreate`（rules.md 6.1）。
4. すべて通ったときだけ、PBKDF2 を計算する（`await`。8.1 の 4 と同じ）。
5. `transactionSync` の中で、自動の変化を反映し、`admins` に1行足し（8.1 の 5 と同じ値）、記録を書く。
6. 成功を返す（`Set-Cookie` で期限を延ばす。8.5）。

- **8.1 と同じ判定・同じ値で作る。** 違うのは、認証が管理者の証明であること（試行の上限はない）と、記録の `actor_kind` だけ。作った管理者は、作った管理者と同じ権限を持つ（管理者に種類はない。ADM-1）。
- **断るときは何も書かない。** 自動の変化も反映しない。段 8 の判定は PBKDF2 の前に行い（断る要求に計算しないため）、反映は PBKDF2 の後の `transactionSync` で行うので、8.19 と違い、段 8 で断っても反映しない。管理者の行の判定は予約の状態によらず、応答に予約の情報を含まないので、次の要求で反映されれば足りる（RSV-21。8.1 と同じ）。
- **ほぼ同時の操作（RSV-23）。** 3 から 5 まで包んだ中で割り込まれないので、同じ ID の作成が、管理者の画面からと保守用の API からほぼ同時に届いても、後の要求は 3 で `RULE_ADMIN_ID_DUPLICATE` になる。作成した管理者の削除（8.47）が、作成の 3 と 5 の間に割り込むこともない。
- **作成した管理者の証明は作らない。** 作った側の管理者の認証した状態はそのまま。作られた管理者は、自分で ID とパスワードを入れて認証する（8.4）。

応答の `data`：8.1 と同じ（`id`・`login_id`・`display_name`）。パスワードとハッシュは返さない。

返しうるコード（確かめる順）：

| 順 | コード | 段 |
| --- | --- | --- |
| 1 | `NOT_FOUND_API` | 共1 |
| 2 | `AUTH_ORIGIN` | 共2 |
| 3 | `AUTH_REQUIRED`・`AUTH_REVOKED` | 共3 |
| 4 | `INPUT_BODY` | 共4 |
| 5 | `INPUT_LOGIN_ID` | 1 |
| 6 | `INPUT_NAME` | 1 |
| 7 | `INPUT_PASSWORD` | 1 |
| 8 | `RULE_ADMIN_ID_DUPLICATE` | 8 |

記録（`events`。LOG-4）：`at` は 2 の時刻、`actor_kind = 'admin'`、`actor_admin_id` は操作した管理者の番号、`kind = 'admin_created'`、`admin_id` は作った管理者の番号、ほかの番号の列は `NULL`、`detail` は `{"login_id": …, "display_name": …}`（8.1 と同じ形）。パスワード・ハッシュ・ソルトは入れない（SEC-4, LOG-4）。

### 8.46 `POST /api/admin/admins/{id}/reset-password`（パスワードの設定し直し。ADM-2, LOG-4）

管理者が、パスワードを忘れたほかの管理者のパスワードを設定し直す。ID は変わらない。経路の表では、認証の種類は「管理者」、包むかは「包む」。

要求の本文：8.2 と同じ（`password`）。

処理は 8.45 と同じ流れで、次が違う。

- 3 の段 1 は `validatePassword` だけ。その後、store が `{id}` の管理者の行を削除した行も含めて引き、`checkAdminPasswordReset(行, 操作した管理者の番号)` に渡す（rules.md 6.1）。
- 5 は 8.2 の 5 と同じ（ハッシュ・ソルト・反復回数を上書きし、`password_version` を1増やす）。これで対象の管理者の認証した状態は、すべての端末で直ちに止まる（次の要求から `AUTH_REVOKED`。ADM-2、auth.md 3）。

決めたことと理由：

- **自分自身のパスワードは設定し直せない（`RULE_ADMIN_SELF_RESET`）。** ADM-2 は設定し直しを「他の管理者が設定し直せる」とし、「v0.1.0 には、管理者が自分のパスワード…を変更する機能がない」を承知のうえの制約としている。自分を対象に認めると、10章で除かれている「管理者自身のパスワードの変更」が、今のパスワードを確かめない形で入ることになる（2026-11-19 に開発者が決定）。自分のパスワードを戻したいときは、ほかの管理者に頼むか、保守用の API（8.2）を使う。保守用の API にはこの制限はない（操作する管理者がいない）。
- **ほぼ同時の操作（RSV-23）。** 包んだ中で割り込まれないので、対象の管理者の削除（8.47）が、3 の判定と 5 の書き込みの間に入ることはない。削除が先なら 3 で `NOT_FOUND_ADMIN` になる。

応答の `data`：8.1 と同じ（`id`・`login_id`・`display_name`。対象の管理者の値）。

返しうるコード（確かめる順）：`NOT_FOUND_API`（`{id}` が正の整数の形でないときも）→ `AUTH_ORIGIN` → `AUTH_REQUIRED`・`AUTH_REVOKED` → `INPUT_BODY` → `INPUT_PASSWORD`（段 1）→ `NOT_FOUND_ADMIN`（段 2。いない、または削除済み）→ `RULE_ADMIN_SELF_RESET`（段 8）。

記録：8.45 と同じ形で、`kind = 'admin_password_reset'`、`admin_id` は対象の管理者、`detail` は `{"login_id": …, "display_name": …}`（対象の管理者の値）。

### 8.47 `POST /api/admin/admins/{id}/delete`（管理者の削除。ADM-2, LOG-2, LOG-4）

経路の表では、認証の種類は「管理者」、包むかは「包まない」（PBKDF2 を使わない）。

要求の本文：項目なし。画面は `{}` を送る（8.7 と同じ）。

処理：

1. 準備：本文を読む。管理者の Cookie の値のハッシュを求める。
2. `clock()` で現在時刻を取る。
3. 共2 → 共3 → 共4。段 1 に当たるものはない。
4. `transactionSync` の中で：
   1. 自動の変化を反映する。
   2. store が `{id}` の管理者の行を削除した行も含めて引き（なければ `null`）、削除していない管理者を全件引く。
   3. `checkAdminDelete(行, 削除していない管理者の一覧)`（rules.md 6.1）。断られたら、そのコードを返す（反映した自動の変化は残る。8.19 と同じ）。
   4. その行の `deleted_at` に 2 の時刻を書き、記録を書く。
5. 成功を返す。対象が操作した管理者自身なら `Set-Cookie: clearAdminCookie()`、そうでなければ `Set-Cookie: adminCookie(受け取った値)`（期限を延ばす。8.5）。

決めたことと理由：

- **自分自身も削除できる（ADM-2）。** 最後の1人でなければ断らない。削除した管理者は、その端末も含めてすべての端末で次の要求から `AUTH_REVOKED` になる。成功の応答で端末の Cookie を消す（8.7 の `logout` と同じ）。消さなくても止まっているが、使えない Cookie を延ばして渡し直さないため。画面は認証の画面に移る（screens.md に回す）。
- **最後の1人は削除できない（`RULE_ADMIN_LAST`）。** 削除していない管理者が対象1人だけなら断る。管理者が0人になると、保守用の API でしか戻せなくなる（ADM-2）。
- **認証した状態を止める仕組みを別に持たない。** `deleted_at` が入ると `checkAdminSession` が `AUTH_REVOKED` を返す（rules.md 6.3、auth.md 3）。`admin_sessions` の行は書き換えない。
- **ほぼ同時の削除（RSV-23）。** 3 の後から 4 の終わりまでに `await` がないので、残り2人を2人の管理者がほぼ同時に削除しても、後の要求は先の削除を見て `RULE_ADMIN_LAST` になる。2人が互いを、または自分自身を同時に削除しても同じ。後の要求を送った管理者がすでに削除されていれば、共3 で `AUTH_REVOKED` になる。包む操作（8.45・8.46・8.1・8.2）とは、`blockConcurrencyWhile` の間はほかの要求が届かないので、間に入らない。
- **ID は再び使えない。** 行を消さず `deleted_at` を入れるだけなので、`login_id` の `UNIQUE` と `checkAdminCreate` が削除した ID も断る（ADM-2、LOG-2）。
- **時刻は秒を切り捨てない（TIM-5）。** `deleted_at` と記録の `at` は 2 の時刻のまま。
- **削除した管理者の過去の記録は変えない。** `events.actor_admin_id` は削除した管理者の行を指したまま残る（LOG-2）。

応答の `data`：8.1 と同じ（`id`・`login_id`・`display_name`。削除した管理者の値）。

返しうるコード（確かめる順）：`NOT_FOUND_API`（`{id}` が正の整数の形でないときも）→ `AUTH_ORIGIN` → `AUTH_REQUIRED`・`AUTH_REVOKED` → `INPUT_BODY` → `NOT_FOUND_ADMIN`（段 2。いない、またはすでに削除済み）→ `RULE_ADMIN_LAST`（段 8）。

記録（`events`。LOG-2, LOG-4）：8.45 と同じ形で、`kind = 'admin_deleted'`、`admin_id` は削除した管理者、`detail` は `{"login_id": …, "display_name": …}`（削除した管理者の値）。自分自身を削除したときは、`actor_admin_id` と `admin_id` が同じ番号になる。

### 8.48 台帳の層のテストの観点（管理者のアカウント）

| ID | 確かめること |
| --- | --- |
| ADM-2 | 管理者の画面から作成すると `admins` に1行でき（版 1、反復回数 100,000、ID はそろえた値、名前は前後の空白を除いた値）、応答の `data` がその値になる。作った管理者の ID とパスワードで認証できる。作った側の証明はそのまま使える |
| ADM-2 | 一覧に削除していない管理者だけが番号の順に出る。削除した管理者は出ない |
| ADM-2 | 削除した管理者の ID（全角・大文字で送ったものを含む）での作成は `RULE_ADMIN_ID_DUPLICATE`（409）で、行が増えない |
| ADM-2 | ID・名前・パスワードの形式の誤りは、それぞれ `INPUT_LOGIN_ID`・`INPUT_NAME`・`INPUT_PASSWORD`（400）。複数に誤りがあれば ID → 名前 → パスワードの順で最初のもの |
| ADM-2 | ほかの管理者のパスワードを設定し直すと版が1増え、ハッシュとソルトが変わる。新しいパスワードで認証でき、古いパスワードでは `AUTH_ADMIN_FAILED`。対象の管理者の証明はすべて `AUTH_REVOKED` になり、操作した管理者とほかの管理者の証明は止まらない |
| ADM-2 | 自分自身のパスワードの設定し直しは `RULE_ADMIN_SELF_RESET`（409）で、版もハッシュも変わらず、自分の証明も止まらない。保守用の API（8.2）では同じ管理者を設定し直せる |
| ADM-2 | ない番号・削除した管理者への設定し直しと削除は `NOT_FOUND_ADMIN`（404）。`{id}` が `0`・`01`・`abc` なら `NOT_FOUND_API` |
| ADM-2 | ほかの管理者を削除すると `deleted_at` が入り（秒を切り捨てない時刻）、行は残る。削除した管理者の証明はすべて `AUTH_REVOKED`、その ID とパスワードでの認証は `AUTH_ADMIN_FAILED`。応答には期限を延ばす `Set-Cookie` が付く |
| ADM-2 | 自分自身を削除すると成功し、応答に `Max-Age=0` の `Set-Cookie` が付く。同じ値の Cookie と、自分のほかの端末の証明で呼ぶと `AUTH_REVOKED` |
| ADM-2 | 管理者が1人のとき、その管理者の自分自身の削除は `RULE_ADMIN_LAST`（409）で、`deleted_at` が入らず、`events` が増えない（反映した自動の変化の記録を除く）。2人のうち1人を削除した後、残った1人の削除も `RULE_ADMIN_LAST` |
| RSV-23 | 管理者が2人のとき、2人がそれぞれ相手を削除する要求をほぼ同時に送ると、1つは成功し、もう1つは `AUTH_REVOKED`（先に削除された側）。削除していない管理者は必ず1人以上残る。2人が同時に自分自身を削除しても、1つは成功し、もう1つは `RULE_ADMIN_LAST` |
| RSV-23 | 同じ ID の作成を、管理者の画面と保守用の API からほぼ同時に送ると、片方が成功し、もう片方が `RULE_ADMIN_ID_DUPLICATE` |
| LOG-4 | 作成・設定し直し・削除の記録に、`actor_kind = 'admin'`、`actor_admin_id`（操作した管理者）、`admin_id`（対象）が入り、`detail` は `login_id`・`display_name` だけ。自分自身の削除では `actor_admin_id` と `admin_id` が同じ。`events` のどの列にも、パスワード・ハッシュ・ソルトが入っていない |
| ADM-1 | 4つの API とも、利用者の Cookie だけでは `AUTH_REQUIRED` |
| API | 作成・設定し直し・削除で `Origin` がないと `AUTH_ORIGIN`。証明が有効で本文が壊れていると `INPUT_BODY`。本文の項目がない、文字列でないときも `INPUT_BODY`。一覧（`GET`）は `Origin` を確かめない |
| API | PBKDF2 は、作成・設定し直しで断る要求（`INPUT_*`、`NOT_FOUND_ADMIN`、`RULE_ADMIN_ID_DUPLICATE`、`RULE_ADMIN_SELF_RESET`、共1〜共4）では呼ばれない（テストで計算の関数を差し替えて数える） |
| RSV-21 | 開始時刻＋猶予を過ぎた予約済の予約がある台帳で、一覧・作成の成功・削除の成功・`RULE_ADMIN_LAST` で断った削除を呼ぶと無断不使用になる。作成・設定し直しを段 1・段 2・段 8 で断ったときは変わらない |

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
| 共有された情報の設定の応答で、利用者の画面の URL まで返す | 台帳が利用者の画面のパスを知ることになる。auth.md 2 で画面が作ると決めている（8.9） |
| 共有された情報の設定の応答で、版の番号も返す | 画面で使わない（8.9） |
| 共有された情報の設定で、古い `user_sessions` を無効にする（書き換える・消す） | 版で止める方式（auth.md 3）と二重になる。行を消すのは LOG-5 にも反する（8.9） |
| 共有された情報の設定がほぼ同時に起きたら、後の操作を断る（直前の版を要求に入れさせるなど） | 要件にない。押した管理者どうしで掲示を確かめれば済む（8.9） |
| 利用の開始で、有効な証明の確認を試行の上限の後にする | 校内の回線が上限に達したとき、すでに使えている端末まで止まる（SEC-3。8.11） |
| 利用の開始で、古い版の値に別のコードを付ける | 過去の版のハッシュとすべて比べることになり、要件にない（8.11） |
| 利用の開始で、`k` の形の誤りを `INPUT_` で返し、数えない | 管理者の認証（8.4）と扱いがそろわない。形を確かめるだけの試行を数えずに許すことになる（8.11） |
| 利用の開始の本文の項目を `shared_info` にする | URL の `#k=` と名前がそろわない（8.11） |
| `GET /api/session` を、有効でなければ 401 で断る形にする | 画面が毎回エラーとして扱うことになる。基本設計で、この API は断らないとしている（4、8.13） |
| 期生を文字列で受け取り、全角をそろえて整数に直す | `"007"` を受け付けるかなど、読み方を別に決めることになる。画面が数値に直せば足りる（8.15、rules.md 6.4） |
| 教員から期生が送られたら `INPUT_COHORT` で断る | 画面で生徒から教員に切り替えたときに残った値で断られる。教員の意図は `role` で読める（8.15） |
| 学籍番号の前後の空白を台帳で除く | 要件は名前（USR-5）にだけ前後の空白を除くとしている。管理者の ID と扱いをそろえる。画面で除くかは screens.md で決める（rules.md 6.4） |
| 置き換えの記録に、変わった項目だけを入れる | 1件だけでその時点の名前・期生がわからない（8.15） |
| `POST /api/me` で、名前・期生の比べ方を `api/` に書く | 判定が `api/` に入る。`decideUserInput` にする（rules.md 6.5） |
| 予約状況（`GET /api/devices/{id}/day`）を機器の機能に含める | 予約の状態・日の範囲の部品を先に作ることになり、予約がないうちは手で確かめられない（8.22） |
| 管理者の機器の一覧に、削除した機器も出す | 要件にない。削除した機器は記録と行に残る（8.18） |
| 機器の削除の応答で、取り消した予約の件数を返す | 要件にない。影響範囲の事前表示は10章で除かれている（8.21） |
| 機器の追加・名前の変更・削除で、段 2・段 8 で断ったときに反映した自動の変化も取り消す | 反映は操作と関係なく正しい変化で、取り消すと次の要求でまた反映するだけになる（8.19） |
| 機器の削除の記録で、取消を機器の削除より先に書く | 記録を番号の順に読んだときに、原因（機器の削除）より先に結果が出る（8.21） |
| 予約状況の SQL で、表示する状態だけを引く | VIW-1 の判定が SQL に入る（rules.md 3）。その日にかかる予約だけなので、絞らなくても小さい（8.24） |
| 予約状況で、利用者の `role` や予約の番号も返す | 要件の表示に要らない（8.24） |
| 予約なしの利用で、画面から開始時刻も受け取る | RSV-17 の「現在時刻から」を画面の改ざんで破れる（RSV-24。8.27） |
| 確保の本文の `device_id` の形の誤りを `NOT_FOUND_DEVICE` にする | 本文の型の誤りは `INPUT_BODY` という決まり（error-codes.md 3.1）とそろわず、store が整数でない値で引くことになる（8.25） |
| 自分の予約で、利用者がいなければ空の一覧を返す | ほかの利用者の操作の API（8.16）と扱いがそろわない（8.29） |
| 自分の予約の項目に `walk_in` を入れる | 要件の表示に要らない（8.29） |
| 自分の予約に `now` を入れない | 画面がどの操作を出すかを端末の時計で決めることになる（TIM-1。8.29） |
| 取消で、予約を `id = ? AND user_id = ?` で引く | 本人のものかの判定が SQL に入る（rules.md 3。8.30） |
| 時間帯の変更で、変える側の時刻だけを送らせる | 画面が変えた欄を見分ける必要があり、API の入力の形が変わる（rules.md「要件の読み方」。8.32） |
| 時間帯の変更で、両方とも変えないときに断る | 画面が欄を触らずに決定しただけでエラーになる。機器の名前の変更の `unchanged` と扱いがそろわない（8.32） |
| 時間帯の変更の記録に、変えた側の時刻だけを入れる | 1件だけでその時点の時間帯がわからない（8.15 の `user_renamed` と同じ。8.32） |
| 予約の管理の一覧に期生も入れる | MNG-3 が挙げる項目にない。利用者は学籍番号で見分けられる（8.37） |
| 予約の管理の一覧に `now` を入れる | 出す操作は状態だけで決まり、時刻によらない（8.37） |
| 管理者による取消・終了のパスを機器の下に置く（`/api/admin/devices/{id}/reservations/{rid}/cancel`） | 基本設計の経路と変わる。予約の番号だけで対象が決まり、機器の番号が要らない（8.38） |
| 数値の変更で、3つの数値をまとめて送る | 古い画面から送ると、ほかの管理者が直前に変えた値を戻してしまう。1つでも誤りがあったときの扱いが増える（8.42） |
| 数値の変更で、`key` の誤りに専用のコードを付ける | `key` は画面が固定の値を送るもので、利用者が入力しない（8.42） |
| 数値の現在の値の応答に、有効になった時刻や履歴を入れる | 要件の画面は現在の値と変更だけ（8.41） |
| 管理者の画面から、自分自身のパスワードも設定し直せるようにする | 10章で除かれている「管理者自身のパスワードの変更」が、今のパスワードを確かめない形で入る。ADM-2 は「他の管理者が設定し直せる」としている（8.46。2026-11-19 に開発者が決定） |
| 管理者の一覧に、削除した管理者も出す | 要件にない。削除した管理者は記録と行に残る（8.44。機器の一覧 8.18 と同じ） |
| 管理者の一覧に、自分の行の印を入れる | 画面が `GET /api/admin/me` の `id` と比べれば足りる（8.44） |
| 管理者の削除で、その管理者の `admin_sessions` の行に `ended_at` を入れる | `deleted_at` で止まる（auth.md 3）。認証を解いた時刻と削除で止まったことが区別できなくなる（8.47） |
| 自分自身の削除の成功でも、Cookie の期限を延ばす | 使えなくなった Cookie を渡し直すことになる。`logout` と同じく消す（8.47） |
| 管理者の作成・設定し直しの段 8 の判定を、PBKDF2 の後の `transactionSync` の中で自動の変化の反映の後に行う | 断る要求にも PBKDF2 を計算することになる。判定は予約の状態によらない（8.45） |

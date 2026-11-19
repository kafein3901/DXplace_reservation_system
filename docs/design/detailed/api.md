# API

- 状態：作成中（共通の部分を決定。API ごとの入出力は、機能ごとの設計で足す）
- 日付：2026-11-19
- 関係する要件：USR-1, USR-2, ADM-2, ADM-3, RSV-21〜RSV-23, RSV-27, VIW-2, VIW-3, SEC-2〜SEC-4, TIM-1, NFR-4, PRE-5, FUT-1
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
2. `await` が要る準備（architecture.md 3 の手順 1）：本文を読む（壊れていても、ここでは断らずに印を付ける）、Cookie の値の SHA-256、新しく渡す証明の値とそのハッシュ、共有された情報・保守用の鍵のハッシュ（auth.md 3）。
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
- **例外：利用の開始（`POST /api/session`）、管理者の認証（`POST /api/admin/login`）、保守用の API。** 認証の値が本文に入っているので、本文が読めなければ認証を確かめられない。これらは共4 を共3 の前に確かめる。試行の上限（`LIMIT_ATTEMPTS`）は共4 より前に確かめ、上限を超えた相手には本文の誤りも教えない。
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

## 6. 保守用の API の `curl` 手順の形

保守用の API（auth.md 6）は画面を作らず、`curl` で呼ぶ。手順は次の型で書く。API ごとの本文の項目は、管理者のアカウントの機能の設計で決める。

1. Cloudflare の管理画面（または `wrangler secret put MAINT_KEY`）で、32バイト以上のランダムな値を `MAINT_KEY` に設定する。
2. 鍵と本文を、コマンドの履歴に残らない形で用意する。鍵は環境変数に入れ、本文（パスワードを含む）はファイルに書いて `--data @ファイル` で渡す。使い終えたらファイルを消す。
3. `curl` で呼ぶ。鍵は `Authorization: Bearer 鍵` のヘッダで送る。

   ```
   curl -X POST https://（システムの URL）/api/maint/admins \
     -H "Authorization: Bearer $MAINT_KEY" \
     -H "Content-Type: application/json" \
     --data @body.json
   ```

4. 応答の `ok` を確かめる。
5. `MAINT_KEY` を消す（auth.md 6「ふだんは消しておく」）。

- 鍵をヘッダで送るのは、URL に入れると基盤のアクセスの記録に残り、本文に入れると API ごとの本文の形に鍵が混ざるため。`Authorization` は Web の一般的な書き方（PRE-5）。
- 鍵の比べ方（両方の SHA-256 を `timingSafeEqual` で比べる、など）は、管理者のアカウントの機能の設計で決める。
- Windows の PowerShell で同じことをする書き方も、そのときに添える。

## 7. 台帳の層のテストの観点（共通の部分）

| 観点 | 確かめること |
| --- | --- |
| 経路 | ない経路、`{id}` が整数でない経路は `NOT_FOUND_API`（404） |
| `Origin` | `POST` で `Origin` がない、違うときは `AUTH_ORIGIN`。`GET` と保守用の API は確かめない |
| 順 | 本文が壊れていて証明もないときは `AUTH_REQUIRED`（認証が先）。利用の開始・管理者の認証では `INPUT_BODY` が先。上限を超えた相手には `LIMIT_ATTEMPTS` が先 |
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
| screens-and-api.md 5 の一覧のすべて | rules.md 6 の表の各機能と、利用の開始・管理者の認証・利用者の入力・予約状況 | 未 |

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

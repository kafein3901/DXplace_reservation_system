# ルールの判定

- 状態：作成中（枠組みを決定。ルールごとの節は、機能ごとの設計で足す）
- 日付：2026-11-19
- 関係する要件：RSV-1〜RSV-27, TIM-1〜TIM-7, MNG-1〜MNG-3, ADM-2, USR-4〜USR-6, SEC-3, NFR-4
- 前提：[architecture.md](../basic/architecture.md)（手順 1〜7、`rules/` は純粋な関数）、[time-and-concurrency.md](../basic/time-and-concurrency.md)（`nowMin`、自動の変化の反映）、[domain-model.md](../basic/domain-model.md)（状態の移り方、数値の履歴）、[screens-and-api.md](../basic/screens-and-api.md) 7（コードは1つだけ返す）

ここでは、`src/rules/` と `src/lib/`（入力の検証）の関数の形、確かめる順、自動の変化を反映する手順を決める。コードは書かず、関数の名前・引数・戻り値と判定の手順を文章と表で書く。

## 1. 関数の形

### 1.1 戻り値

| 結果 | 形 |
| --- | --- |
| 受け付ける | `{ ok: true, ... }`。ルールで決まる値があれば一緒に返す（下の表） |
| 断る | `{ ok: false, code }`。`code` は理由のコード（error-codes.md） |

- ルールに反しても例外は投げない。例外はバグ（想定していないデータ）のときだけに使う。
- 理由：断る経路が戻り値に見えるので、どこで断ったかをコードから追える（RSV-27）。台帳では例外が `transactionSync` を取り消し、`blockConcurrencyWhile` の中では台帳を作り直すので（time-and-concurrency.md 4）、ふつうの断りを例外にしないほうが安全。

ルールで決まる値：

| 操作 | 返す値 | 要件 |
| --- | --- | --- |
| 予約なしの利用 | 開始時刻 = `nowMin` | RSV-17, TIM-4 |
| 利用開始 | 開始時刻（開始時刻より前なら `nowMin`、そうでなければ変えない） | RSV-15, TIM-4 |
| 利用終了（本人・管理者） | 終了時刻 = `nowMin` | RSV-18, MNG-3, TIM-4 |

`api/` は返された値をそのまま store に渡して書き込む。自分で時刻を決めない。

### 1.2 `lib/` の入力の検証

入力の検証（学籍番号、名前、期生、時刻の形式など）も同じ形にする。正しい入力なら `{ ok: true, value }` を返し、`value` は正規化した値（半角・小文字にした学籍番号、ミリ秒に直した時刻など）とする。断るときは `{ ok: false, code }`（頭は `INPUT_`）。

### 1.3 引数

- 時刻はすべてミリ秒の整数（time-and-concurrency.md 1）。判定に使う現在時刻は `nowMin`（秒を切り捨てたもの）だけを受け取る。`rules/` は `Date.now()` を呼ばない。
- データは store が返した素のオブジェクト（予約、機器、利用者、数値の履歴）で受け取る。予約は少なくとも次を持つ：番号、機器の番号、利用者の番号、開始時刻、終了時刻、状態、予約なしの利用で始めたか。列の名前と状態の値は schema.md で決める。
- 引数は書き換えない。

## 2. 2段の関数

| 段 | 役割 | 例 | テスト |
| --- | --- | --- | --- |
| 要件ごとの関数 | 1つのルールだけを判定する | 重なり（RSV-3）、件数（RSV-4）、長さ（RSV-6, RSV-12）、過去の時刻（TIM-6）、最後の1人の管理者（ADM-2） | 要件の ID ごとに、受け付ける場合と断る場合 |
| 操作ごとの関数 | 要件ごとの関数を下の 4 の順で呼び、最初に断ったコードを返す。受け付けたら 1.1 の値を返す | 確保、予約なしの利用、時間帯の変更、取消、利用開始、利用終了、管理者による取消・終了、機器の追加・名前の変更・削除、管理者の作成・削除 | 確かめる順（複数のルールに反するとき、どのコードを返すか） |

- 対象の存在と、本人の予約かどうかも操作ごとの関数で確かめる。`api/` は store から引いた結果を、見つからなければ `null` のまま渡す。こうして `api/` は判定をしない（architecture.md 4）。
- 本人の予約でないときは、存在しないときと同じコードを返す（screens-and-api.md 7）。

## 3. store と rules の分担

- store は条件を緩めて多めに返し、正確な判定は rules が行う。例：確保なら、store はその機器の予約済・利用中の全件と、その利用者の予約済・利用中の全件を返し、時間帯の重なりや件数の数え方は rules が決める。
- 理由：判定を SQL と JavaScript の2か所に分けない。SQL の条件に判定を入れると、DB なしのテストで確かめられない（NFR-4）。
- 「多め」が NFR-3 の規模で困るほど大きくなる箇所は、機能ごとの設計で絞り方を書く。絞り方は必ず「rules が受け付けるものを落とさない」条件にする。

### 3.1 数値の履歴

`settingAt(履歴, 項目, 時刻)` は、その項目の行のうち「有効になる時刻が 時刻 以下」で最も新しいものの値を返す（domain-model.md 3）。同じ有効になる時刻の行が複数あれば、後に足した行（番号が大きいほう）を使う。

| 数値 | 引く時刻 | 要件 |
| --- | --- | --- |
| 件数の上限 | `nowMin` | RSV-4 |
| 長さの上限 | `nowMin` | RSV-6 |
| 猶予 | その予約の開始時刻 | RSV-26 |

store は数値の履歴を全件渡す（変更のたびに1行なので小さい）。

## 4. 確かめる順

1つの操作が複数のルールに反するときは、次の順で確かめ、最初に反したものだけを返す（screens-and-api.md 7）。

| 順 | 確かめること | コードの頭 | 例 |
| --- | --- | --- | --- |
| 1 | 入力の形式（`lib/`） | `INPUT_` | 学籍番号の形式（USR-4）、時刻の形式・秒（TIM-3） |
| 2 | 対象の存在・本人のものか | `NOT_FOUND_` | 予約、機器、利用者 |
| 3 | 状態 | `STATE_` | 予約済でない（RSV-8）、利用中でない（RSV-18） |
| 4 | 時刻の条件 | `RULE_` | 開始は `nowMin` 以降・終了は `nowMin` より後（TIM-6）、変更前の時刻になる前か（RSV-11） |
| 5 | 終了 > 開始 | `RULE_TIME_ORDER`（error-codes.md） | TIM-7, RSV-5 |
| 6 | 長さ | `RULE_` | RSV-6, RSV-12 |
| 7 | 件数 | `RULE_` | RSV-4 |
| 8 | 重なり | `RULE_` | RSV-3、RSV-15（開始時刻までに他の予約がない）、RSV-20 |

- 考え方：その入力だけで決まるもの、利用者が自分で直せるものを先にする。他の利用者の予約しだいで変わる重なりは最後にする。
- 1 は `api/` が `lib/` を呼んで確かめ、2〜8 は操作ごとの関数が確かめる。手順の位置は architecture.md 3 の 4・5 に当たる。認証（手順 2）と自動の変化の反映（手順 3）は、この順より前に済んでいる。
- 5 は、変更では変えない側の時刻と合わせて比べる。利用終了には当てはめない（TIM-7。長さ0を認める）。
- 重なりは、予約済・利用中の予約だけを対象にし（RSV-1）、`[開始, 終了)` どうしで比べる（TIM-2）。時間帯の変更と利用開始では、その予約自身を除く。
- RSV-20（空いている）は、`[nowMin, 終了)` の重なりの判定に含まれる。別のコードにするかは、予約なしの利用の設計で決める。
- 操作によって当てはまらない段は飛ばす（例：取消には 4〜8 がない）。操作ごとに、どの段で何を確かめるかを下の 6 に書く。

## 5. 自動の変化

### 5.1 `dueTransitions(予約の一覧, 数値の履歴, nowMin)`

`nowMin` までに起きるはずの変化を、起きる時刻の順（同じ時刻なら予約の番号の順）に並べて返す（time-and-concurrency.md 3）。

| 対象 | 起きる時刻 | 移る先 | 要件 |
| --- | --- | --- | --- |
| 予約済 | `min(開始時刻 + settingAt(履歴, 猶予, 開始時刻), 終了時刻)` | 無断不使用 | RSV-13, RSV-16 |
| 利用中 | 終了時刻 | 終了 | RSV-19 |

- 起きる時刻が `nowMin` 以下のものだけを返す（「以下」で同じ時刻の操作より先になる。RSV-22）。
- 返す1件は `{ 予約の番号, 移る先, 起きる時刻 }`。台帳はこの順に1件ずつ状態を変え、起きる時刻で記録する（RSV-21）。
- 予約の状態だけを見て決め、他の予約には左右されない。FUT-5 でメンテナンスが加わったら、ここに変化の種類と同じ時刻での優先順を足す。

### 5.2 store が渡す予約

予約済・利用中のうち、開始時刻が `nowMin` 以下のもの。

- 猶予は1分以上で、予約済の予約は終了 > 開始なので、起きる時刻は開始時刻より後になる。開始時刻が `nowMin` より後の予約は、起きる時刻も `nowMin` より後で、漏れない。
- 利用中の予約は開始時刻が必ず `nowMin` 以下（利用開始は開始時刻を `nowMin` 以前にする）。
- 長い休みの後でも、読むのは開始時刻を過ぎた確保中の予約だけになる。

### 5.3 前提条件

操作ごとの関数は、自動の変化を反映した後のデータを受け取るものとする（architecture.md 手順 3 の後）。

- 例：猶予を過ぎた予約はすでに無断不使用になっているので、利用開始の関数は猶予の終わりと `nowMin` を比べず、状態で断る（`STATE_`）。
- 理由：同じ時刻の比べ方を2か所に書くと、食い違ったときにどちらが正しいかわからない。
- テストでは、操作ごとの関数に渡すデータを、反映した後の形で作る。反映と操作を合わせた動きは、台帳の層のテストで確かめる（testing-and-deploy.md）。

## 6. ルールごとの判定

機能ごとの設計で、操作ごとに次を足す。

- 関数の名前・引数・戻り値
- 4 の各段で確かめること、返すコード
- テストの観点（要件の ID ごとの、受け付ける場合と断る場合。境界の時刻 TIM-2）

| 操作 | 要件 | 状態 |
| --- | --- | --- |
| 確保 | RSV-2〜RSV-6 | 未 |
| 予約なしの利用 | RSV-17, RSV-20 | 未 |
| 時間帯の変更 | RSV-9〜RSV-12 | 未 |
| 取消 | RSV-8 | 未 |
| 利用開始 | RSV-14〜RSV-16 | 未 |
| 利用終了 | RSV-18 | 未 |
| 管理者による取消・終了 | MNG-3 | 未 |
| 機器の追加・名前の変更・削除 | MNG-1, MNG-2 | 未 |
| 管理者の作成・パスワードの設定し直し | ADM-2 | 済（6.1。保守用の API の設計で決めた。管理者の画面からの操作も同じ関数を使う） |
| 管理者の削除 | ADM-2 | 未 |
| 数値の変更 | RSV-25 | 未 |
| 管理者の入力の検証（`lib/`） | ADM-2, USR-5, SEC-3 | 済（6.2） |
| 利用者の入力の検証（`lib/`） | USR-4〜USR-6 | 一部（名前 USR-5 と、全角・大小のそろえ方は 6.2 で決めた。学籍番号・期生は未） |
| 管理者の認証・管理者の証明・試行の上限 | ADM-2, SEC-3 | 済（6.3。試行の上限は利用の開始・保守用の API も同じ関数を使う） |
| 利用の開始・利用者の証明 | USR-2, ADM-3, SEC-3 | 済（6.3 の `checkSharedInfo`・`checkUserSession`・`userCookie`。api.md 8.11〜8.13） |
| 共有された情報の設定・変更 | ADM-3 | 済（判定なし。管理者の証明（6.3 の `checkAdminSession`）を通れば必ず受け付けるので、関数を作らない。値は 6.3 の `newToken`。api.md 8.9） |

### 6.1 管理者の作成・パスワードの設定し直し（`src/rules/admins.js`。ADM-2）

| 関数 | 引数 | 段 | 確かめること | コード |
| --- | --- | --- | --- | --- |
| `checkAdminCreate(sameIdAdmin)` | store が、そろえた後の ID で引いた管理者の行（削除した行も含む）。なければ `null` | 8 | `null` でなければ断る（ADM-2「削除したアカウントの ID は再び使えない」） | `RULE_ADMIN_ID_DUPLICATE` |
| `checkAdminPasswordReset(admin)` | store が番号で引いた管理者の行（削除した行も含む）。なければ `null` | 2 | `null`、または `deleted_at` が `NULL` でなければ断る | `NOT_FOUND_ADMIN` |

- どちらも受け付けるときは `{ ok: true }` だけを返す（1.1 の「ルールで決まる値」はない）。
- 段 1（入力の形式）は `api/` が 6.2 の関数で先に確かめる。作成では段 2〜7 に当たるものがない。設定し直しでは段 3〜8 に当たるものがない。
- 重なりを段 8 に置くのは、ほかの人の行しだいで変わるものを最後にする考え方（4）による。
- `admins.login_id` の `UNIQUE`（schema.md 2.5）は最後の守り。判定とコードはこの関数が持つ（3）。
- 同時に同じ ID で作ったとき（RSV-23）は、処理全体が `blockConcurrencyWhile` の中なので、後の方がこの関数で断られる（api.md 8.1）。

テストの観点（ルールの層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| ADM-2（作成） | 同じ ID の行がない | 同じ ID の行がある。その行が削除済みでも断る |
| ADM-2（設定し直し） | 削除していない管理者 | `null`、削除済みの管理者 |

### 6.2 管理者の入力の検証（`src/lib/`）

1.2 の形（`{ ok: true, value }` か `{ ok: false, code }`）で返す。`value` はそろえた後の値。引数が文字列でないことはここでは扱わない（`api/` が本文の型を確かめ、`INPUT_BODY` にする。error-codes.md 3.1）。

| 関数 | 手順 | `value` | コード |
| --- | --- | --- | --- |
| `toHalfWidthLower(s)` | 全角の英数字と記号（U+FF01〜U+FF5E）を半角（U+0021〜U+007E）に直し、英字の A〜Z を小文字にする。ほかの文字（全角の空白 U+3000 を含む）は変えない | ― | ― |
| `validateLoginId(s)` | `toHalfWidthLower` でそろえ、3〜32文字で、すべて `a-z`・`0-9`・`-`・`_` で、先頭が `a-z` か確かめる。前後の空白は除かない（空白は形式の誤りになる） | そろえた ID | `INPUT_LOGIN_ID` |
| `validateName(s)` | (1) 改行と制御文字（Unicode の Cc、U+2028、U+2029）を1つでも含めば断る。前後の空白を除く前の値で確かめる。(2) 前後の空白（`String.prototype.trim` の対象。全角の空白を含む）を除く。(3) 除いた後の長さがコードポイントで1以上30以下か確かめる | 前後の空白を除いた名前 | `INPUT_NAME` |
| `validatePassword(s)` | 長さが15以上128以下で、すべての文字が U+0021〜U+007E（空白を除く表示できる ASCII）か確かめる。そろえない | 入力どおりの値 | `INPUT_PASSWORD` |
| `clientKey(ip)` | 試行を数える相手（auth.md 7）。IPv4 はそのまま。IPv6 は先頭64ビット（4つの組）を省略せずに書き、`/64` を付ける（例：`2001:0db8:0001:0002::/64`）。値がない、読めないときは `unknown` | 相手の文字列 | ― |

- **`toHalfWidthLower` は、学籍番号の正規化（USR-4）にも使う。** 管理者の ID と学籍番号で、全角・大小のそろえ方を1つにする。
- **`validateName` は、利用者の名前（USR-5）と管理者の表示用の名前（ADM-2「条件は USR-5 と同じ」）の両方に使う。** 文字数をコードポイントで数えるのは、絵文字などのサロゲートペアを2文字と数えないため。結合文字（濁点を分けて書いたものなど）は別の文字として数える。要件の「文字」を厳密に決める手段がなく、30文字の上限に近い名前はまれなので、これで足りるとする。
- **改行と制御文字を前後の空白を除く前に確かめる。** USR-5 は「含むもの」を断るとしているので、末尾の改行も、除いて受け付けるのではなく断る。
- **`clientKey` の値は、失敗の表（schema.md 2.10 の `client`）に入れる。** 手元の `wrangler dev` では `127.0.0.1`、台帳の層のテストではテストが `CF-Connecting-IP` を付ける（api.md 3.4）。

テストの観点（部品の層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| ADM-2（`validateLoginId`） | 3文字・32文字、`ＴＡＮＡＫＡ` → `tanaka`、`Tanaka` → `tanaka`、`a-_1` | 2文字・33文字、先頭が数字・`-`・`_`、`.` や `@` を含む、前後に空白、全角の空白、ひらがな |
| USR-5（`validateName`） | 1文字・30文字（前後の空白を除いて）、前後の空白・全角の空白を除いた値を返す、絵文字1つを1文字と数える | 空、空白だけ、31文字、途中・末尾の改行（`\n`・`\r`）、タブ、U+0000、U+2028 |
| SEC-3（`validatePassword`） | 15文字・128文字、記号を含む | 14文字・129文字、空白を含む、全角の文字、ひらがな |
| SEC-3（`clientKey`） | IPv4 はそのまま。同じ /64 の IPv6 の2つのアドレス（省略した書き方と省略しない書き方）が同じ値になる。違う /64 は違う値。値がなければ `unknown` | ― |

### 6.3 管理者の認証・管理者の証明・利用の開始・利用者の証明・試行の上限（`src/rules/auth.js`。ADM-2, USR-2, ADM-3, SEC-3）

認証の判定も、ほかのルールと同じく純粋な関数にし、`api/` は判定しない（architecture.md 4）。ハッシュの計算とバイト列の比べ方は `lib/` が行い、rules には結果（真偽）だけを渡す。

| 関数 | 引数 | 確かめること | 断るときの戻り値 |
| --- | --- | --- | --- |
| `checkAttemptLimit(row, limit)` | store が `auth_failures` から、入口・`clientKey`・その10分の区切りで引いた行（なければ `null`）と、入口ごとの上限（共有された情報 200、管理者の認証 10、保守用 5。design-values.md） | `null`、または `failures` が `limit` 未満なら受け付ける | `{ ok: false, code: 'LIMIT_ATTEMPTS' }` |
| `checkAdminLogin(admin, passwordMatches)` | store が、そろえた後の ID で引いた管理者の行（削除した行も含む。ID の形式が合わないときや、ないときは `null`）と、PBKDF2 の結果が保存してあるハッシュと等しかったか | (1) `admin` が `null`、または `deleted_at` が `NULL` でなければ断る。(2) `passwordMatches` が偽なら断る | (1) `{ ok: false, code: 'AUTH_ADMIN_FAILED', failure: 'unknown_id' }`、(2) 同じコードで `failure: 'wrong_password'` |
| `checkAdminSession(session, admin)` | store が Cookie の値のハッシュで引いた `admin_sessions` の行（なければ `null`）と、その行の `admin_id` の管理者の行（`session` が `null` なら `null`） | (1) `session` が `null` なら断る。(2) `ended_at` が入っている、`admin.deleted_at` が入っている、`session.password_version` が `admin.password_version` と違う、のどれかなら断る | (1) `{ ok: false, code: 'AUTH_REQUIRED' }`、(2) `{ ok: false, code: 'AUTH_REVOKED' }` |
| `checkSharedInfo(current, matches)` | store が引いた現在の共有された情報の行（`shared_infos` の `id` の最も大きい行。なければ `null`）と、送られた値の SHA-256 がその行の `hash` と等しかったか（値の形が違う、行がないときは偽。api.md 8.11） | (1) `current` が `null` なら断る。(2) `matches` が偽なら断る | (1) `{ ok: false, code: 'AUTH_SHARED_INFO_UNSET' }`、(2) `{ ok: false, code: 'AUTH_SHARED_INFO_WRONG', failure: 'wrong' }` |
| `checkUserSession(session, currentVersion)` | store が Cookie の値のハッシュで引いた `user_sessions` の行（なければ `null`）と、現在の共有された情報の版（`shared_infos` の最も大きい `id`。なければ `null`） | (1) `session` が `null` なら断る。(2) `session.shared_info_id` が `currentVersion` と違えば断る | (1) `{ ok: false, code: 'AUTH_REQUIRED' }`、(2) `{ ok: false, code: 'AUTH_REVOKED' }` |

- 受け付けるときは `{ ok: true }` だけを返す。
- **`checkSharedInfo` の `failure` は、失敗として数えるかの印。** `failure` があるときだけ `api/` が `auth_failures` に数える。未設定は試行にならないので `failure` を付けない（api.md 8.11）。応答には `code` だけを入れる。
- **`checkUserSession` で `session` があるのに `currentVersion` が `null` になることはない**（`user_sessions.shared_info_id` に `REFERENCES` があり、`shared_infos` の行は消さない）。そうなったらバグとして例外を投げる（1.1）。
- `checkUserSession` は、利用者の API の共3（api.md 8.12）、`GET /api/session`（8.13）、`POST /api/session` の有効な証明の確認（8.11）の3か所で使う。
- **`failure` は記録のためだけに返す。** 応答には `code` だけを入れ、`unknown_id` と `wrong_password` を区別しない（auth.md 8）。`api/` は `failure` を見て、`auth_failures` の `unknown_id_failures` か `wrong_password_failures` のどちらを増やすかを決める（判定ではなく、返された値をそのまま書く）。
- **削除した管理者は「ID がない」に数える。** 認証できないアカウントで、パスワードが合っていても受け付けないため。(1) を (2) より先に確かめるので、削除した管理者に正しいパスワードを送っても `unknown_id` になる。
- **`checkAttemptLimit` は3つの入口で同じ関数を使う。** 保守用の API（api.md 6.1 の 2）もこの関数で確かめる。
- **`checkAdminSession` で `admin` が `null` になることはない**（`admin_sessions.admin_id` に `REFERENCES` があり、管理者の行は消さない）。`null` が渡されたらバグとして例外を投げる（1.1）。

`lib/` に置く部品：

| 関数 | 置き場所 | 内容 |
| --- | --- | --- |
| `windowStart(now)` | `lib/time.js` | `Math.floor(now / 600000) * 600000`（10分の区切りの始まり。auth.md 7） |
| `readCookie(header, name)` | `lib/cookie.js` | `Cookie` ヘッダから名前の値を取り出す。ヘッダがない、名前がないときは `null` |
| `isTokenFormat(s)` | `lib/cookie.js` | 証明の値の形（43文字の base64url。`A-Z`・`a-z`・`0-9`・`-`・`_`）か。形が違う値はハッシュを求めず、Cookie がないものとして扱う |
| `adminCookie(value)`・`clearAdminCookie()` | `lib/cookie.js` | `Set-Cookie` の値を作る。`__Host-dxp_admin=値; Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict`（400日。auth.md 3）。消すときは値を空にして `Max-Age=0` |
| `userCookie(value)` | `lib/cookie.js` | `__Host-dxp_user=値; Max-Age=34560000; Path=/; Secure; HttpOnly; SameSite=Strict`（属性は `adminCookie` と同じ）。利用者には認証を解く操作がないので、消す関数は作らない |
| `equalBytes(a, b)` | `lib/hash.js` | 同じ長さのバイト列を `crypto.subtle.timingSafeEqual` で比べる。長さが違えば偽（PBKDF2 の結果は常に32バイトなので、ふつうは起きない） |
| `newToken()` | `lib/hash.js` | `{ value, hash }` を返す（`await` が要る）。`value` は `crypto.getRandomValues` で作った32バイトを base64url（`=` なし）にした43文字、`hash` は `value` の UTF-8 のバイト列の SHA-256。管理者の認証の証明（api.md 8.4）、共有された情報の値（api.md 8.9）、利用を始めた証明で同じ部品を使う。`value` は `isTokenFormat` を必ず通る |

テストの観点（ルールの層・部品の層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| SEC-3（`checkAttemptLimit`） | `null`、`failures` が上限 − 1 | `failures` が上限ちょうど（`LIMIT_ATTEMPTS`） |
| ADM-2（`checkAdminLogin`） | 削除していない管理者でパスワードが等しい | `null`（`unknown_id`）、削除した管理者（パスワードが等しくても `unknown_id`）、パスワードが違う（`wrong_password`）。どれも `code` は `AUTH_ADMIN_FAILED` |
| ADM-2（`checkAdminSession`） | 解いていない・削除されていない・版が同じ | `null`（`AUTH_REQUIRED`）、`ended_at` がある、管理者が削除されている、版が違う（どれも `AUTH_REVOKED`） |
| USR-2（`checkSharedInfo`） | 行があり `matches` が真 | `null`（`AUTH_SHARED_INFO_UNSET`、`failure` なし）、`matches` が偽（`AUTH_SHARED_INFO_WRONG`、`failure: 'wrong'`）。`null` で `matches` も偽なら `UNSET` |
| ADM-3（`checkUserSession`） | `shared_info_id` が `currentVersion` と同じ | `null`（`AUTH_REQUIRED`）、版が小さい（`AUTH_REVOKED`）。`session` があり `currentVersion` が `null` なら例外 |
| USR-2（`userCookie`） | 値と属性が上のとおり。`readCookie(…, '__Host-dxp_user')` で、管理者の Cookie と並んでいても利用者の値だけを取り出せる | ― |
| SEC-3（`windowStart`） | 10:09:59.999 と 10:00 が同じ区切り、10:10 は次の区切り（TIM-2 と同じく始まりを含む） | ― |
| ADM-2（`readCookie`・`isTokenFormat`） | ほかの Cookie と並んでいても取り出せる。43文字の base64url | 42文字・44文字、`=` や `+` を含む値、ヘッダがない |
| ADM-3（`newToken`） | `value` が43文字で `isTokenFormat` を通る。`hash` が `value` の SHA-256（32バイト）と等しい。2回呼ぶと違う値になる | ― |

## 7. 共通のテストの観点

| 対象 | 観点 |
| --- | --- |
| `settingAt` | 有効になる時刻がちょうど 時刻 の行を使う（RSV-26 の「同じ時刻なら変更後」）。直前の行を使う。同じ時刻の行が2つなら後の行 |
| `dueTransitions` | 起きる時刻がちょうど `nowMin` なら返す、1分後なら返さない（RSV-22）。猶予が長さより長いときは終了時刻（RSV-16）。猶予は開始時刻の時点の値（RSV-26）。並びは時刻順、同じ時刻なら番号順 |
| 操作ごとの関数 | 2つ以上のルールに反する入力で、4 の順で先のコードを返す |

テスト名は要件の ID で始める（CLAUDE.md）。

## 採らなかった案

| 案 | 理由 |
| --- | --- |
| ルールに反したら例外を投げる | どこで断ったかがコードから追いにくい（RSV-27）。台帳では例外がトランザクションの取り消しや台帳の作り直しにつながる |
| 要件ごとの関数だけを作り、呼ぶ順は `api/` が持つ | 判定の順が `api/` に散らばり、`api/` が判定することになる |
| 操作ごとの関数だけを作る | 要件の ID 単位でテストしにくい |
| store が SQL で正確に絞り込み、rules は結果を受け取るだけ | 判定が SQL と JavaScript に分かれ、DB なしで確かめられない |
| 操作ごとの関数でも猶予・終了時刻を比べ直す | 自動の変化の判定と2か所に分かれる |
| 数値を `nowMin` の時点の値に直してから渡す | 猶予は開始時刻の時点の値が要る（RSV-26）。引き方を1つの関数にまとめる |

## 要件の読み方（確認済み）

- **RSV-11・TIM-6 の「変更する時刻」。** 時間帯の変更の API は開始と終了の両方を受け取る。今と同じ値を送った側は「変更しない時刻」とみなし、TIM-6・RSV-11 を当てはめない。このため、開始時刻を過ぎた予約済の予約でも、終了時刻だけを変えられる。2026-11-19 に開発者が確認した。採らなかった読み方：変える側だけを送らせ、送られた時刻にはすべて当てはめる（画面が変えた欄を見分ける必要があり、API の入力の形が変わる）。

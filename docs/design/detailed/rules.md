# ルールの判定

- 状態：決定（2026-11-19 の詳細設計のレビューの後）
- 日付：2026-11-19（2026-11-20 に USR-3・USR-7 の修正に合わせて 6.5 を直した）
- 関係する要件：USR-2〜USR-7, ADM-2, ADM-3, TIM-1〜TIM-4, TIM-6〜TIM-8, RSV-1〜RSV-27, VIW-1, VIW-2, MNG-1〜MNG-3, SEC-3, NFR-3, NFR-4, FUT-5
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

`settingAt(履歴, 項目, 時刻)`（`src/rules/settings.js`。6.17 の `SETTING_KEYS` と同じファイル）は、その項目の行のうち「有効になる時刻が 時刻 以下」で最も新しいものの値を返す（domain-model.md 3）。同じ有効になる時刻の行が複数あれば、後に足した行（番号が大きいほう）を使う。

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
- 1 は `api/` が `lib/` を呼んで確かめ、2〜8 は操作ごとの関数が確かめる。1 は architecture.md 3 の手順 3、2〜8 は手順 5 に当たる。認証（手順 2）は 1 より前に、自動の変化の反映（手順 4）は 1 と 2 の間に済んでいる（1 で断れば反映しない。api.md 8.25）。
- 5 は、変更では変えない側の時刻と合わせて比べる。利用終了には当てはめない（TIM-7。長さ0を認める）。
- 重なりは、予約済・利用中の予約だけを対象にし（RSV-1）、`[開始, 終了)` どうしで比べる（TIM-2）。時間帯の変更と利用開始では、その予約自身を除く。
- RSV-20（空いている）は、`[nowMin, 終了)` の重なりの判定に含まれるが、別のコード `RULE_DEVICE_BUSY` にし、重なりより先に確かめる（6.11）。
- 操作によって当てはまらない段は飛ばす（例：取消には 4〜8 がない）。操作ごとに、どの段で何を確かめるかを下の 6 に書く。

## 5. 自動の変化

### 5.1 `dueTransitions(予約の一覧, 数値の履歴, nowMin)`

`src/rules/transitions.js` に置く。`nowMin` までに起きるはずの変化を、起きる時刻の順（同じ時刻なら予約の番号の順）に並べて返す（time-and-concurrency.md 3）。

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

操作ごとの関数は、自動の変化を反映した後のデータを受け取るものとする（architecture.md 手順 4 の後）。

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
| 時刻の形式と日本時間（`lib/time.js`） | TIM-1〜TIM-4, TIM-6 | 済（6.8） |
| 予約状況 | VIW-1, VIW-2 | 済（6.9。api.md 8.24） |
| 確保 | RSV-2〜RSV-6 | 済（6.10。api.md 8.25） |
| 予約なしの利用 | RSV-17, RSV-20 | 済（6.11。api.md 8.27） |
| 自分の予約 | RSV-7 | 済（6.12。api.md 8.29） |
| 時間帯の変更 | RSV-9〜RSV-12 | 済（6.13。api.md 8.32） |
| 取消 | RSV-8 | 済（6.12。api.md 8.30） |
| 利用開始 | RSV-14〜RSV-16 | 済（6.14。api.md 8.34） |
| 利用終了 | RSV-18 | 済（6.15。api.md 8.35） |
| 管理者による取消・終了（と、その対象を選ぶ機器ごとの一覧） | MNG-3 | 済（6.16。api.md 8.37〜8.39） |
| 機器の追加・名前の変更・削除 | MNG-1, MNG-2 | 済（名前の検証は 6.6、判定は 6.7。api.md 8.18〜8.23） |
| 管理者の作成・パスワードの設定し直し | ADM-2 | 済（6.1。保守用の API の設計で決め、管理者の画面からの操作も同じ関数を使う。api.md 8.1・8.2・8.45・8.46） |
| 管理者の削除 | ADM-2 | 済（6.1。api.md 8.47） |
| 数値の変更 | RSV-25, RSV-26 | 済（6.17。api.md 8.41〜8.43） |
| 管理者の入力の検証（`lib/`） | ADM-2, USR-5, SEC-3 | 済（6.2） |
| 登録・ログイン・名前と期生の変更の入力の検証（`lib/`） | USR-3〜USR-6 | 済（名前 USR-5 と全角・大小のそろえ方は 6.2、生徒か教員か・学籍番号・期生は 6.4） |
| 登録・ログイン・名前と期生の変更（いるか、置き換えるか） | USR-3, USR-7 | 済（6.5。api.md 8.15。2026-11-20 に USR-3・USR-7 の修正に合わせて分けた） |
| 管理者の認証・管理者の証明・試行の上限 | ADM-2, SEC-3 | 済（6.3。試行の上限は利用の開始・保守用の API も同じ関数を使う） |
| 利用の開始・利用者の証明 | USR-2, ADM-3, SEC-3 | 済（6.3 の `checkSharedInfo`・`checkUserSession`・`userCookie`。api.md 8.11〜8.13） |
| 共有された情報の設定・変更 | ADM-3 | 済（判定なし。管理者の証明（6.3 の `checkAdminSession`）を通れば必ず受け付けるので、関数を作らない。値は 6.3 の `newToken`。api.md 8.9） |

### 6.1 管理者の作成・パスワードの設定し直し・削除（`src/rules/admins.js`。ADM-2）

| 関数 | 引数 | 段 | 確かめること | コード |
| --- | --- | --- | --- | --- |
| `checkAdminCreate(sameIdAdmin)` | store が、そろえた後の ID で引いた管理者の行（削除した行も含む）。なければ `null` | 8 | `null` でなければ断る（ADM-2「削除したアカウントの ID は再び使えない」） | `RULE_ADMIN_ID_DUPLICATE` |
| `checkAdminPasswordReset(admin, actorAdminId)` | `admin`：store が番号で引いた管理者の行（削除した行も含む）。なければ `null`。`actorAdminId`：操作した管理者の番号。保守用の API（api.md 8.2）は `null` を渡す | 2 | `null`、または `deleted_at` が `NULL` でなければ断る | `NOT_FOUND_ADMIN` |
| | | 8 | `actorAdminId` が `admin.id` と同じなら断る（自分自身の設定し直し） | `RULE_ADMIN_SELF_RESET` |
| `checkAdminDelete(admin, activeAdmins)` | `admin`：`checkAdminPasswordReset` と同じ。`activeAdmins`：store が引いた、削除していない管理者の全件 | 2 | `checkAdminPasswordReset` の段 2 と同じ | `NOT_FOUND_ADMIN` |
| | | 8 | `activeAdmins` が1件以下なら断る（最後の1人） | `RULE_ADMIN_LAST` |

- どれも受け付けるときは `{ ok: true }` だけを返す（1.1 の「ルールで決まる値」はない）。
- 段 1（入力の形式）は `api/` が 6.2 の関数で先に確かめる。作成では段 2〜7 に当たるものがない。設定し直し・削除では段 3〜7 に当たるものがない。
- **自分自身のパスワードは設定し直せない。** ADM-2 は「他の管理者が設定し直せる」とし、自分のパスワードを変える機能は10章で除かれている（api.md 8.46。2026-11-19 に開発者が決定）。保守用の API は `actorAdminId` に `null` を渡すので、この段 8 で断らない。段 8 に置くのは、段 3〜7 に当たらず、対象がいることを確かめた後にするため。
- **自分自身は削除できる（ADM-2）。** `checkAdminDelete` は操作した管理者を受け取らない。
- **最後の1人の数え方は rules が持つ（3）。** store は削除していない管理者を全件渡し（数人なので小さい）、件数を SQL で数えない。段 2 を通った `admin` は削除していないので必ず `activeAdmins` に入っており、1件以下なら対象が最後の1人。
- 同時の削除（RSV-23）は、判定から書き込みまでの間に `await` がないので割り込まれない（api.md 8.47）。
- 重なりを段 8 に置くのは、ほかの人の行しだいで変わるものを最後にする考え方（4）による。
- `admins.login_id` の `UNIQUE`（schema.md 2.5）は最後の守り。判定とコードはこの関数が持つ（3）。
- 同時に同じ ID で作ったとき（RSV-23）は、処理全体が `blockConcurrencyWhile` の中なので、後の方がこの関数で断られる（api.md 8.1）。

テストの観点（ルールの層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| ADM-2（作成） | 同じ ID の行がない | 同じ ID の行がある。その行が削除済みでも断る |
| ADM-2（設定し直し） | 削除していない管理者で、`actorAdminId` が別の番号。`actorAdminId` が `null`（保守用） | `null`、削除済みの管理者（`NOT_FOUND_ADMIN`）、`actorAdminId` が対象と同じ（`RULE_ADMIN_SELF_RESET`）。削除済みで `actorAdminId` も同じなら `NOT_FOUND_ADMIN`（段 2 が先） |
| ADM-2（削除） | `activeAdmins` が2件で、対象がその1件（自分自身でも同じ） | `null`、削除済みの管理者（`NOT_FOUND_ADMIN`）、`activeAdmins` が対象の1件だけ（`RULE_ADMIN_LAST`）。削除済みで `activeAdmins` が1件なら `NOT_FOUND_ADMIN` |

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

### 6.4 利用者の入力の検証（`src/lib/`。USR-3〜USR-6）

1.2 の形で返す。登録・ログイン・名前と期生の変更（api.md 8.15）と、利用者の操作の API の識別の組（api.md 8.16）で使う。名前は 6.2 の `validateName` を使う。

| 関数 | 手順 | `value` | コード |
| --- | --- | --- | --- |
| `validateRole(s)` | `'student'` か `'teacher'` のどちらかと完全に一致するか確かめる。大文字・小文字はそろえない（画面が決まった値を送る） | 入力どおりの値 | `INPUT_ROLE` |
| `validateStudentId(role, s)` | `toHalfWidthLower`（6.2）でそろえ、`role` が `'student'` なら `^[0-9]{8}$`、`'teacher'` なら `^[a-z0-9._-]{1,64}$` に合うか確かめる。前後の空白は除かない（空白は形式の誤りになる。`validateLoginId` と同じ） | そろえた学籍番号 | `INPUT_STUDENT_ID` |
| `validateCohort(role, v)` | `role` が `'student'` なら、`v` が数値で `Number.isSafeInteger(v)` が真で、1以上か確かめる（ない、`null`、文字列、小数、0、負の数はどれも断る）。`'teacher'` なら `v` を見ずに受け付ける | 生徒は `v`、教員は `null` | `INPUT_COHORT` |

- `validateStudentId`・`validateCohort` は、先に `validateRole` を通った `role` を受け取る。
- **先頭の0を残す（USR-4）。** 学籍番号は文字列のまま扱い、数値に直さない。7桁は、先頭の0を省いたものも含めて断る。
- **全角はそろえてから形式を確かめる（USR-4）。** `１２３４５６７８` は `12345678` に、全角の `－`・`．`・`＿` は半角になる。長音符の `ー`（U+30FC）は全角の英数字・記号ではないのでそのまま残り、形式の誤りになる。
- **期生は JSON の数値で受け取る。** 文字列にすると、先頭の0（`"007"`）や全角の数字の読み方を別に決めることになる。画面は入力欄の値を数値に直して送る。上限は要件にないので設けない。`Number.isSafeInteger` の範囲（2^53 − 1 まで）が、JavaScript で正確に扱える整数の上限として事実上の上限になる。
- **期生の型の誤りも `INPUT_COHORT` にする。** ほかの項目は型の誤りを `INPUT_BODY`（共4）にするが、期生は要るかどうかが `role` で変わるので、型も含めてここで確かめる（error-codes.md 3.1）。
- **教員の期生は送られても無視する（USR-6「教員は期生を持たない」）。** 画面で生徒から教員に切り替えると、前に入れた期生が残りやすい。`role` で意図は曖昧なく読める。

テストの観点（部品の層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| USR-3（`validateRole`） | `student`、`teacher` | `Student`、`admin`、空 |
| USR-4（`validateStudentId`、生徒） | `12345678`、`00000001`（先頭の0を残す）、`１２３４５６７８` → `12345678` | 7桁（`0000001` を含む）・9桁、英字を含む、前後に空白、空 |
| USR-4（`validateStudentId`、教員） | 1文字・64文字、数字だけ、`Tanaka.T` → `tanaka.t`、`ａ－ｂ．ｃ＿ｄ` → `a-b.c_d` | 空、65文字、空白・`@`・ひらがな・長音符 `ー` を含む |
| USR-6（`validateCohort`） | 生徒の 1、大きな整数（`Number.MAX_SAFE_INTEGER`）。教員はどんな値（ない、文字列、0）でも `null` | 生徒で、ない、`null`、0、−1、1.5、`"1"`、`Number.MAX_SAFE_INTEGER + 1` |

### 6.5 登録・ログイン・名前と期生の変更（`src/rules/users.js`。USR-3, USR-7）

2026-11-20 に要件の修正（USR-3・USR-7）に合わせて、それまでの `decideUserInput`（作る・置き換える・変わらない）を次の3つに分けた。

| 関数 | 引数 | 戻り値 |
| --- | --- | --- |
| `checkUserRegister(existing)` | `existing`：store が `(role, そろえた学籍番号)` で引いた `users` の行（なければ `null`） | `null` なら `{ ok: true }`。でなければ `RULE_USER_DUPLICATE`（段 8） |
| `checkUserLogin(existing)` | 同上 | `null` なら `NOT_FOUND_USER`（段 2）。でなければ `{ ok: true }` |
| `decideUserChange(existing, input)` | `existing`：同上。`input`：6.4 と `validateName` を通った後の `{ name, cohort }` | `null` なら `NOT_FOUND_USER`（段 2）。でなければ `{ ok: true, action }`。`action` は下の表 |

`decideUserChange` の `action`：

| `action` | 条件 |
| --- | --- |
| `rename` | `existing.name` と `input.name`、または `existing.cohort` と `input.cohort` の少なくとも一方が違う |
| `unchanged` | どちらも同じ |

- **1行で済む判定も関数にする。** いるかいないかで断るのは判定であり、`api/` に判定を書かないため（architecture.md 4）。理由のコードを決めるのも `rules/` の役目にそろえる。
- **登録は、すでにいれば名前・期生を比べずに断る**（USR-3「すでにいる利用者は登録できない」。api.md 8.15.2）。
- **`RULE_USER_DUPLICATE` は段 8。** 保存してある値（ほかの利用者の組）と比べる重複なので、`RULE_ADMIN_ID_DUPLICATE`・`RULE_DEVICE_NAME_DUPLICATE` と同じ段に置く（4）。
- **名前は前後の空白を除いた後の値を、そのまま比べる。** 全角・半角や Unicode の正規化はしない。表示のための値で、利用者が入れたとおりに置き換えるため（USR-7「それまでと異なれば」）。
- 期生は数値か `null` で比べる。教員はどちらも `null` なので、名前だけで決まる。
- 生徒か教員かは識別の組の一部なので、同じ行の中で変わることはない。

テストの観点（ルールの層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| USR-3（`checkUserRegister`） | `null` | 行がある（`RULE_USER_DUPLICATE`） |
| USR-3（`checkUserLogin`） | 行がある | `null`（`NOT_FOUND_USER`） |
| USR-7（`decideUserChange`） | 名前だけ違う、期生だけ違うときはどちらも `rename`。どちらも同じなら `unchanged`。名前の大文字と小文字の違い、全角と半角の違いも `rename` | `null`（`NOT_FOUND_USER`） |

### 6.6 機器の名前の検証（`src/lib/`。MNG-1）

1.2 の形で返す。

| 関数 | 手順 | `value` | コード |
| --- | --- | --- | --- |
| `validateDeviceName(s)` | `validateName`（6.2）と同じ手順：(1) 改行と制御文字（Unicode の Cc、U+2028、U+2029）を1つでも含めば断る。(2) 前後の空白を除く。(3) 除いた後の長さがコードポイントで1以上30以下か確かめる | 前後の空白を除いた名前 | `INPUT_DEVICE_NAME` |

- **上限は30（design-values.md）。** MNG-1 は上限を設計に任せている。利用者・管理者の名前（USR-5）と同じ値にそろえ、画面の選択肢の幅も同じ考え方で済ませる。「3Dプリンタ（Bambu Lab X1 Carbon）1号機」で28文字。
- **改行と制御文字を断る。** MNG-1 には書かれていないが、名前は利用者の画面の選択肢・予約・記録に出るので、表示と Data Studio での読みを崩さないために断る（2026-11-19 に開発者が了承）。
- **コードを `INPUT_NAME` と分ける。** 画面で「機器の名前は…」と出し分けるため。手順は同じなので、実装では `validateName` と共通の内部の関数を使ってよい（上限だけを引数にする）。
- 全角と半角、大文字と小文字はそろえない（6.7 の比べ方と同じ）。

テストの観点（部品の層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| MNG-1（`validateDeviceName`） | 1文字・30文字（前後の空白を除いて）、前後の空白・全角の空白を除いた値を返す、全角の英数字をそのまま返す | 空、空白だけ、31文字、途中・末尾の改行、タブ、U+0000。どれも `INPUT_DEVICE_NAME` |

### 6.7 機器の追加・名前の変更・削除（`src/rules/devices.js`。MNG-1, MNG-2）

| 関数 | 引数 | 段 | 確かめること | コード |
| --- | --- | --- | --- | --- |
| `checkDeviceCreate(sameName)` | store が、削除していない機器から、前後の空白を除いた名前と完全に一致するものを引いた行。なければ `null` | 8 | `null` でなければ断る | `RULE_DEVICE_NAME_DUPLICATE` |
| `checkDeviceRename(device, sameName)` | `device`：store が番号で引いた機器の行（削除した行も含む。なければ `null`）。`sameName`：`checkDeviceCreate` と同じ | 2 | `device` が `null`、または `deleted_at` が `NULL` でなければ断る | `NOT_FOUND_DEVICE` |
| | | 8 | `sameName` があり、その番号が `device` と違えば断る | `RULE_DEVICE_NAME_DUPLICATE` |
| `checkDeviceDelete(device, active)` | `device`：`checkDeviceRename` と同じ。`active`：store が引いた、その機器の予約済・利用中の予約の全件 | 2 | `checkDeviceRename` の段 2 と同じ | `NOT_FOUND_DEVICE` |
| | | 8 | `active` に利用中が1件でもあれば断る | `RULE_DEVICE_IN_USE` |

受け付けるときの戻り値：

| 関数 | 戻り値 |
| --- | --- |
| `checkDeviceCreate` | `{ ok: true }` |
| `checkDeviceRename` | `{ ok: true, action }`。`action` は、`device.name` と新しい名前が同じなら `unchanged`、違えば `rename` |
| `checkDeviceDelete` | `{ ok: true, cancel }`。`cancel` は `active` のうち予約済の予約の番号の一覧（番号の順） |

- **名前は、前後の空白を除いた後の文字列をそのまま比べる。** 全角と半角、大文字と小文字はそろえない（`３Dプリンタ` と `3Dプリンタ` は別の名前）。要件は「重複しない」とだけ書いており、そろえるとどこまでを同じとみなすか（NFKC、途中の空白など）を新しく決めることになる。機器を足すのは管理者だけで台数も少ない。利用者の名前の比べ方（6.5）ともそろう。schema.md 2.2 の `devices_name_current` がそのまま最後の守りになる。
- **自分と同じ名前への変更は `unchanged`。** `sameName` が自分自身なら重複にしない。`api/` は何も書かず、記録もしない（6.5 の `unchanged` と同じ）。
- **削除した機器の名前は再び使える（MNG-1）。** store が `sameName` を削除していない機器だけから引く。
- **削除で取り消す予約を決めるのは rules。** 「その機器の予約済をすべて」という MNG-2 の判定を `api/` に書かないため。
- **利用中かどうかは、自動の変化を反映した後の状態で見る（5.3）。** 終了時刻が `nowMin` 以下の利用中の予約はすでに終了になっているので、削除を妨げない（RSV-22「同じ時刻では自動の変化が先」）。猶予を過ぎた予約済も、無断不使用になっていて `cancel` に入らない。
- 段 1 は `api/` が 6.6 で確かめる。段 3〜7 に当たるものはない。重複と利用中を段 8 に置くのは、ほかの行しだいで変わるものを最後にする考え方（4）による。
- 同時の操作（RSV-23）は、判定から書き込みまでの間に `await` がないので割り込まれない（api.md 8.19〜8.21）。

テストの観点（ルールの層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| MNG-1（`checkDeviceCreate`） | `null` | 行がある（`RULE_DEVICE_NAME_DUPLICATE`） |
| MNG-1（`checkDeviceRename`） | `sameName` が `null` で名前が違う（`rename`）。`sameName` が自分自身（`unchanged`）。大文字と小文字だけ違う名前（`rename`） | `null`・削除済み（`NOT_FOUND_DEVICE`）、`sameName` が別の機器（`RULE_DEVICE_NAME_DUPLICATE`）。削除済みで `sameName` も別の機器なら `NOT_FOUND_DEVICE`（段 2 が先） |
| MNG-2（`checkDeviceDelete`） | `active` が空（`cancel` は空）。予約済だけ（`cancel` がその番号の一覧） | `null`・削除済み（`NOT_FOUND_DEVICE`）、予約済と利用中が混ざっている（`RULE_DEVICE_IN_USE`）。削除済みで利用中があっても `NOT_FOUND_DEVICE` |

### 6.8 時刻の形式と日本時間（`src/lib/time.js`。TIM-1〜TIM-4, TIM-6）

日本時間との換算はこのファイルだけで行う（time-and-concurrency.md 1）。受け渡しの形は screens-and-api.md 6。検証の関数は 1.2 の形で返す。引数が文字列でないことはここでは扱わない（`api/` が共4 で `INPUT_BODY` にする。日はクエリなので必ず文字列か `null`）。

| 関数・定数 | 手順 | `value` | コード |
| --- | --- | --- | --- |
| `MINUTE_MS`・`DAY_MS`・`JST_OFFSET_MS` | 60000、86400000、32400000（9時間） | ― | ― |
| `floorMinute(ms)` | `Math.floor(ms / 60000) * 60000`（TIM-4, TIM-6。`nowMin` を作る） | ― | ― |
| `parseDateTime(s)` | (1) `^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$` に合うか確かめる（`u` を付けないので `\d` は半角の数字だけ）。(2) `Date.UTC(年, 月 − 1, 日, 時, 分) − JST_OFFSET_MS` でミリ秒に直す。(3) その値を `formatDateTime` で戻し、`s` と同じか確かめる | 日本時間のその時刻のミリ秒（分の倍数） | `INPUT_TIME` |
| `parseDate(s)` | `s` が `null` なら断る。`^(\d{4})-(\d{2})-(\d{2})$` に合うか確かめ、`Date.UTC(年, 月 − 1, 日) − JST_OFFSET_MS` に直し、`formatDate` で戻して `s` と同じか確かめる | 日本時間のその日の 0:00 のミリ秒 | `INPUT_DATE` |
| `formatDateTime(ms)` | `ms + JST_OFFSET_MS` を `Date` の UTC の値として読み、`YYYY-MM-DDTHH:mm` にする（秒以下は書かない） | ― | ― |
| `formatDate(ms)` | 同じく `YYYY-MM-DD` にする | ― | ― |

- **戻して比べる。** `02-30`・`13` 月・`24:00`・`10:60` などは `Date.UTC` が繰り上げてしまうので、形だけでは断れない。戻した文字列が違えば断る。0〜99年は `Date.UTC` が1900年代に読み替えるが、これも戻すと違うので断られる。
- **秒は書けない形にする（TIM-3）。** `10:00:00`・`10:00:00.000`・`Z` や `+09:00` の付いた値は (1) で断る。`<input type="datetime-local">` は既定の刻み（60秒）では秒を返さない。
- **年は4桁。** 確保できるのは 9999-12-31T23:59 まで。RSV-5「どれだけ先の時間帯でも確保できる」は、この範囲で満たすとする（2026-11-19 に開発者が了承）。過去の年は形式としては受け付け、確保では段 4（`RULE_PAST`）で断る。予約状況は過去の日も見られる。
- **日の範囲は `[parseDate(s), parseDate(s) + DAY_MS)`**（time-and-concurrency.md 1、TIM-2）。日本に夏時間はないので、どの日も24時間。
- **`INPUT_DATE` を `INPUT_TIME` と分ける。** 予約状況の日と確保の時刻は別の入力欄で、画面の文を出し分けるため（2026-11-19 に開発者が了承）。

テストの観点（部品の層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| TIM-3（`parseDateTime`） | `2026-11-20T10:00` が `Date.UTC(2026, 10, 20, 1, 0)` と等しい。`2026-11-20T00:00` が前の日の 15:00 UTC になる。`2028-02-29T23:59`（うるう年）。`9999-12-31T23:59` | `2026-11-20T10:00:00`、`2026-11-20 10:00`、`2026-11-20T10:00+09:00`、`2026-02-30T10:00`、`2027-02-29T10:00`、`2026-11-20T24:00`、`2026-11-20T10:60`、`2026-1-2T3:04`、全角の数字、`0099-01-01T00:00`、空。どれも `INPUT_TIME` |
| VIW-1（`parseDate`） | `2026-11-20` が `Date.UTC(2026, 10, 19, 15, 0)` と等しい | `null`、`2026-11-31`、`2026-11-20T00:00`、`20261120`、空。どれも `INPUT_DATE` |
| TIM-1（`formatDateTime`・`formatDate`） | `parseDateTime`・`parseDate` で直した値を戻すと元の文字列になる。UTC の 14:59 と 15:00 で日本時間の日付が変わる。秒のある `ms` を渡しても秒は出ない | ― |
| TIM-4（`floorMinute`） | 10:00:59.999 → 10:00、10:01:00.000 → 10:01 | ― |

### 6.9 予約状況（`src/rules/devices.js`・`src/rules/view.js`。VIW-1, VIW-2）

| 関数 | 引数 | 段 | 確かめること・すること | 戻り値 |
| --- | --- | --- | --- | --- |
| `checkDeviceActive(device)` | store が番号で引いた機器の行（削除した行も含む。なければ `null`） | 2 | `null`、または `deleted_at` が `NULL` でなければ断る | `{ ok: true }` か `{ ok: false, code: 'NOT_FOUND_DEVICE' }` |
| `daySlots(reservations, dayStart, dayEnd)` | `reservations`：store が引いた、その機器の予約（状態で絞らない。api.md 8.24）。`dayStart`・`dayEnd`：日の範囲 | ― | 下の条件に合う予約を、開始時刻の順（同じなら番号の順）に並べて返す | 予約の配列（引数の要素をそのまま並べたもの） |

`daySlots` が残す予約：

| 条件 | 内容 | 要件 |
| --- | --- | --- |
| 状態 | `reserved`・`in_use`（確保済み）、`finished`・`admin_finished`（利用があった）。`cancelled`・`no_show`・`admin_cancelled` は残さない | VIW-1 |
| 日にかかる | 長さが正なら `start_at < dayEnd かつ end_at > dayStart`（`[開始, 終了)` と日の範囲が重なる。TIM-2）。長さが0なら `dayStart <= start_at < dayEnd`（開始時刻を含む日に出す） | VIW-1, TIM-2, TIM-7 |

- **`checkDeviceActive` は、予約状況・確保・予約なしの利用で使う。** `checkDeviceRename`・`checkDeviceDelete` の段 2 も同じ判定なので、実装ではこの関数を呼んでよい。
- **長さ0の利用（TIM-7）は開始時刻を含む日に出す（2026-11-19 に開発者が了承）。** `[s, s)` は TIM-2 の読み方ではどの日とも重ならないが、VIW-1 は利用があった予約を表示するとしている。0:00 ちょうどに始めて終えた利用は、重なりの式だけではどの日にも出ない。
- **日をまたぐ予約は、かかるすべての日に出る。** 開始・終了は切らずにそのまま返し、画面がその日の範囲に切って描く。終了時刻がちょうど日の始まりの予約（長さが正）は、その日には出ない（TIM-2）。
- **空きは返さない。** 空きは、確保済み（予約済・利用中）の時間帯のすき間として画面が描く（screens.md）。表示のためのもので、確保できるかの判定は確保の段 8 が行う（RSV-24。2026-11-19 に開発者が了承）。
- **予約状況は自動の変化を反映した後のデータで作る（5.3）。** 猶予を過ぎた予約済はすでに無断不使用で、出ない。終了時刻を過ぎた利用中はすでに終了で、利用があった時間帯として出る。
- **学籍番号を返さないのは `api/` の応答の作り方で守る**（api.md 8.24）。`daySlots` は予約を選ぶだけで、項目を選ばない。

テストの観点（ルールの層）：

| ID | 受け付ける・残す | 断る・残さない |
| --- | --- | --- |
| VIW-1（`checkDeviceActive`） | 削除していない機器 | `null`、削除した機器（`NOT_FOUND_DEVICE`） |
| VIW-1（`daySlots`、状態） | 予約済・利用中・終了・管理者による終了 | 取消・無断不使用・管理者による取消 |
| VIW-1（`daySlots`、範囲） | 日の中に収まる。前の日の 23:00〜その日の 1:00（日をまたぐ）。その日の 23:00〜次の日の 1:00。前の日から次の日まで。開始がちょうど日の始まり。長さ0で開始が日の始まりちょうど・23:59 | 終了がちょうど日の始まり（長さが正）。開始がちょうど次の日の始まり。長さ0で開始が次の日の始まり |
| VIW-1（`daySlots`、並び） | 開始時刻の順。同じ開始時刻なら番号の順 | ― |

### 6.10 確保（`src/rules/reservations.js`。RSV-2〜RSV-6, TIM-6, TIM-7）

要件ごとの関数（2）。ここで作るものは、予約なしの利用・時間帯の変更・利用開始（②〜⑤）でも使う。時刻はミリ秒、`nowMin` は 1.3 のとおり。

| 関数 | 段 | 確かめること | コード |
| --- | --- | --- | --- |
| `checkStartNotPast(start, nowMin)` | 4 | `start >= nowMin`（TIM-6「開始時刻は現在時刻以降」） | `RULE_PAST` |
| `checkEndNotPast(end, nowMin)` | 4 | `end > nowMin`（TIM-6「終了時刻は現在時刻より後」） | `RULE_PAST` |
| `checkTimeOrder(start, end)` | 5 | `end > start`（TIM-7, RSV-5） | `RULE_TIME_ORDER` |
| `checkLength(start, end, limitMinutes)` | 6 | `end − start <= limitMinutes × MINUTE_MS`（RSV-6） | `RULE_LENGTH` |
| `checkCount(userActive, limit)` | 7 | `userActive` のうち、状態が `reserved`・`in_use` で `walk_in` が 0 のものの件数が `limit` 未満（RSV-4, RSV-5） | `RULE_COUNT` |
| `checkOverlap(deviceActive, start, end, excludeId)` | 8 | `deviceActive` のうち、状態が `reserved`・`in_use` で、番号が `excludeId` でなく、`r.start_at < end かつ start < r.end_at` のものが1件もない（RSV-1, RSV-3, TIM-2）。`excludeId` は確保では `null` | `RULE_OVERLAP` |

- 受け付けるときは `{ ok: true }` だけを返す。
- **状態は rules でも確かめる。** store は予約済・利用中だけを引くが（3 の「多め」に返してよい決まり）、数え方と重なりの対象（RSV-1）は rules が決める。
- **重なりの式は長さが正の時間帯どうしのためのもの。** 長さ0になるのは利用終了の後（TIM-7）で、そのとき状態は終了なので重なりの対象に入らない。
- **`RULE_PAST` は開始と終了で分けない（2026-11-19 に開発者が了承）。** どちらの欄が過去かは、画面が入力と応答の `now`（api.md 8.24）からわかる。

操作ごとの関数：

| 関数 | 引数 |
| --- | --- |
| `checkReserve({ user, device, start, end, nowMin, settings, userActive, deviceActive })` | `user`：識別の組で引いた利用者（api.md 8.16。なければ `null`）。`device`：番号で引いた機器（削除した行も含む。なければ `null`）。`start`・`end`：6.8 で直したミリ秒。`settings`：数値の履歴の全件（3.1）。`userActive`：その利用者の予約済・利用中の全件（全機器）。`deviceActive`：その機器の予約済・利用中の全件 |

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` → `parseDateTime(start)` → `parseDateTime(end)` | `INPUT_ROLE`・`INPUT_STUDENT_ID`・`INPUT_TIME` |
| 2 | `user` が `null` でない → `checkDeviceActive(device)` | `NOT_FOUND_USER` → `NOT_FOUND_DEVICE` |
| 3 | なし（新しく作るので状態がない） | ― |
| 4 | `checkStartNotPast` → `checkEndNotPast` | `RULE_PAST` |
| 5 | `checkTimeOrder` | `RULE_TIME_ORDER` |
| 6 | `checkLength(start, end, settingAt(settings, 'max_length_minutes', nowMin))` | `RULE_LENGTH` |
| 7 | `checkCount(userActive, settingAt(settings, 'max_count', nowMin))` | `RULE_COUNT` |
| 8 | `checkOverlap(deviceActive, start, end, null)` | `RULE_OVERLAP` |

- 受け付けるときは `{ ok: true }` を返す（1.1 の「ルールで決まる値」はない。開始・終了は入力どおり）。
- **件数は全機器で数える（RSV-4「1人が同時に確保できる」）。** 重なりはその機器だけ（RSV-3「この制限は機器ごと」）。同じ人の予約どうしの重なりも断る。
- **件数に予約なしの利用で始めたものを数えない（RSV-5, RSV-17）。** `walk_in` は作るときに決まり変わらない（schema.md 2.3）ので、時間帯を変えた後も数えない。
- **件数の上限と長さの上限は `nowMin` の時点の値（3.1）。**
- **開始時刻がちょうど `nowMin` の確保は受け付ける。** すぐに予約済になり、猶予はその開始時刻から数える（5.1）。
- **開室時間は確かめない（TIM-8）。** 深夜・休日も確保できる。

テストの観点（ルールの層）。時刻は例として `nowMin` = 10:00、上限は初期値（3件、1440分）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| TIM-6（`checkStartNotPast`・`checkEndNotPast`） | 開始 10:00（ちょうど `nowMin`）。終了 10:01 | 開始 9:59。終了 10:00（ちょうど `nowMin`）。どちらも `RULE_PAST` |
| TIM-7, RSV-5（`checkTimeOrder`） | 終了が開始の1分後 | 終了 = 開始、終了 < 開始（`RULE_TIME_ORDER`） |
| RSV-6（`checkLength`） | 1440分ちょうど | 1441分（`RULE_LENGTH`）。上限を 60 に変えた履歴（`effective_at` が `nowMin` ちょうど）では61分を断る（RSV-26 と同じく「以下」で引く） |
| RSV-4（`checkCount`） | 予約済・利用中が2件。予約なしの利用で始めた利用中が3件あっても0件と数える。取消・無断不使用・終了などは数えない。別の機器の予約も合わせて数える | 予約済・利用中が3件（`RULE_COUNT`）。上限を 1 に変えた履歴では1件で断る |
| RSV-3（`checkOverlap`） | 既存 [10:00, 11:00) に対して [11:00, 12:00)、[9:00, 10:00)。既存が取消・無断不使用・終了・管理者による取消・管理者による終了なら同じ時間帯でも受け付ける。`excludeId` の予約は除く | [10:59, 11:30)、[9:00, 10:01)、[10:15, 10:45)（含まれる）、[9:00, 12:00)（含む）、同じ時間帯。既存が利用中でも断る。どれも `RULE_OVERLAP` |
| TIM-8（`checkReserve`） | 深夜 [2:00, 3:00)、休日（日曜日）の時間帯。開室時間で断る段はない | ― |
| RSV-2（`checkReserve`） | すべての段を通る入力 | `user` が `null`（`NOT_FOUND_USER`）。`device` が `null`・削除済み（`NOT_FOUND_DEVICE`） |
| RSV-27（`checkReserve` の順） | ― | `user` が `null` で機器も削除済み → `NOT_FOUND_USER`。過去かつ長さ超え → `RULE_PAST`。終了 = 開始かつ件数超え → `RULE_TIME_ORDER`。長さ超えかつ件数超え → `RULE_LENGTH`。件数超えかつ重なり → `RULE_COUNT`。機器が削除済みかつ過去 → `NOT_FOUND_DEVICE` |

### 6.11 予約なしの利用（`src/rules/reservations.js`。RSV-17, RSV-20, RSV-3, RSV-6, TIM-4, TIM-6）

要件ごとの関数（2）を1つ足す。ほかは 6.10 の関数を使う。

| 関数 | 段 | 確かめること | コード |
| --- | --- | --- | --- |
| `checkVacant(deviceActive, nowMin)` | 8 | `deviceActive` のうち、状態が `reserved`・`in_use` で `r.start_at <= nowMin かつ nowMin < r.end_at` のものが1件もない（RSV-20「現在時刻を含む確保済みの時間帯がない」、TIM-2） | `RULE_DEVICE_BUSY` |

操作ごとの関数：

| 関数 | 引数 |
| --- | --- |
| `checkWalkIn({ user, device, end, nowMin, settings, deviceActive })` | `user`・`device`・`settings`・`deviceActive`：`checkReserve`（6.10）と同じ。`end`：6.8 で直したミリ秒。開始時刻は受け取らない |

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` → `parseDateTime(end)` | `INPUT_ROLE`・`INPUT_STUDENT_ID`・`INPUT_TIME` |
| 2 | `user` が `null` でない → `checkDeviceActive(device)` | `NOT_FOUND_USER` → `NOT_FOUND_DEVICE` |
| 3 | なし（新しく作るので状態がない） | ― |
| 4 | `checkEndNotPast(end, nowMin)` | `RULE_PAST` |
| 5 | なし（下の注） | ― |
| 6 | `checkLength(nowMin, end, settingAt(settings, 'max_length_minutes', nowMin))` | `RULE_LENGTH` |
| 7 | なし（件数に数えない。RSV-17） | ― |
| 8 | `checkVacant(deviceActive, nowMin)` → `checkOverlap(deviceActive, nowMin, end, null)` | `RULE_DEVICE_BUSY` → `RULE_OVERLAP` |

受け付けるときは `{ ok: true, start: nowMin }` を返す（1.1 の「ルールで決まる値」。TIM-4）。`api/` はこの `start` をそのまま `start_at` に書く。

- **開始時刻は `nowMin` で、入力から受け取らない（RSV-17, TIM-4, RSV-24）。** 開始が `nowMin` なので `checkStartNotPast` は必ず通り、呼ばない。
- **段 5 を確かめない。** 開始が `nowMin` なので、段 4 の `end > nowMin` を通れば `end > start` は必ず成り立ち、`RULE_TIME_ORDER` で断ることがない。テストで断る場合を作れない判定を置かない（2026-11-19 に開発者が了承）。
- **RSV-20 を `RULE_OVERLAP` と別のコードにする（2026-11-19 に開発者が了承）。** RSV-20 の条件は `[nowMin, end)` の重なりに含まれるので判定としては `RULE_OVERLAP` だけで足りるが、利用者が「今は使えない」のか「終了時刻を早めれば使える」のかを見分けられるようにする（RSV-27）。空いていないことは終了時刻を変えても直らないので、重なりより先に確かめる。
- **`RULE_DEVICE_BUSY` は `RULE_DEVICE_IN_USE`（MNG-2）と別。** 空いていないのは利用中の予約に限らず、現在時刻を含む予約済（猶予の間で利用開始の前）でも空いていない。
- **自分の予約が現在時刻にかかっていても `RULE_DEVICE_BUSY`。** RSV-3 は同じ人の予約どうしも含む。自分の予約なら利用開始を使う（画面の案内は screens.md）。
- **件数を数えない（RSV-17）。** 利用者の予約は引かず、上限もない。同じ人が別の機器で同時に予約なしの利用をすることは妨げない（RSV-3「別の機器であれば」）。
- **長さの上限は `nowMin` の時点の値（3.1、RSV-6）。**
- **自動の変化を反映した後のデータで判定する（5.3）。** 終了時刻がちょうど `nowMin` の利用中、猶予の終わりがちょうど `nowMin` の予約済は、すでに解放されていて妨げない（RSV-22）。

テストの観点（ルールの層）。時刻は例として `nowMin` = 10:00、長さの上限は初期値（1440分）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| RSV-20（`checkVacant`） | 予約がない。既存 [9:00, 10:00)（ちょうど `nowMin` に終わる）、[10:01, 11:00)。既存 [9:00, 11:00) が取消・無断不使用・終了・管理者による取消・管理者による終了 | 既存 [9:00, 11:00) が利用中、予約済。既存 [10:00, 11:00)（ちょうど `nowMin` に始まる）。どれも `RULE_DEVICE_BUSY` |
| RSV-17（`checkWalkIn`） | すべての段を通る入力で `start` が `nowMin`。終了 10:01 | `user` が `null`（`NOT_FOUND_USER`）。`device` が `null`・削除済み（`NOT_FOUND_DEVICE`） |
| TIM-6（`checkWalkIn`） | 終了 10:01 | 終了 10:00（ちょうど `nowMin`）、9:59。どちらも `RULE_PAST`（`RULE_TIME_ORDER` にならない） |
| RSV-6（`checkWalkIn`） | 終了が翌日 10:00（1440分） | 翌日 10:01（`RULE_LENGTH`） |
| RSV-3（`checkWalkIn`） | 既存の予約済 [10:30, 11:00) に対して終了 10:30 | 同じ既存に対して終了 10:31（`RULE_OVERLAP`）。自分の予約でも断る |
| RSV-17（件数） | 予約済・利用中が上限（3件）ある利用者でも受け付ける | ― |
| RSV-27（`checkWalkIn` の順） | ― | `user` が `null` で機器も削除済み → `NOT_FOUND_USER`。過去かつ空いていない → `RULE_PAST`。長さ超えかつ空いていない → `RULE_LENGTH`。空いていないかつ後の予約とも重なる → `RULE_DEVICE_BUSY` |

### 6.12 自分の予約・取消（`src/rules/reservations.js`。RSV-7, RSV-8）

操作ごとの関数：

| 関数 | 引数 |
| --- | --- |
| `checkMyReservations({ user, userActive })` | `user`：識別の組で引いた利用者（api.md 8.16。なければ `null`）。`userActive`：その利用者の予約済・利用中の全件（全機器。機器の名前を付けたもの。api.md 8.29） |
| `checkCancel({ user, reservation })` | `user`：同じ。`reservation`：store が番号で引いた予約（状態を問わない。なければ `null`） |

`checkMyReservations`：

| 段 | 確かめること・すること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` | `INPUT_ROLE`・`INPUT_STUDENT_ID` |
| 2 | `user` が `null` でない | `NOT_FOUND_USER` |
| ― | `userActive` のうち、状態が `reserved`・`in_use` のものを、開始時刻の順（同じなら番号の順）に並べる | ― |

受け付けるときは `{ ok: true, reservations }` を返す。`reservations` は引数の要素をそのまま並べた配列（6.9 の `daySlots` と同じく、項目は選ばない）。

`checkCancel`：

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` | `INPUT_ROLE`・`INPUT_STUDENT_ID` |
| 2 | `user` が `null` でない → `reservation` が `null` でなく、`reservation.user_id` が `user.id` と同じ | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` |
| 3 | `reservation.status` が `reserved` | `STATE_NOT_RESERVED` |
| 4〜8 | なし（時間帯を解放するだけで、時刻・長さ・件数・重なりに関わらない） | ― |

受け付けるときは `{ ok: true }` を返す（1.1 の「ルールで決まる値」はない）。

- **予約なしの利用で始めたものも一覧に出す（RSV-7）。** RSV-1 で予約は予約なしの利用を含む。利用終了（RSV-18）と終了時刻の変更（RSV-10）をこの一覧から行うので、除くとその入口がなくなる（2026-11-19 に開発者が了承）。
- **一覧でも状態を rules で確かめる。** store は予約済・利用中だけを引くが、一覧に出す状態（RSV-7「予約済・利用中」）は rules が決める（3、6.10 と同じ）。
- **本人の予約でないときは、ないときと同じコード（2）。** 他の利用者の予約の番号を送っても、その予約があるかどうか・状態はわからない。状態の段 3 は本人の予約だとわかった後にだけ確かめる。
- **猶予の中の予約済は取り消せる（RSV-8）。** 開始時刻を過ぎていても、状態が予約済なら受け付ける（domain-model.md「要件の読み方」）。猶予を過ぎた予約は反映した後には無断不使用なので、段 3 で断る（5.3、RSV-22。猶予の終わりがちょうど `nowMin` なら無断不使用が先）。
- **すでに取消の予約、利用中の予約も `STATE_NOT_RESERVED`。** 2回目の取消を成功として返さない。結果の状態が取消とは限らず（無断不使用・管理者による取消もある）、何が起きたかが曖昧になるため（2026-11-19 に開発者が了承）。利用中の予約は利用終了（RSV-18）で終える。
- **削除した機器の予約は考えない。** 機器を削除すると予約済は管理者による取消になり、利用中があれば削除を断る（6.7）ので、予約済・利用中の予約の機器は必ず削除されていない。

テストの観点（ルールの層）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| RSV-7（`checkMyReservations`） | 予約済・利用中（予約なしの利用で始めたものを含む）を開始時刻の順に返す。同じ開始時刻なら番号の順。別の機器の予約も合わせて返す。`userActive` が空なら空の配列。取消・無断不使用・終了などが混ざっていても落とす | `user` が `null`（`NOT_FOUND_USER`） |
| RSV-8（`checkCancel`） | 本人の予約済。開始時刻を過ぎた予約済（猶予の中） | `user` が `null`（`NOT_FOUND_USER`）。`reservation` が `null`、他の利用者の予約（`NOT_FOUND_RESERVATION`）。本人の利用中・取消・無断不使用・終了・管理者による取消・管理者による終了（`STATE_NOT_RESERVED`） |
| RSV-27（`checkCancel` の順） | ― | `user` が `null` で予約も `null` → `NOT_FOUND_USER`。他の利用者の取消済みの予約 → `NOT_FOUND_RESERVATION`（`STATE_` にならない） |

### 6.13 時間帯の変更（`src/rules/reservations.js`。RSV-9〜RSV-12, RSV-3, RSV-6, TIM-6, TIM-7）

要件ごとの関数（2）を2つ足す。ほかは 6.10 の関数を使う。

| 関数 | 段 | 確かめること | コード |
| --- | --- | --- | --- |
| `checkStartNotPassed(oldStart, nowMin)` | 4 | `nowMin < oldStart`（RSV-11「開始時刻を変更する操作は、変更前の開始時刻になる前にだけできる」。TIM-2 と同じく、ちょうど開始時刻の分からは変えられない） | `RULE_START_PASSED` |
| `checkChangeLength(oldStart, oldEnd, newStart, newEnd, limitMinutes)` | 6 | `newEnd − newStart <= limitMinutes × MINUTE_MS`、または `newEnd − newStart <= oldEnd − oldStart`（RSV-12） | `RULE_LENGTH` |

操作ごとの関数：

| 関数 | 引数 |
| --- | --- |
| `checkChange({ user, reservation, start, end, nowMin, settings, deviceActive })` | `user`：識別の組で引いた利用者（api.md 8.16。なければ `null`）。`reservation`：store が番号で引いた予約（状態を問わない。なければ `null`）。`start`・`end`：6.8 で直した、変更後の開始・終了のミリ秒（変えない側は今と同じ値）。`settings`：数値の履歴の全件（3.1）。`deviceActive`：その予約の機器の予約済・利用中の全件（その予約自身を含む） |

下の表で、`r` は `reservation`、「開始を変える」は `start !== r.start_at`、「終了を変える」は `end !== r.end_at` をいう（下の「要件の読み方」）。

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` → `parseDateTime(start)` → `parseDateTime(end)` | `INPUT_ROLE`・`INPUT_STUDENT_ID`・`INPUT_TIME` |
| 2 | `user` が `null` でない → `r` が `null` でなく、`r.user_id` が `user.id` と同じ（6.12 の `checkCancel` と同じ） | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` |
| 3 | `r.status` が `reserved`・`in_use` のどちらか | `STATE_NOT_ACTIVE` |
| 4 | 開始を変えるなら `checkStartNotPassed(r.start_at, nowMin)` → `checkStartNotPast(start, nowMin)`。終了を変えるなら `checkEndNotPast(end, nowMin)` | `RULE_START_PASSED` → `RULE_PAST` |
| 5 | `checkTimeOrder(start, end)`（変えない側の今の値と合わせて比べる） | `RULE_TIME_ORDER` |
| 6 | `checkChangeLength(r.start_at, r.end_at, start, end, settingAt(settings, 'max_length_minutes', nowMin))` | `RULE_LENGTH` |
| 7 | なし（件数を理由に断らない。RSV-12） | ― |
| 8 | `checkOverlap(deviceActive, start, end, r.id)` | `RULE_OVERLAP` |

受け付けるときは `{ ok: true, action }` を返す。`action` は、開始も終了も変えないなら `unchanged`、そうでなければ `change`。`api/` は `change` のときだけ `start`・`end` をそのまま `start_at`・`end_at` に書く（api.md 8.32）。

- **利用中の予約の開始の変更は `RULE_START_PASSED` で断る（RSV-10）。** 利用中の予約の開始時刻は必ず `nowMin` 以下になっている（利用開始は開始時刻より前なら `nowMin` にし（RSV-15）、予約なしの利用は `nowMin` から始める（RSV-17））。このため RSV-11 の開始の条件だけで、RSV-10「利用中は終了時刻だけ」が守られる。状態ごとに別の判定を置かない（2026-11-19 に開発者が了承）。
- **猶予の中の予約済（開始時刻を過ぎている）も、開始は `RULE_START_PASSED` で断り、終了だけは変えられる。** 開始を今と同じ値で送れば「変えない時刻」になる（下の「要件の読み方」）。
- **`RULE_START_PASSED` を `RULE_PAST` と分ける（2026-11-19 に開発者が了承）。** `RULE_PAST` は新しい時刻が過去のときで、入力を直せば通る。`RULE_START_PASSED` は変更前の開始時刻を過ぎているときで、どう入力しても開始は変えられない。利用者が見分けられるようにする（RSV-27）。どう入力しても直らないものを先に確かめる。
- **状態のコードは `STATE_NOT_RESERVED` を使わず `STATE_NOT_ACTIVE` にする（2026-11-19 に開発者が了承）。** 利用中も受け付けるので、「予約済でない」という意味と合わない。
- **RSV-11 の終了の条件（変更前の終了時刻になる前）は確かめない（2026-11-19 に開発者が了承）。** 自動の変化を反映した後のデータ（5.3）では、終了時刻が `nowMin` 以下の利用中はすでに終了になっている。予約済は `min(開始 + 猶予, 終了)` で無断不使用になるので、終了時刻が `nowMin` 以下の予約済も残っていない。段 3 を通った予約は必ず `nowMin < r.end_at` で、断る場合をテストで作れない（6.11 の段 5 と同じ考え方）。
- **段 5 は確保と同じ関数を、変えない側の今の値と合わせて呼ぶ。** 利用中で終了だけを変えるときは、開始が `nowMin` 以下で段 4 で `end > nowMin` を確かめているので必ず通るが、予約済では断る場合がある（開始を終了より後へずらすなど）ので、状態で分けずに呼ぶ。
- **長さ（RSV-12）。** 上限は `nowMin` の時点の値（3.1）。上限を下げた後でも、変更前より長くしなければ受け付ける（短くする・ずらす）。上限を超えていても変更前の長さ以下なら受け付ける。
- **件数を数えない（RSV-12）。** 利用者の予約は引かない。`walk_in` は変えないので、予約なしの利用で始めたものは変更後も件数に数えない（RSV-17。6.10）。
- **重なりは、その予約自身を除いて確かめる（RSV-11「変更後の時間帯にも RSV-3 を適用する」）。** 同じ人の別の予約との重なりも断る（RSV-3）。
- **猶予は変更後の開始時刻の時点の値になる（RSV-26）。** 猶予は確保の時点で写さず、`dueTransitions`（5.1）が `start_at` から引く（domain-model.md）ので、開始を変えれば自然に変わる。終了を早めて `開始 + 猶予` より前にした予約済は、その終了時刻に無断不使用になる（RSV-16）。
- **機器は変えない（RSV-9）。** 機器を受け取らない。予約済・利用中の予約の機器は削除されていない（6.12）ので、機器を確かめない。
- **両方とも変えないときも段 3〜8 を確かめる。** 段 2・3 を通った今の時間帯は、段 4〜8 を必ず通る（開始・終了は変えないので段 4 はなく、今の時間帯は終了 > 開始で、長さは変更前以下で、ほかの確保中の予約と重ならない）。`unchanged` のための分岐を判定の途中に置かない。
- **同時の操作（RSV-23）。** 判定から書き込みまでの間に `await` がないので割り込まれない（api.md 8.32）。

テストの観点（ルールの層）。時刻は例として `nowMin` = 10:00、長さの上限は初期値（1440分）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| RSV-11（`checkStartNotPassed`） | 変更前の開始 10:01 | 変更前の開始 10:00（ちょうど `nowMin`）、9:59。どちらも `RULE_START_PASSED` |
| RSV-12（`checkChangeLength`） | 新しい長さが1440分ちょうど。上限を 60 に変えた履歴で、変更前 120分 → 変更後 120分（ずらす）・90分。変更前 30分 → 変更後 60分 | 上限 60 で、変更前 30分 → 変更後 61分。変更前 120分 → 変更後 121分。どちらも `RULE_LENGTH` |
| RSV-9（`checkChange`、予約済） | 予約済 [11:00, 12:00) を [13:00, 14:00)、[10:00, 11:00)（開始がちょうど `nowMin`）、[11:00, 12:30)、[11:30, 12:00) に。戻り値は `change`。両方とも今と同じなら `unchanged` | `user` が `null`（`NOT_FOUND_USER`）。`r` が `null`、他の利用者の予約（`NOT_FOUND_RESERVATION`） |
| RSV-9（状態） | 予約済、利用中 | 取消・無断不使用・終了・管理者による取消・管理者による終了（`STATE_NOT_ACTIVE`） |
| RSV-10（`checkChange`、利用中） | 利用中 [9:00, 11:00) の終了を 12:00（延長）、10:01（短縮）に。予約なしの利用で始めたもの（`walk_in = 1`）でも同じ | 開始を 9:30 に（`RULE_START_PASSED`）。終了を 10:00（ちょうど `nowMin`）に（`RULE_PAST`） |
| RSV-11（猶予の中の予約済） | 予約済 [9:55, 11:00) の終了を 11:30 に（開始は今と同じ） | 開始を 10:05 に（`RULE_START_PASSED`。新しい開始が未来でも断る） |
| TIM-6（`checkChange`） | 開始を `nowMin` ちょうどに。終了を 10:01 に | 予約済 [11:00, 12:00) の開始を 9:59 に、終了を 10:00 に（どちらも `RULE_PAST`） |
| TIM-7（`checkChange`） | 開始だけを終了の1分前に | 予約済 [11:00, 12:00) の開始だけを 12:00 に、12:30 に（変えない終了と合わせて `RULE_TIME_ORDER`） |
| RSV-12（件数） | 予約済・利用中が上限（3件）ある利用者の予約の変更も受け付ける | ― |
| RSV-3（`checkChange`） | 既存 [12:00, 13:00) に対して [11:00, 12:00) を [11:00, 12:00) のまま・[11:30, 12:00) に。自分自身との重なりは数えない（[11:00, 12:00) → [10:30, 11:30) で、元の自分と重なっても受け付ける） | 同じ既存に対して [11:00, 12:01) に（`RULE_OVERLAP`）。既存が自分の別の予約でも断る。利用中の延長が後の予約と重なるときも断る |
| RSV-27（`checkChange` の順） | ― | `user` が `null` で予約も `null` → `NOT_FOUND_USER`。他の利用者の取消済みの予約 → `NOT_FOUND_RESERVATION`。本人の取消済みの予約で新しい開始も過去 → `STATE_NOT_ACTIVE`。利用中で開始も過去に → `RULE_START_PASSED`（`RULE_PAST` にならない）。過去かつ長さ超え → `RULE_PAST`。終了 ≤ 開始かつ重なり → `RULE_TIME_ORDER`。長さ超えかつ重なり → `RULE_LENGTH` |

### 6.14 利用開始（`src/rules/reservations.js`。RSV-14〜RSV-16, RSV-6, TIM-4）

要件ごとの関数（2）を2つ足す。条件は 6.10 の関数と同じで、返すコードが違う（実装では 6.10 の関数を呼び、断ったときにコードを置き換えてよい）。

| 関数 | 段 | 確かめること | コード |
| --- | --- | --- | --- |
| `checkBeginLength(nowMin, end, limitMinutes)` | 6 | `checkLength(nowMin, end, limitMinutes)` と同じ（RSV-6「開始時刻より前の利用開始（RSV-15）」、RSV-15「変更後の長さにも上限を適用する」） | `RULE_BEGIN_LENGTH` |
| `checkBeginOverlap(deviceActive, nowMin, start, excludeId)` | 8 | `checkOverlap(deviceActive, nowMin, start, excludeId)` と同じ。`[nowMin, 開始)` に、その予約を除く予約済・利用中がない（RSV-15「現在時刻から開始時刻までの間に、同じ機器を確保している他の予約がない」、TIM-2） | `RULE_BEGIN_OVERLAP` |

操作ごとの関数：

| 関数 | 引数 |
| --- | --- |
| `checkBegin({ user, reservation, nowMin, settings, deviceActive })` | `user`：識別の組で引いた利用者（api.md 8.16。なければ `null`）。`reservation`：store が番号で引いた予約（状態を問わない。なければ `null`）。`settings`：数値の履歴の全件（3.1）。`deviceActive`：その予約の機器の予約済・利用中の全件（その予約自身を含む） |

下の表で、`r` は `reservation`、「前倒し」は `nowMin < r.start_at` をいう。

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` | `INPUT_ROLE`・`INPUT_STUDENT_ID` |
| 2 | `user` が `null` でない → `r` が `null` でなく、`r.user_id` が `user.id` と同じ（6.12 の `checkCancel` と同じ） | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` |
| 3 | `r.status` が `reserved` | `STATE_NOT_RESERVED` |
| 4・5 | なし（下の注） | ― |
| 6 | 前倒しのときだけ `checkBeginLength(nowMin, r.end_at, settingAt(settings, 'max_length_minutes', nowMin))` | `RULE_BEGIN_LENGTH` |
| 7 | なし（件数は変わらない。予約済も利用中も RSV-4 で数える） | ― |
| 8 | 前倒しのときだけ `checkBeginOverlap(deviceActive, nowMin, r.start_at, r.id)` | `RULE_BEGIN_OVERLAP` |

受け付けるときは `{ ok: true, start }` を返す（1.1 の「ルールで決まる値」。RSV-15, TIM-4）。`start` は、前倒しなら `nowMin`、そうでなければ `r.start_at`。`api/` はこの `start` をそのまま `start_at` に書く（api.md 8.34）。

- **段 4・5 を確かめない。** 自動の変化を反映した後のデータ（5.3）では、予約済は必ず `nowMin < min(開始 + 猶予, 終了)` になっている（5.1）。このため、猶予のうち（RSV-13）であること、猶予より短い予約では終了時刻まで（RSV-16）であること、終了 > `nowMin` は、段 3 を通れば必ず成り立つ。前倒しでも、新しい開始 `nowMin` は今の開始より前なので、終了 > 開始は必ず成り立つ。断る場合をテストで作れない判定を置かない（6.11 の段 5、6.13 の RSV-11 の終了の条件と同じ考え方）。
- **状態のコードは `STATE_NOT_RESERVED` を使う（2026-11-19 に開発者が了承）。** 利用開始できるのは予約済だけで、意味がそのまま合う。2回目の利用開始（すでに利用中）も成功として返さず、これで断る（6.12 の取消と同じ）。
- **前倒しでないとき（開始時刻ちょうど、猶予のうち）は、時刻を変えず段 6・8 を確かめない。** 時間帯は確保したときのままで、長さも重なりも変わらない。上限を下げた後でも、確保済みの予約は開始時刻を過ぎれば利用開始できる（RSV-25「すでに確保された予約は、数値の変更によって取り消されない」）。
- **前倒しの長さは RSV-12 の緩和を使わない。** RSV-6 は前倒し（RSV-15）を、時間帯の変更（「ただし RSV-12 による」）と別に挙げているので、`nowMin` の時点の上限以下であることだけを確かめる。上限ちょうどの予約は前倒しできず、開始時刻まで待てば始められる。
- **前倒しを断るコードを 6.10 のものと分ける（2026-11-19 に開発者が了承）。** 確保の `RULE_OVERLAP`・`RULE_LENGTH` は「時刻を直せば通る」ものだが、利用開始には入力がなく、「開始時刻まで待てば始められる」という意味になる。画面がコードだけで文を決められるように分ける（`RULE_DEVICE_BUSY`・`RULE_START_PASSED` と同じ考え方）。重なりと長さで別のコードにし、どちらのルールで断ったかをテストで確かめられるようにする（RSV-27）。
- **前倒しに「何分前から」の制限を置かない（2026-11-19 に開発者が了承）。** 要件にない。長さの上限（段 6）があるので、前倒しできるのは `nowMin` が「終了 − 上限」以降のときに限られる。
- **重なりは `[nowMin, 開始)` だけを見る（RSV-15 の書き方どおり）。** `[開始, 終了)` は確保・変更の時点で重ならないことを確かめてあるので、`[nowMin, 終了)` を見ても結果は同じ。同じ人の予約も「他の予約」として断る（RSV-3）。終了時刻がちょうど `nowMin` の予約は、反映した後には解放されていて妨げない（RSV-22）。
- **猶予は書き換えた開始時刻の時点の値になる。** 利用中になるので猶予はもう使わない（5.1 は利用中を終了時刻で見る）。
- **`walk_in` は変えない。** 予約で始めたものは、利用中になっても件数に数える（RSV-5）。
- **機器は確かめない。** 予約済の予約の機器は削除されていない（6.12）。

テストの観点（ルールの層）。時刻は例として `nowMin` = 10:00、長さの上限は初期値（1440分）：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| RSV-14（`checkBegin`） | 本人の予約済 [10:00, 11:00)（開始ちょうど）→ `start` は 10:00。[9:50, 11:00)（猶予のうち）→ `start` は 9:50 のまま | `user` が `null`（`NOT_FOUND_USER`）。`r` が `null`、他の利用者の予約（`NOT_FOUND_RESERVATION`） |
| RSV-14（状態） | 予約済 | 利用中（予約なしの利用で始めたものを含む）・取消・無断不使用・終了・管理者による取消・管理者による終了（`STATE_NOT_RESERVED`） |
| RSV-15（`checkBegin`） | 予約済 [10:30, 11:00) → `start` は 10:00。既存 [9:00, 10:00)（ちょうど `nowMin` に終わる）があっても受け付ける。既存 [10:00, 10:30) が取消・無断不使用・終了・管理者による取消・管理者による終了、または別の機器なら受け付ける | 既存 [10:00, 10:30)・[10:10, 10:20) の予約済、[9:00, 10:15) の利用中（どれも `RULE_BEGIN_OVERLAP`）。既存が同じ人の予約でも断る |
| RSV-15（`checkBeginOverlap`） | `[nowMin, 開始)` に重なる予約がない。`excludeId` の予約は除く | 1分でも重なる（[10:29, 10:30) に対して開始 10:30）。`RULE_BEGIN_OVERLAP` |
| RSV-6（`checkBeginLength`） | 予約済 [10:30, 翌 10:00) の前倒し（1440分ちょうど） | [10:30, 翌 10:01) の前倒し（1441分。`RULE_BEGIN_LENGTH`）。上限を 60 に変えた履歴（`effective_at` が `nowMin`）で [10:30, 11:01) の前倒し |
| RSV-6, RSV-25（前倒しでない） | 上限を 60 に変えた履歴で、確保済みの [10:00, 12:00)（120分）を開始ちょうどに利用開始 | ― |
| RSV-16（`checkBegin`） | 猶予 15分で [9:55, 10:05)（猶予より短い）の予約済を 10:00 に利用開始（反映した後のデータとして渡す） | ― |
| RSV-27（`checkBegin` の順） | ― | `user` が `null` で予約も `null` → `NOT_FOUND_USER`。他の利用者の利用中の予約 → `NOT_FOUND_RESERVATION`。本人の利用中で、前倒しなら重なる既存がある → `STATE_NOT_RESERVED`。長さ超えかつ重なり → `RULE_BEGIN_LENGTH` |

### 6.15 利用終了（`src/rules/reservations.js`。RSV-18, RSV-19, TIM-4, TIM-7）

操作ごとの関数だけを足す（要件ごとの関数は状態の確かめだけで、段 3 に書く）。

| 関数 | 引数 |
| --- | --- |
| `checkFinish({ user, reservation, nowMin })` | `user`・`reservation`：`checkBegin`（6.14）と同じ |

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | （`api/` が先に確かめる）`validateRole` → `validateStudentId` | `INPUT_ROLE`・`INPUT_STUDENT_ID` |
| 2 | `user` が `null` でない → `r` が `null` でなく、`r.user_id` が `user.id` と同じ（6.12 の `checkCancel` と同じ） | `NOT_FOUND_USER` → `NOT_FOUND_RESERVATION` |
| 3 | `r.status` が `in_use` | `STATE_NOT_IN_USE` |
| 4〜8 | なし（下の注） | ― |

受け付けるときは `{ ok: true, end: nowMin }` を返す（1.1 の「ルールで決まる値」。RSV-18, TIM-4）。`api/` はこの `end` をそのまま `end_at` に書く（api.md 8.35）。

- **段 4 を確かめない。** 反映した後のデータ（5.3）では、終了時刻が `nowMin` 以下の利用中はすでに終了になっている（RSV-19）。段 3 を通った利用中は必ず `nowMin < r.end_at` で、新しい終了 `nowMin` は今の終了より前になる。
- **段 5 を当てはめない（TIM-7、4 の注）。** 利用中の開始は必ず `nowMin` 以下なので、新しい終了 `nowMin` は開始以上になる。開始と同じ分に終えたら長さ0（開始 = 終了）になり、それを認める。
- **段 6〜8 はない。** 時間帯を縮めるだけで、長さ・件数・重なりは悪くならない。
- **予約なしの利用で始めたものも同じ（RSV-17「利用中の予約として扱う」）。**
- **状態のコードは新しく `STATE_NOT_IN_USE` にする。** 基本設計（screens-and-api.md 7）で例に挙げた名前。予約済の利用終了、2回目の利用終了（すでに終了）もこれで断る。
- **管理者による終了（MNG-3）は別の関数にする。** 本人のものかの確かめ（段 2）がなく、`cause` を書く（6.16 の `checkAdminFinish`）。

テストの観点（ルールの層）。時刻は例として `nowMin` = 10:00：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| RSV-18（`checkFinish`） | 本人の利用中 [9:00, 11:00) → `end` は 10:00。予約なしの利用で始めたもの（`walk_in = 1`）も同じ | `user` が `null`（`NOT_FOUND_USER`）。`r` が `null`、他の利用者の予約（`NOT_FOUND_RESERVATION`） |
| TIM-7（`checkFinish`） | 利用中 [10:00, 11:00)（同じ分に始めた）→ `end` は 10:00（長さ0） | ― |
| RSV-18（状態） | 利用中 | 予約済・取消・無断不使用・終了・管理者による取消・管理者による終了（`STATE_NOT_IN_USE`） |
| RSV-27（`checkFinish` の順） | ― | `user` が `null` で予約も `null` → `NOT_FOUND_USER`。他の利用者の終了済みの予約 → `NOT_FOUND_RESERVATION`（`STATE_` にならない） |

### 6.16 予約の管理（`src/rules/admin-reservations.js`。MNG-3, TIM-4, TIM-7）

操作ごとの関数だけを足す（要件ごとの関数は、機器の確かめ（6.9 の `checkDeviceActive`）と状態の確かめだけ）。

| 関数 | 引数 |
| --- | --- |
| `checkDeviceReservations({ device, deviceActive })` | `device`：store が番号で引いた機器の行（削除した行も含む。なければ `null`）。`deviceActive`：その機器の予約済・利用中の全件（利用者の `role`・`student_id`・`name` を付けたもの。api.md 8.37） |
| `checkAdminCancel({ reservation })` | `reservation`：store が番号で引いた予約（状態を問わない。なければ `null`） |
| `checkAdminFinish({ reservation, nowMin })` | `reservation`：同じ |

`checkDeviceReservations`：

| 段 | 確かめること・すること | コード |
| --- | --- | --- |
| 1 | なし（パスの `{id}` の形は共1） | ― |
| 2 | `checkDeviceActive(device)`（6.9） | `NOT_FOUND_DEVICE` |
| ― | `deviceActive` のうち、状態が `reserved`・`in_use` のものを、開始時刻の順（同じなら番号の順）に並べる | ― |

受け付けるときは `{ ok: true, reservations }` を返す。`reservations` は引数の要素をそのまま並べた配列（6.12 の `checkMyReservations` と同じく、項目は選ばない）。

`checkAdminCancel`：

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | なし（本文は `{}`） | ― |
| 2 | `reservation` が `null` でない | `NOT_FOUND_RESERVATION` |
| 3 | `reservation.status` が `reserved` | `STATE_NOT_RESERVED` |
| 4〜8 | なし（時間帯を解放するだけ。6.12 の `checkCancel` と同じ） | ― |

受け付けるときは `{ ok: true }` を返す。

`checkAdminFinish`：

| 段 | 確かめること | コード |
| --- | --- | --- |
| 1 | なし（本文は `{}`） | ― |
| 2 | `reservation` が `null` でない | `NOT_FOUND_RESERVATION` |
| 3 | `reservation.status` が `in_use` | `STATE_NOT_IN_USE` |
| 4〜8 | なし（6.15 の `checkFinish` と同じ理由） | ― |

受け付けるときは `{ ok: true, end: nowMin }` を返す（1.1 の「ルールで決まる値」。MNG-3「終了時刻は操作した時刻を秒で切り捨てたもの」、TIM-4）。`api/` はこの `end` をそのまま `end_at` に書く（api.md 8.39）。

- **本人のものかを確かめない。** 管理者はどの利用者の予約も取り消し・終了できる（MNG-3）。段 2 は予約があるかだけを見る。
- **状態のコードは利用者の操作と同じ `STATE_NOT_RESERVED`・`STATE_NOT_IN_USE` を使う（2026-11-19 に開発者が了承）。** 取り消せるのは予約済だけ、終了させられるのは利用中だけで、意味がそのまま合う。2回目の取消・終了も成功として返さない（6.12 と同じ）。
- **猶予の中の予約済は取り消せる。** 猶予を過ぎた予約は反映した後には無断不使用なので、段 3 で断る（5.3、RSV-22）。終了時刻がちょうど `nowMin` の利用中は自動で終了になっていて、終了は `STATE_NOT_IN_USE` になる。
- **長さ0を認める（TIM-7）。** 同じ分に始めた利用中を終了させると `start_at = end_at` になる。段 5 を当てはめない（4 の注）。
- **削除した機器の予約は考えない。** 予約済・利用中の予約の機器は必ず削除されていない（6.12）。取消・終了では機器を確かめない。
- **予約は番号だけで指す。** 一覧（`checkDeviceReservations`）は機器ごとだが、取消・終了は機器の番号を受け取らない（screens-and-api.md 5 の経路）。
- **一覧は機器の存在を段 2 で確かめる。** 削除した機器は `NOT_FOUND_DEVICE`（6.9 の予約状況と同じ）。画面は機器の一覧を読み直す。

テストの観点（ルールの層）。時刻は例として `nowMin` = 10:00：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| MNG-3（`checkDeviceReservations`） | 予約済・利用中（予約なしの利用で始めたものを含む）を開始時刻の順に返す。同じ開始時刻なら番号の順。異なる利用者の予約を合わせて返す。`deviceActive` が空なら空の配列。取消・無断不使用・終了などが混ざっていても落とす | `device` が `null`、削除した機器（`NOT_FOUND_DEVICE`） |
| MNG-3（`checkAdminCancel`） | 予約済（どの利用者のものでも）。開始時刻を過ぎた予約済（猶予の中） | `null`（`NOT_FOUND_RESERVATION`）。利用中・取消・無断不使用・終了・管理者による取消・管理者による終了（`STATE_NOT_RESERVED`） |
| MNG-3, TIM-4（`checkAdminFinish`） | 利用中 [9:00, 11:00) → `end` は 10:00。予約なしの利用で始めたもの（`walk_in = 1`）も同じ | `null`（`NOT_FOUND_RESERVATION`）。予約済・取消・無断不使用・終了・管理者による取消・管理者による終了（`STATE_NOT_IN_USE`） |
| TIM-7（`checkAdminFinish`） | 利用中 [10:00, 11:00)（同じ分に始めた）→ `end` は 10:00（長さ0） | ― |

### 6.17 数値の変更（`src/lib/`・`src/rules/settings.js`。RSV-25, RSV-26）

数値の項目の一覧（`max_count`・`grace_minutes`・`max_length_minutes`。schema.md 2.4）は `src/rules/settings.js` に定数 `SETTING_KEYS` として1か所に置き、`api/` の共4（`key` が一覧のどれかか）と store が使う。

段 1（`src/lib/`。1.2 の形）：

| 関数 | 手順 | `value` | コード |
| --- | --- | --- | --- |
| `validateSettingValue(key, v)` | (1) `Number.isSafeInteger(v)` が真で、1以上か確かめる。(2) `key` が `grace_minutes`・`max_length_minutes`（分）なら、さらに `Number.isSafeInteger(v * 60000)` が真か確かめる | `v` | `INPUT_SETTING_VALUE` |

- **条件は要件の「1以上の整数」だけで、実用上の上限は置かない（RSV-25 の表）。** 上限を置くと要件にない条件になる。
- **計算が正しく行える範囲を事実上の上限にする。** 件数は `Number.isSafeInteger` の範囲（6.4 の期生と同じ考え方）。分の2つは、ミリ秒に直して時刻に足す（5.1、6.10）ので、ミリ秒にしても正確に扱える範囲に限る。design-values.md には足さない（要件で「設計で定める」とされた値ではない）。
- `v` が数値でないとき（文字列、`null`、ない）は、この関数より前の共4 で `INPUT_BODY` にする（api.md 8.42）。小数・0・負の数・範囲を超える数は、ここで `INPUT_SETTING_VALUE`。

操作ごとの関数（`src/rules/settings.js`）：

| 関数 | 引数 |
| --- | --- |
| `currentSettings(settings, nowMin)` | `settings`：数値の履歴の全件（3.1） |
| `decideSettingChange({ settings, key, value, nowMin })` | `settings`：同じ。`key`：`SETTING_KEYS` のどれか（共4 で確かめ済み）。`value`：段 1 を通った値 |

- `currentSettings` は `{ max_count, grace_minutes, max_length_minutes }` を返す。それぞれ `settingAt(settings, key, nowMin)`。判定はなく、`{ ok }` の形にしない（GET の応答を組むためだけの関数）。
- `decideSettingChange` は段 2〜8 に当たる判定がなく、断らない。`{ ok: true, action, before }` を返す。`before` は `settingAt(settings, key, nowMin)`、`action` は `before === value` なら `unchanged`、違えば `change`。

決めたことと理由：

- **有効になる時刻は `nowMin`（RSV-26）。** `api/` は `change` のとき `effective_at = nowMin` の行を足す（api.md 8.42）。変更の前に自動の変化を反映するので、`nowMin` 以下に起きる変化は前の値で確定している（RSV-22「同じ時刻では自動の変化が先」）。
- **猶予の変更が効くのは、開始時刻が `nowMin` 以降の予約だけ（RSV-26）。** 猶予は開始時刻の時点の値で引く（3.1）ので、開始を過ぎた予約は前の値のまま、開始が `nowMin` ちょうどの予約は変更後の値になる（`settingAt` が「以下」で引く）。このための処理は足さない。
- **確保済みの予約には手を付けない（RSV-25）。** 件数・長さの上限を下げても、すでに確保した予約は取り消さず、上限を超えていても残る。利用開始は前倒しのときだけ長さを確かめ（6.14）、時間帯の変更は RSV-12 で緩める（6.13）ので、確保済みの予約はそのまま使える。下げた後の件数を超えている利用者は、件数が減るまで新しく確保できない（6.10 の段 7）。
- **同じ値への変更は `unchanged`。** 行も記録も足さない（6.5・6.7 の `unchanged` と同じ）。
- **同じ分の中で2回変えたとき。** `effective_at` が同じ行が2つでき、番号の大きい行が勝つ（3.1）。その分の中で前の行が効いた変化はない（猶予の終わりは開始時刻より後。5.2）ので、食い違わない。記録には2回とも残る。

テストの観点：

| ID | 受け付ける | 断る |
| --- | --- | --- |
| RSV-25（`validateSettingValue`、部品の層） | 1、3、`Number.MAX_SAFE_INTEGER`（`max_count`）、`Math.floor(Number.MAX_SAFE_INTEGER / 60000)`（分の2つ） | 0、−1、1.5、`NaN`、`Infinity`、`Number.MAX_SAFE_INTEGER + 1`（`max_count`）、`Math.floor(Number.MAX_SAFE_INTEGER / 60000) + 1`（分の2つ）。どれも `INPUT_SETTING_VALUE` |
| RSV-25（`currentSettings`） | 初期データの3行だけなら 3・15・1440。変更の行があれば、`nowMin` の時点の値 | ― |
| RSV-25（`decideSettingChange`） | 違う値は `change` で `before` は今の値。同じ値は `unchanged` | ―（断らない） |
| RSV-26（`decideSettingChange`） | `effective_at` がちょうど `nowMin` の行があれば、その値を `before` にする。同じ `effective_at` の行が2つなら、番号の大きい行の値 | ― |

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
| 機器の名前を `toHalfWidthLower` でそろえて比べる（比べる列を足す） | どこまでを同じとみなすかを新しく決めることになり、機器を足すのは管理者だけで得るものが小さい（6.7） |
| 機器の名前の上限を50などにする | 名前（USR-5）と別の値になり、画面の幅も考え直すことになる（6.6） |
| 機器の名前は前後の空白を除くことと長さだけを確かめる | 改行や制御文字が選択肢・記録に入り、表示が崩れる（6.6） |
| 削除で取り消す予約を `api/` が選ぶ | MNG-2 の判定が `api/` に入る（6.7） |
| 時刻の形式を正規表現だけで確かめる | `02-30` や `24:00` を `Date.UTC` が繰り上げて受け付けてしまう（6.8） |
| 日の誤りも `INPUT_TIME` にまとめる | 予約状況の日と確保の時刻は別の欄で、画面の文を出し分けられない（6.8） |
| 予約状況で、表示する状態を store の SQL で絞る | VIW-1 の判定が SQL に入り、DB なしで確かめられない（3、6.9） |
| 長さ0の利用を重なりの式どおりどの日にも出さない | 0:00 ちょうどに始めて終えた利用が表示されず、VIW-1「利用があった予約も表示する」に反する（6.9） |
| 台帳が空きの時間帯も計算して返す | 表示のためだけの値で、確保できるかは段 8 で決まる。画面がすき間から描けば足りる（6.9） |
| `RULE_PAST` を開始と終了で分ける | 画面は入力と `now` からどちらの欄かわかる。コードが増えるだけ（6.10） |
| RSV-20 を `RULE_OVERLAP` にまとめる | 利用者が、今は使えないのか、終了時刻を早めれば使えるのかを見分けられない（6.11） |
| 予約なしの利用でも段 5（`RULE_TIME_ORDER`）を確かめる | 段 4 を通れば必ず成り立ち、断る場合をテストで作れない（6.11） |
| 自分の予約の一覧から予約なしの利用で始めたものを除く | RSV-10・RSV-18 の操作の入口がなくなる（6.12） |
| すでに取消の予約への取消を成功として返す | 結果の状態が取消とは限らず、何が起きたかが曖昧になる（6.12） |
| 利用中の予約の開始の変更を、段 3 で別のコード（`STATE_IN_USE` など）で断る | 利用中の開始は必ず `nowMin` 以下なので、RSV-11 の開始の条件で断れる。判定が RSV-10 と RSV-11 の2か所に分かれる（6.13） |
| 変更前の開始時刻を過ぎているときも `RULE_PAST` にまとめる | 入力を直せば通るのか、開始そのものを変えられないのかを利用者が見分けられない（6.13） |
| 時間帯の変更の状態の誤りに `STATE_NOT_RESERVED` を使う | 利用中も受け付けるので、「予約済でない」という意味と合わない（6.13） |
| RSV-11 の終了の条件（変更前の終了時刻になる前）も段 4 で確かめる | 自動の変化を反映した後には必ず成り立ち、断る場合をテストで作れない（6.13） |
| 両方とも変えないときは段 3 以降を確かめずに `unchanged` を返す | 今の時間帯は段 4〜8 を必ず通るので、分岐を足しても結果が変わらない（6.13） |
| 前倒しの利用開始で断るときに `RULE_OVERLAP`・`RULE_LENGTH` を使う | 確保では「時刻を直せば通る」、利用開始では「開始時刻まで待てば始められる」と、同じコードで直し方が変わる。画面がコードだけで文を決められず、操作とコードの組で文を引く仕組みが要る（6.14） |
| 前倒しの利用開始で断るときのコードを1つにまとめる | 重なりと長さのどちらで断ったかをコードで見分けられず、RSV-27 のテストで確かめられない（6.14） |
| 前倒しの利用開始の長さに RSV-12 の緩和（変更前の長さ以下なら受け付ける）を当てはめる | RSV-6 は前倒し（RSV-15）を時間帯の変更（RSV-12 による）と別に挙げている（6.14） |
| 前倒しの利用開始に「何分前から」の制限を置く | 要件にない。長さの上限があるので、前倒しは終了時刻の上限の長さ前までに収まる（6.14） |
| 2回目の利用開始を成功として返す | 取消と同じく、何が起きたかが曖昧になる（6.12、6.14） |
| 利用終了で段 4（終了時刻を過ぎていないか）を確かめる | 反映した後には、終了時刻が `nowMin` 以下の利用中は残っていない。断る場合をテストで作れない（6.15） |
| 管理者による取消・終了の状態の誤りに、新しいコード（`STATE_ADMIN_*` など）を使う | 利用者の操作と意味が同じで、コードが増えるだけ（6.16） |
| 管理者による取消・終了を、利用者の `checkCancel`・`checkFinish` に「管理者なら段 2 を飛ばす」引数を足して兼ねる | 本人の確かめの有無が引数の値しだいになり、テストで両方の組み合わせを確かめることになる。関数が短いので分けたほうが読みやすい（6.16） |
| 数値に実用上の上限（猶予は1440分までなど）を置く | 要件の条件は「1以上の整数」だけで、要件にない条件になる（6.17） |
| 数値の値の型の誤り（文字列など）も `INPUT_SETTING_VALUE` にする | 値はどの項目でも必ず数値で、型の誤りは `INPUT_BODY` という決まり（error-codes.md 3.1）とそろえる。期生は要るかどうかが変わるので例外にした（6.4）が、ここでは当たらない（6.17） |

## 要件の読み方（確認済み）

- **RSV-11・TIM-6 の「変更する時刻」。** 時間帯の変更の API は開始と終了の両方を受け取る。今と同じ値を送った側は「変更しない時刻」とみなし、TIM-6・RSV-11 を当てはめない。このため、開始時刻を過ぎた予約済の予約でも、終了時刻だけを変えられる。2026-11-19 に開発者が確認した。採らなかった読み方：変える側だけを送らせ、送られた時刻にはすべて当てはめる（画面が変えた欄を見分ける必要があり、API の入力の形が変わる）。

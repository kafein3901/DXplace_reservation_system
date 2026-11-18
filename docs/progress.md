# 進捗と引き継ぎ

セッションを終える前（`/clear` の前）に更新し、次のセッションはここから読み始める。決定の中身は設計文書に書き、ここには「どこまで進んだか」「次に何をするか」「保留していること」だけを書く。

最終更新：2026-11-17

## いまの段階

**基本設計と、そのレビューが終わった。** 基本設計の文書（下の表）がすべて決定になり、2026-11-17 のレビューで見つけたものを直した（下の「レビューで変えたこと」）。

**基盤の実測を 2026-11-17 に行った（設計文書への反映待ち）。** 結果は下の「基盤の実測の結果」。PBKDF2 の反復回数の決定と OPN-1 の追加の測定を済ませてから、設計文書にまとめて書く。

**その次は詳細設計。** まず `docs/design/detailed/` の文書の分け方を決める（design/README.md「詳細設計の文書」）。

詳細設計に持ち越す注意：TIM-7 で長さ0の時間帯を認めるので、予約の表に「終了 > 開始」の制約を付けない。

文書の分け方と、基本設計で作る文書の一覧は [design/README.md](design/README.md) を見る。

## 基本設計の状態

| 文書 | 状態 |
| --- | --- |
| [design/basic/platform-selection.md](design/basic/platform-selection.md) | 決定（実測3件は保留） |
| [design/basic/architecture.md](design/basic/architecture.md) | 決定 |
| [design/basic/domain-model.md](design/basic/domain-model.md) | 決定 |
| [design/basic/time-and-concurrency.md](design/basic/time-and-concurrency.md) | 決定（`blockConcurrencyWhile` の動きは確認待ち） |
| [design/basic/auth.md](design/basic/auth.md) | 決定（PBKDF2 の反復回数は実測待ち） |
| [design/basic/screens-and-api.md](design/basic/screens-and-api.md) | 決定 |
| [design/basic/logging.md](design/basic/logging.md) | 決定（DO あたりの容量と管理画面での見え方は実測待ち） |
| [design/basic/testing-and-deploy.md](design/basic/testing-and-deploy.md) | 決定 |
| [design/basic/design-values.md](design/basic/design-values.md) | 作成（各文書で値が決まるたびに足す） |

design-values.md のうち、機器の名前の上限（MNG-1）は未定のまま。詳細設計で、機器の画面と API の入出力を決めるときに決める。OPN-1 は実測待ち。

## 決まったこと（要点）

- 基盤は Cloudflare Workers の無料プランで、カードは登録しない。予約台帳は Durable Object（SQLite）に置き、書き込みを順に処理する（RSV-23）。画面は Workers が配る静的ファイル。テストは Vitest、デプロイは wrangler と GitHub Actions。
- 採らなかった案と理由：Supabase は NFR-5、GAS は SEC-3 と NFR-2、Firebase は PRE-2 を満たせない。
- 構成：すべてのデータと API の処理を1つの Durable Object（台帳）に置き、Worker は静的ファイルと振り分けだけ。ルールの判定は `src/rules/` の純粋な関数、SQL は `src/store/` だけに書く。画面はフレームワークもビルドも使わない。
- データ：数値の設定は上書きせず履歴で持つ（猶予は開始時刻の時点の値を引く。RSV-26）。予約は利用者の番号だけを持ち、名前は写さない（USR-7）。猶予のうちで予約済なら本人が取り消せる（RSV-8 の読み方。確認済み）。
- 時刻と排他：時刻は UTC のミリ秒で持ち、日本時間は9時間を足す。自動の変化は、どのリクエストでも先に `nowMin` 以下の分を反映する。`await` を挟まずに処理し、ハッシュの計算だけ `blockConcurrencyWhile` で包む。
- 認証：共有された情報は台帳が作るランダムな値で、QR コード（利用者の画面の URL の `#k=値`）でだけ渡す。作り直すと全端末が止まる。証明は Cookie のランダムな値で、台帳は SHA-256 を持ち、版で止める。期限はなし。試行は同じ IP からの失敗を10分ごとに数える（共有された情報は200回、管理者は10回、保守用は5回）。学校のアカウントは保守用の API（`MAINT_KEY`）で管理者を作る。
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

## 基盤の実測の結果（2026-11-17。設計文書への反映待ち）

開発者の個人の Cloudflare アカウント（無料プラン、カードなし）に `spike/` を手元から deploy して測った。Worker の名前は `dxplace-spike`、URL は `https://dxplace-spike.dxp-spike.workers.dev`。spike は本番とは別のもので、手元からの deploy は開発者が了承した。測り終えたら `npx wrangler delete` で消す。

- **未決事項1（データの置き場所）：DO の SQLite にすべて置く、で確定してよい。** 管理画面の Durable Objects →`dxplace-spike_Ledger`→「Data Studio」で、表を読めて、SQL も実行できた（LOG-6）。名前空間の画面に使っている容量（Storage used）も出る。1つの DO あたりの容量の上限は管理画面に出ない。公式ページは、表で10GB、FAQ で無料プランは1GB、と食い違ったままなので、1GB を前提にする（logging.md 5 の見積もりは変えずに済む）。
- **未決事項2（PBKDF2 の反復回数）：** `wrangler tail` の `cpuTime` で測った（各10〜40回）。DO の中では、1万回が中央値3ms・最大4ms、2万回が6ms・7ms、5万回が13ms・19ms、10万回が30ms・44ms。Worker の中もほぼ同じ。10万回は workerd の上限。10万回を20回繰り返して CPU を約0.5秒使っても、DO・Worker のどちらでも止められなかった。公式ページでは、DO は1回の呼び出しで30秒、Worker の無料プランは10ms（「たまに超えるのは許すが、超え続けると止める」）。**DO の中で計算する設計（auth.md 4）なら、10msの制限は効かない。** 反復回数は、10万回・パスワードの条件はそのまま（A）を推薦し、開発者の決定待ち。比べた案は、10万回で条件を12文字以上に緩める（B）と、1万回のまま（C）。決まったら、auth.md 4・5、design-values.md、platform-selection.md（SEC-4 の行、残るリスクの「CPU 時間が1リクエスト10ms」、未決事項2）を直す。
- **未決事項3（校内からの到達性）：届く。** 校内の回線の PC から測った。毎回新しく接続する `/ping` は20回で中央値0.457秒・最大1.102秒、接続を使い回す `/ping` は0.135秒・0.437秒、DO に書く `/do` は0.168秒・0.469秒。失敗は0回。**ただし、応答した拠点は米国（`colo=LAX`・`SJC`・`SEA`）だった。** 接続元は `loc=JP` で、`www.cloudflare.com` には大阪（KIX）が応答した。platform-selection.md の NFR-2 の行の「日本の拠点から応答する」と、architecture.md 7 の「DO は日本の近くに置かれる見込み」は、実測と合わないので直す。NFR-2 には余裕がある。
- **`blockConcurrencyWhile`（time-and-concurrency.md「確認が要ること」）：リクエストの処理の中でも文書どおりに動く。** DO の中で1.5秒待つ間に、5本の書き込みを送って確かめた。包まないと5行が割り込み、包むと0行で、ほかのリクエストは包んだ処理が終わるまで待った。なお、PBKDF2 は `await` を書いても、実際には途中でほかのリクエストに順番を譲らなかった。ただ、これに頼らずに包む設計のままにする。
- **OPN-1：** 約5時間使われなかった後の最初の1回は0.705秒で、2〜4回目（0.46〜0.47秒）より0.24秒遅いだけだった。測ったのは1回だけ。開発者が「もう少し測ってから決める」とした。
- **気づいたこと（未確認）：** spike を送り直した直後に1回だけ、新しい Worker が古い DO を呼んだような応答が返った。再現はしなかった。本番でも、デプロイの直後は Worker と台帳の版が少しの間食い違うかもしれない。台帳との受け渡しの形を変えるときに注意する。

## 保留していること

- **OPN-1 の追加の測定**：`spike/idle.js` で、5分・10分・20分・40分・60分と間を空けて、最初の1回と2回目を測る（約2時間15分）。`cd spike` のあと `node idle.js idle.log` で動かす。その間は、spike の URL を開かず、PC もスリープさせない。2026-11-17 に始めたが、開発者が移動するので止めた（結果はなし）。
- **PBKDF2 の反復回数の決定**：上の「基盤の実測の結果」を見て決める。
- **NFR-2 の確かめ方**：要件は「校内の通常の回線と手持ちのスマートフォン」で測ることを求めている。しかし手持ちのスマートフォンは、学校のルールで校内の回線につなげない。開発者は、校内の回線につながる PC と、携帯の回線につないだスマートフォンの両方で測る予定（2026-11-17）。スマートフォンは、iOS と Android の両方を用意できるかわからないので後に回す。要件どおりには測れないので、要件を決めた人と相談が要る。あわせて、利用者が実際に予約するときにどの回線を使うかも確かめる。
- **まだ確かめていないこと**：長い休みの後の最初のリクエストで、たまった自動の変化をまとめて反映する重さ（本物のコードができてから測る。DO の中なら10msではなく30秒の制限）、1日の上限を超えて止まっている間も静的ファイルが配られるか（FUT-1）。DO の1日の上限は公式ページで確かめた（リクエスト10万回、稼働時間 13,000 GB-s、行の読み取り500万、書き込み10万。超えた種類の操作だけ失敗し、00:00 UTC にリセット）。logging.md 5 はまだこの上限を見ていない。
- **FUT-3 の控えの置き場所**：DO の外に置く場所が決まっていない。公開前に決める（platform-selection.md の FUT-3 の行）。30日に戻せる機能が無料プランで使えるかは、実測のときに確かめる。
- **実測用のコード `spike/`**：Git の対象外で、この PC にだけある。wrangler は `spike/` の中に入れた（`spike/package.json`）。ログインは `npx wrangler login`（PC のアカウントに残っている）。2026-11-17 に、DO の中の PBKDF2（`/do-pbkdf2?iter=&rep=&bcw=&wait=`）と `idle.js` を足した。

## 未解決の質問・確認事項

- architecture.md から持ち越し：PBKDF2 の `await` の間に他のリクエストが割り込みうる（管理者のパスワードを扱う操作だけ `blockConcurrencyWhile` で包むと決めた。リクエストの処理の中でも使えるかは、テストと実測で確かめる）。USR-7 の名前の置き換えは `POST /api/me` だけで行う（確認済み。screens-and-api.md）。

## 次のセッションの始め方

1. このファイルと [design/README.md](design/README.md) を読む。
2. 「いまの段階」の作業に着手する。設計を示すときは、構成・理由・主な代替案を簡潔に出す（CLAUDE.md「開発の進め方」）。

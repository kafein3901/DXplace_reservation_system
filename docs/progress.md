# 進捗と引き継ぎ

セッションを終える前（`/clear` の前）に更新し、次のセッションはここから読み始める。決定の中身は設計文書に書き、ここには「どこまで進んだか」「次に何をするか」「保留していること」だけを書く。

最終更新：2026-11-17

## いまの段階

**基本設計と、そのレビューが終わった。** 基本設計の文書（下の表）がすべて決定になり、2026-11-17 のレビューで見つけたものを直した（下の「レビューで変えたこと」）。

**次は詳細設計。** まず `docs/design/detailed/` の文書の分け方を決める（design/README.md「詳細設計の文書」）。

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

## 保留していること

- **基盤の実測3件**（platform-selection.md の未決事項1〜3）：実測できる環境がないので後回しにした。それまでの前提は platform-selection.md に書いてある。校内から `*.workers.dev` に届くかどうかは、本番のアカウントを作る前に必ず確かめる。
- **実測のときに足して確かめること**：1つの DO あたりの保存容量の上限（公式ページで1GBと10GBが食い違う。logging.md 5）、DO の SQLite を管理画面から見られるか（logging.md 6）、長い休みの後の最初のリクエストで、たまった自動の変化をまとめて反映しても CPU の10msに収まるか、1日の上限を超えて止まっている間も静的ファイルが配られるか（FUT-1）、DO の1日のリクエスト数と稼働時間の上限（logging.md 5 は行数と容量だけを見ている）。
- **FUT-3 の控えの置き場所**：DO の外に置く場所が決まっていない。公開前に決める（platform-selection.md の FUT-3 の行）。30日に戻せる機能が無料プランで使えるかは、実測のときに確かめる。
- **実測用のコード `spike/`**：Git の対象外で、この PC にだけある。

## 未解決の質問・確認事項

- architecture.md から持ち越し：PBKDF2 の `await` の間に他のリクエストが割り込みうる（管理者のパスワードを扱う操作だけ `blockConcurrencyWhile` で包むと決めた。リクエストの処理の中でも使えるかは、テストと実測で確かめる）。USR-7 の名前の置き換えは `POST /api/me` だけで行う（確認済み。screens-and-api.md）。

## 次のセッションの始め方

1. このファイルと [design/README.md](design/README.md) を読む。
2. 「いまの段階」の作業に着手する。設計を示すときは、構成・理由・主な代替案を簡潔に出す（CLAUDE.md「開発の進め方」）。

# 基盤の選定

- 状態：決定（一部は実測待ち。「未決事項」を参照）
- 日付：2026-11-16
- 関係する要件：PRE-2, PRE-4, PRE-5, PRE-9, PRE-11, USR-1, SEC-3, SEC-4, SEC-5, RSV-23, RSV-24, LOG-6, NFR-2, NFR-3, NFR-4, NFR-5, FUT-1〜FUT-8, OPN-1

## 決定

**Cloudflare Workers の無料プラン（Workers Free）を使う。支払い方法（カード）は登録しない。**

| 役割 | 使うもの |
| --- | --- |
| サーバの処理 | Workers（JavaScript） |
| 画面 | Workers が配る静的ファイル（HTML / CSS / JavaScript） |
| データと排他 | Durable Objects（SQLite）。D1 との分担は実測で決める（未決事項1） |
| 定期処理 | Cron Triggers（FUT-3 の控えなど。v0.1.0 では作らない） |
| テストとデプロイ | Vitest（`@cloudflare/vitest-pool-workers`）、wrangler、GitHub Actions |

## 前提

- 学校のアカウント（PRE-11）は未定。メールアドレスで外部サービスに登録できることだけを前提にする。
- GitHub（コードの置き場所と CI）は PRE-11 の対象外とする。この構成では GitHub が止まっても稼働中のシステムは止まらない（デプロイができなくなるだけ）。

## 要件ごとの満たし方

| 要件 | 満たし方 |
| --- | --- |
| PRE-2 | カードを登録しない無料プランでは課金が起きない。1日の上限を超えると処理がエラーになる（停止）。上限は 00:00 UTC（日本時間 9:00）にリセットされる |
| PRE-4 | 個人情報を Cloudflare に置く。要件上許される |
| PRE-5 | サーバも画面も JavaScript。Request / Response など Web 標準の API が中心。Cloudflare 固有の概念（Durable Object）は予約台帳の部分に閉じ込める |
| PRE-9 / NFR-5 | 使われないことを理由に停止する仕組みがない |
| PRE-11 | Cloudflare のアカウントを学校のアカウントで作り、Super Administrator とする。開発する生徒はメンバーとして招待する（全プランで可能） |
| USR-1 / RSV-24 | すべての読み書きが Worker を通る。DB に直接つながる口を外に出さない |
| RSV-23 | 予約台帳を1つの Durable Object に置き、書き込みを順に処理する。DO の SQLite は同期 API なので、読む→確かめる→書くの間に他の処理が割り込まない |
| SEC-2 | `*.workers.dev` は HTTPS のみ |
| SEC-3 | 試行の回数をサーバ側で数える（接続元 IP は `CF-Connecting-IP` で取れる）。値は別の設計文書で定める |
| SEC-4 | 管理者のパスワードと共有された情報は PBKDF2-SHA256（Web Crypto）でハッシュ化する。反復回数は CPU 制限のもとで実測して決める（未決事項2）。※ 2026-11-16 追記：共有された情報は台帳が作るランダムな値に変えたので、SHA-256 にした（auth.md 4）。PBKDF2 は管理者のパスワードだけに使う |
| SEC-5 | Cloudflare の DDoS 対策の範囲で守る。超えたら停止を受け入れる |
| LOG-6 / FUT-4 | 記録は SQL で絞り込める表として持つ。管理画面から確認できるかは実測する（未決事項1） |
| NFR-2 | 起動の遅れがほぼなく、日本の拠点から応答する。校内からの速さは実測する（未決事項3） |
| NFR-3 | 無料枠は1日10万リクエスト。想定（予約20件/日、同時20人）の10倍でも十分収まる。5年分のデータ量は別の設計文書で見積もる |
| NFR-4 | GitHub Actions でテストを実行し、通ったときだけ wrangler でデプロイする |
| FUT-1 | 停止中の表示は、静的ファイルの側で API のエラーを検知して出せる（停止中でも静的ファイルは配れるかは、公開前に確かめる） |
| FUT-2 | 使用量は Cloudflare の GraphQL Analytics API で取れる。警告の仕組みは公開前に作る |
| FUT-3 | Cron Triggers は無料プランで使え、使われない間も動く。DO には過去30日に戻せる機能もある |
| FUT-6 / FUT-7 | サーバ側の判定で、書き込める人を分ければよい。基盤の制約はない |
| FUT-8 | R2 は支払い方法の登録を求められる可能性があり、PRE-2 の「超えたら止まる」を保証できないので使わない。縮小した画像を D1 か KV に保存する（1件あたりの大きさに制約がつく） |

## 不採用にした案

| 案 | 理由 |
| --- | --- |
| Supabase（Postgres + Edge Functions） | 無料版は DB の活動が1週間ないと停止し、再開は手動。NFR-5 を満たすには外部の定期アクセス（GitHub Actions など）に頼るしかなく、それが壊れると黙って止まる。GitHub が運用の基盤に入り、PRE-11 の対象が増える。無料版には控えのダウンロードがない（FUT-3）。排他制約（`EXCLUDE`）で重複を防げる点は優れている |
| Google Apps Script + スプレッドシート | 接続元の IP が取れず、SEC-3 の「同じ相手からの試行の制限」が作れない。応答が1〜数秒かかり、NFR-2 を満たしにくい。CI からのデプロイに Google アカウントの認証情報が要る（NFR-4） |
| Firebase | サーバ側の処理（Cloud Functions）に従量課金の Blaze プランが要る（PRE-2） |
| Vercel / Netlify + 外部 DB | サービスが2つ以上に分かれ、PRE-11 で管理するアカウントが増える。Hobby プランは非商用の条件がある |

## 残るリスク

- **CPU 時間が1リクエスト10ms。** PBKDF2 の反復回数を推奨値（60万回）まで上げられない。共有された情報と管理者のパスワードの条件（SEC-3）を厳しくして補う。
- **上限を超えたら日本時間9時まで止まる。** その間は PRE-10 で運用する。
- **Durable Object は Cloudflare 専用。** 乗り換えるときは、予約台帳の部分の書き直しが要る。ルールの判定は DO に依存しない純粋な関数として分けておき、影響を小さくする。
- **校内のフィルタ。** `*.workers.dev` が遮断されていると使えない（未決事項3）。
- **無料枠の数値は変わりうる。** 2026-11 時点の公式ページの値による。

## 追加するツール

| ツール | 理由 | 代わりの案 |
| --- | --- | --- |
| Node.js / npm | wrangler と Vitest を動かす | なし（Cloudflare の開発に必須） |
| wrangler | 手元での実行とデプロイ | 管理画面に手でアップロードする（NFR-4 の自動化ができない） |
| Vitest + `@cloudflare/vitest-pool-workers` | 本番と同じ実行環境で、DO を含めてテストする | Node 組み込みの `node:test`（DO を動かせない） |

## 未決事項（実測で決める）

1. **データの置き場所。** DO の SQLite にすべて置くか、D1 に置いて書き込みだけ DO で直列化するか。DO の SQLite を管理画面から SQL で確認できれば（LOG-6）前者にする。
2. **PBKDF2 の反復回数。** デプロイした Worker で反復回数ごとの CPU 時間を測り、最大値が10msを十分下回る値にする。
3. **校内からの到達性と応答時間。** 校内の回線と手持ちのスマートフォンから `*.workers.dev` に届くか、応答に何秒かかるか。OPN-1 の材料にする。

実測は `spike/`（コミットしない）で行い、結果をこの文書に追記する。

**2026-11-16 時点：実測は保留。** 実測できる環境（Cloudflare のアカウント、校内の回線）がまだないため、後回しにする。それまでの設計は次の前提で進め、実測の結果が違えばその部分だけを直す。

- 未決事項1：DO の SQLite にすべて置く前提で進める。ただしデータの読み書きは1か所にまとめ、D1 に移せる形にしておく。
- 未決事項2：反復回数は設定値として持ち、実測の後に決める。値の条件（SEC-3）は、反復回数が少ない場合でも持ち出し後の総当たりに耐える側に寄せる。
- 未決事項3：OPN-1 は未定のまま。校内から届くことは、本番のアカウントを作る前に必ず確かめる。

`spike/` はリポジトリに含めていないので、別の PC で実測するときは作り直す（中身は `/ping`、`/pbkdf2?iter=N`、`/do` の3つの入口だけ）。

## 参照した情報

- Workers limits: https://developers.cloudflare.com/workers/platform/limits
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits
- Durable Objects free tier: https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/
- Manage account members: https://developers.cloudflare.com/fundamentals/manage-members/manage/
- Supabase free project pausing: https://supabase.com/kb/faqs/platform/free-project-pausing

# 進捗と引き継ぎ

セッションを終える前（`/clear` の前）に更新し、次のセッションはここから読み始める。決定の中身は設計文書に書き、ここには「どこまで進んだか」「次に何をするか」「保留していること」だけを書く。

最終更新：2026-11-16

## いまの段階

**基本設計の途中。** 基盤の選定が終わった。次は構成とデータの流れ（`basic/architecture.md`）。

文書の分け方と、基本設計で作る文書の一覧は [design/README.md](design/README.md) を見る。

## 基本設計の状態

| 文書 | 状態 |
| --- | --- |
| [design/basic/platform-selection.md](design/basic/platform-selection.md) | 決定（実測3件は保留） |
| design/basic/architecture.md | **次に着手** |
| design/basic/domain-model.md | 未着手 |
| design/basic/time-and-concurrency.md | 未着手 |
| design/basic/auth.md | 未着手 |
| design/basic/screens-and-api.md | 未着手 |
| design/basic/logging.md | 未着手 |
| design/basic/testing-and-deploy.md | 未着手 |
| design/basic/design-values.md | 未着手（各文書で値が決まるたびに足す） |

順番は目安。architecture と domain-model を先に決めると、残りが決めやすい。

## 決まったこと（要点）

- 基盤は Cloudflare Workers の無料プランで、カードは登録しない。予約台帳は Durable Object（SQLite）に置き、書き込みを順に処理する（RSV-23）。画面は Workers が配る静的ファイル。テストは Vitest、デプロイは wrangler と GitHub Actions。
- 採らなかった案と理由：Supabase は NFR-5、GAS は SEC-3 と NFR-2、Firebase は PRE-2 を満たせない。
- 学校のアカウント（PRE-11）は未定。メールで登録できることだけを前提にしている。
- GitHub は PRE-11 の対象外とする。

## 保留していること

- **基盤の実測3件**（platform-selection.md の未決事項1〜3）：実測できる環境がないので後回しにした。それまでの前提は platform-selection.md に書いてある。校内から `*.workers.dev` に届くかどうかは、本番のアカウントを作る前に必ず確かめる。
- **実測用のコード `spike/`**：Git の対象外で、この PC にだけある。

## 未解決の質問・確認事項

- CLAUDE.md の技術スタックは仮のもの。実測の結果によっては、データの置き場所を D1 に変える。

## 次のセッションの始め方

1. このファイルと [design/README.md](design/README.md) を読む。
2. 「いまの段階」の文書に着手する。設計を示すときは、構成・理由・主な代替案を簡潔に出す（CLAUDE.md「開発の進め方」）。

# 設計文書

要件（`docs/requirements_v0-1-0.md`）から実装までを、基本設計と詳細設計の2段階で決める。決めたことは理由と主な代替案とともに書く。要件は ID で指す（例：RSV-3）。

| 段階 | 置き場所 | 決めること |
| --- | --- | --- |
| 基本設計 | `basic/` | 何をどう分けて作るか。基盤、構成とデータの流れ、データのまとまりと状態、画面とAPIの一覧、認証、記録、テストとデプロイの方式、要件で「設計で定める」とされた値 |
| 詳細設計 | `detailed/` | 実装できる粒度の仕様。テーブル定義、APIごとの入出力と断る理由のコード、ルールごとの判定手順、画面ごとの項目と動き、テストの観点 |

詳細設計は、基本設計の文書がそろってから始める。詳細設計で基本設計の変更が要るとわかったら、基本設計の文書を直してから進める。

## 基本設計の文書

状態は `docs/progress.md` で管理する。

| 文書 | 内容 | 主な要件 |
| --- | --- | --- |
| [basic/platform-selection.md](basic/platform-selection.md) | 基盤の選定 | PRE-2, PRE-11, NFR-5 |
| [basic/architecture.md](basic/architecture.md) | 構成要素（画面・Worker・Durable Object・DB）とデータの流れ、ファイルの分け方 | USR-1, RSV-24, PRE-5 |
| [basic/domain-model.md](basic/domain-model.md) | データのまとまり（利用者・機器・予約・記録・設定）と予約の状態遷移 | USR-4, USR-7, RSV-1, MNG-1 |
| [basic/time-and-concurrency.md](basic/time-and-concurrency.md) | 時刻の扱い、自動で起きる変化の反映、排他 | TIM-1〜8, RSV-21〜23 |
| [basic/auth.md](basic/auth.md) | 利用の開始、管理者の認証、認証した状態の持ち方と止め方、試行の制限 | USR-2, ADM-2, ADM-3, SEC-3, SEC-4 |
| [basic/screens-and-api.md](basic/screens-and-api.md) | 画面の一覧と遷移、APIの一覧、断る理由のコードの体系 | VIW-1〜3, RSV-27 |
| [basic/logging.md](basic/logging.md) | 記録の持ち方と、認証失敗の記録の持ち方 | LOG-1〜6, FUT-4 |
| [basic/testing-and-deploy.md](basic/testing-and-deploy.md) | 自動テストとデプロイの仕組み | NFR-4 |
| [basic/design-values.md](basic/design-values.md) | 要件で「設計で定める」とされた値の一覧（管理者IDの形式、機器名の上限、SEC-3 の値、OPN-1 など） | ADM-2, MNG-1, SEC-3, LOG-4, OPN-1 |

## 詳細設計の文書

`detailed/` に置く。状態は `docs/progress.md` で管理する。

| 文書 | 決めること | 対応する `src/` |
| --- | --- | --- |
| `detailed/rules.md` | ルールごとの判定の手順、関数の入出力、複数のルールに反するときに確かめる順、自動の変化を反映する手順、ルールのテストの観点 | `rules/`、`lib/` |
| `detailed/schema.md` | 表の定義（列・型・制約・索引）、初期データ、スキーマの版と起動時の順の適用 | `store/` |
| `detailed/error-codes.md` | 理由のコードの一覧（コード・HTTP・要件の ID・どこで返すか） | `rules/`、`public/js/messages.js` |
| `detailed/api.md` | API ごとの入出力と返しうるコード、保守用の API の `curl` 手順、Worker と台帳の受け渡し、台帳の層のテストの観点 | `api/`、`ledger.js`、`index.js` |
| `detailed/screens.md` | 画面ごとの項目と動き、エラーの表示、手で確かめる手順の一覧 | `public/` |

- 進め方：共通の部分（rules.md の枠組み、schema.md、error-codes.md、api.md の共通部分）を先に書き、その後は機能を1つずつ縦に切って、設計と実装・テストを交互に進める。実装でわかった食い違いは、その場で設計に戻す。
- 書く順：rules.md → schema.md → error-codes.md・api.md → screens.md。
- コードの一覧を独立させるのは、rules・api・画面の3か所が同じコードを使うため。
- テストの観点は、観点だけの文書を作らず各文書に書く（テスト名が要件の ID で始まるので、ID で横断して探せる）。
- rules.md にはコードを書かない。関数の名前・引数・戻り値と判定の手順を文章と表で書く（設計とコードを二重に持たないため）。schema.md の `CREATE TABLE` は書いてよい。

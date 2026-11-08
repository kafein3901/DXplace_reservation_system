# DXプレイス予約システム

要件定義: @docs/requirements.md
基本設計（テーブル・RPC・画面）: @docs/design.md

## 構成

- フロント: GitHub Pages、素のHTML/CSS/JS（ES Modules、ビルドなし）
- バックエンド: Supabase。スキーマは supabase/migrations/ で管理する
- テスト: pgTAP（supabase/tests/）

## コマンド

前提: Docker Desktop を起動しておく。Supabase CLI は Scoop で導入（`scoop install supabase/supabase`）。

- ローカル起動 / 停止: `supabase start` / `supabase stop`
- 接続先などの確認: `supabase status`（キーも表示されるので、出力をファイルやコミットに残さない）
- マイグレーションの作成: `supabase migration new <名前>`（`supabase/migrations/` にファイルができる）
- マイグレーションの適用: `supabase db reset`（ローカルDBを作り直し、全マイグレーションと `seed.sql` を流す）。`--linked` は付けない
- テスト全件: `supabase test db`
- テスト1ファイル: `supabase test db supabase/tests/<ファイル名>.test.sql`
- テストファイルは `begin; select plan(n); ... select * from finish(); rollback;` の形で書く（`supabase/tests/000_setup.test.sql` が例）

ローカルの接続先: API `http://127.0.0.1:54321`、DB `127.0.0.1:54322`、Studio `http://127.0.0.1:54323`

補足: Windows では `supabase_vector`（ログ収集）コンテナが再起動を繰り返すことがあるが、DB とテストには影響しない。

## 絶対に守ること

- 業務ルールはすべて security definer のRPC関数に書く。フロントでの判定は表示用のみ
- anon ロールにテーブルの権限を与えない
- security definer 関数には必ず set search_path を指定する
- 時刻の判定は DB の now() で行う
- 状態は保存せず、時刻から導出する（要件定義4章）
- service_role キーやDBのパスワードをコードやリポジトリに置かない（.env に置く）
- 操作はローカル環境に対してのみ行う。本番のSupabaseには触らない
- 適用済みのマイグレーションは編集せず、新しいマイグレーションを追加する

## 作業の進め方

- 要件が曖昧なときは推測せず質問する
- RPC関数はテストを先に書き、失敗を確認してから実装する
- 作業の終わりにテストを実行し、すべて通ってからコミットする
- 応答は日本語、コード中のコメントも日本語

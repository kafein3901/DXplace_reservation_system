# DXプレイス予約システム

DXプレイスの3Dプリンタと高性能PCを、予約によって公平に使えるようにする Web システム。

- 利用者の画面: `index.html`（入口URL の QR コードから開く）
- 管理画面: `admin.html`

## 文書

- [要件定義](docs/requirements.md)
- [基本設計（テーブル・RPC・画面）](docs/design.md)
- [公開・運用手順書](docs/operations.md)（本番環境の構築、バックアップと復元、引き継ぎ）
- [開発の決まりとコマンド](CLAUDE.md)

## 構成

- フロント: GitHub Pages。素の HTML / CSS / JavaScript（ES Modules、ビルドなし）
- バックエンド: Supabase。業務ルールはすべて `security definer` の RPC 関数に書く
- テスト: pgTAP（`supabase/tests/`）

## ローカルで動かす

前提: Docker Desktop と Supabase CLI。

```bash
supabase start
```

```bash
supabase db reset
```

```bash
bash scripts/write-local-config.sh
```

```bash
python -m http.server 8000 --bind 127.0.0.1
```

- 利用者の画面: http://localhost:8000/#t=local-dev-token
- 管理画面: http://localhost:8000/admin.html（ログイン情報は `supabase/seed.sql` の冒頭）
- テスト: `supabase test db`

# DXプレイス予約システム 公開・運用手順書

最終更新: 2026-11-08

本番環境を作る手順、日々の運用、バックアップからの復元、引き継ぎをまとめる。要件定義は [requirements.md](requirements.md)、設計は [design.md](design.md) を参照。

> 開発用の AI（Claude Code）は、CLAUDE.md の決まりにより本番の Supabase を操作しない。この手順書の本番に対する作業は、すべて人が行う。

---

## 1. 構成

| 部分 | 置き場所 | 中身 |
| --- | --- | --- |
| 画面 | GitHub Pages（main ブランチのルート） | `index.html`（利用者）、`admin.html`（管理者）、`css/`、`js/` |
| データベース | Supabase（PostgreSQL） | `supabase/migrations/` のマイグレーション |
| 管理者の追加 | Supabase Edge Functions | `supabase/functions/admin-create-admin/` |
| 休止防止・バックアップ | GitHub Actions | `.github/workflows/keepalive.yml`、`backup.yml` |

秘密の情報（DB のパスワード、service_role キー、バックアップのパスフレーズ）は、リポジトリに置かない。GitHub の Secrets、Supabase のダッシュボード、各自のパスワード管理に置く。

---

## 2. 本番環境の初期構築（最初に一度だけ）

### 2.1 Supabase のプロジェクトを作る

1. https://supabase.com/dashboard で New project を作る。リージョンは Tokyo（Northeast Asia）にする
2. Database Password を決めて、パスワード管理に保管する（あとで Secrets に使う）

### 2.2 マイグレーションを適用する

開発用の PC で、リポジトリのフォルダから実行する。

```bash
supabase login
```

```bash
supabase link --project-ref <プロジェクトの Reference ID>
```

```bash
supabase db push
```

- `seed.sql`（ローカル用のテスト値）は流れない。`--include-seed` は付けない
- 以後、マイグレーションを追加したときも `supabase db push` で適用する

### 2.3 Auth を設定する（ダッシュボード）

Authentication の設定で、次のようにする（ローカルの `supabase/config.toml` と同じ内容）。

- 新規のサインアップを禁止する（Allow new users to sign up をオフ）。管理者は管理画面から追加する
- パスワードの最小の長さを 8 にする
- Site URL を GitHub Pages の URL（例: `https://<ユーザー名>.github.io/<リポジトリ名>/`）にする

### 2.4 Edge Function をデプロイする

```bash
supabase functions deploy admin-create-admin
```

service_role キーは Supabase が関数に自動で渡す。設定は不要。

### 2.5 最初の管理者を作る

サインアップを閉じているので、最初の管理者だけはダッシュボードで作る。2人目からは管理画面の「管理者」タブで追加する。

1. Authentication → Users → Add user で、メールアドレスとパスワードを入れ、Auto Confirm User をオンにして作る
2. SQL Editor で次を実行し、管理者表に登録する（メールアドレスと表示名を書き換える）

```sql
insert into private.admins (user_id, display_name)
select id, '開発者' from auth.users where lower(email) = lower('あなたのメールアドレス')
returning user_id, display_name;
```

結果に1行表示されれば登録できている。**0行（`Success. No rows returned`）なら登録できていない**。メールアドレスが Users の一覧と一致しているか確かめて、もう一度実行する。

登録済みの管理者は、次の SQL で確かめられる。

```sql
select u.email, a.display_name
from auth.users u left join private.admins a on a.user_id = u.id;
```

`display_name` が空の行は、Auth のユーザーはいるが管理者表にいない（管理画面にはログインできない）。

### 2.6 画面の接続先を書く

1. Supabase の Project Settings → API で、Project URL と anon（public）キーを確かめる
2. `js/config.js` の `production` に書いて、コミットしてプッシュする

```js
const production = {
  supabaseUrl: "https://<プロジェクトの Reference ID>.supabase.co",
  anonKey: "<anon キー>",
};
```

- anon キーは画面で公開される前提のキーなので、コミットしてよい（要件定義 8章）
- service_role キーは絶対に書かない

### 2.7 GitHub Pages を公開する

1. リポジトリの Settings → Pages で、Source を Deploy from a branch、Branch を `main` / `(root)` にする
2. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で開けることを確かめる

ルートの `.nojekyll` は、GitHub Pages の Jekyll の処理を止めるためのファイル。消さない。

### 2.8 管理画面で初期設定をする

1. `https://<ユーザー名>.github.io/<リポジトリ名>/admin.html` を開き、2.5 の管理者でログインする
2. 「リソース」タブで、3Dプリンタと PC を追加する
3. 「入口URL」タブで「発行する」を押し、表示された QR コードを印刷して DXプレイスに掲示する
4. 「管理者」タブで、担当教員を追加する

### 2.9 GitHub Actions を設定する

リポジトリの Settings → Secrets and variables → Actions → New repository secret で、次の2つを登録する。

| 名前 | 値 |
| --- | --- |
| `SUPABASE_DB_URL` | Supabase の Connect → **Session pooler** の接続文字列（`[YOUR-PASSWORD]` を 2.1 のパスワードに置き換える）。GitHub のランナーは IPv4 しか使えないため、Direct connection ではなく Session pooler を使う |
| `BACKUP_PASSPHRASE` | バックアップを暗号化するパスフレーズ。長いランダムな文字列にし、パスワード管理に保管する。**なくすとバックアップを復元できない** |

登録したら、Actions タブで `keepalive` と `backup` をそれぞれ Run workflow で手動実行し、成功することを確かめる。

---

## 3. 日々の運用

### 3.1 自動で動くもの

| ワークフロー | 頻度 | 内容 |
| --- | --- | --- |
| `keepalive` | 3日ごと | DB に軽いクエリを送り、無料プランの一時停止（7日間アクティビティがないと停止）を防ぐ |
| `backup` | 毎週日曜 | `pg_dump` を取り、パスフレーズで暗号化して、Actions の成果物に90日保存する |

### 3.2 スケジュール実行が止まる仕様について（要件定義 8章の「要確認」）

GitHub のドキュメントによると、**公開リポジトリでは、リポジトリに60日間動きがないと、スケジュール実行のワークフローが自動で止まる**。非公開リポジトリについては記載がない。

- `keepalive` は実行のたびに、`keepalive.yml` と `backup.yml` を「有効にする」API を呼んでいる。ただし、これで60日の停止を防げるかは、GitHub のドキュメントには書かれていない
- そのため、**月に1回、Actions タブで両方のワークフローが動いているかを確かめる**。止まっていたら、ワークフローを選んで Enable workflow を押す（または `gh workflow enable keepalive.yml` と `gh workflow enable backup.yml`）

### 3.3 Supabase が一時停止したとき

ダッシュボードでプロジェクトを開き、Restore（再開）を押す。停止している間は、予約なしで自由に使ってよい（要件定義 8章）。

### 3.4 入口URLを変えたいとき

QR コードが校外に出たときなどは、管理画面の「入口URL」タブで再発行する。古い URL はすぐに使えなくなり、利用者には「入口URLが更新されました」と表示される。新しい QR コードを掲示し直す。

### 3.5 管理者がパスワードを忘れたとき

ほかの管理者が、ダッシュボードの Authentication → Users でその人を削除し、管理画面の「管理者」タブで作り直す。削除すると管理者表からも消える。過去のログは残るが、操作者の表示名は空になる。

---

## 4. バックアップからの復元

ローカル環境で、この手順のとおりに復元できることを確かめてある（2026-11-08）。

### 4.1 ダウンロードと復号

1. Actions → `backup` → 復元したい日の実行 → Artifacts の `db-backup` をダウンロードし、zip を展開する
2. 復号する（パスフレーズを聞かれる）

```bash
gpg -o backup.dump -d dxplace-YYYYMMDD-HHMMSS.dump.gpg
```

### 4.2 復元先を用意する

- **新しいプロジェクトに復元する場合**: 2.1〜2.4 を済ませる（`supabase db push` でテーブルができる）
- **今のプロジェクトに上書きする場合**: SQL Editor で今のデータを消す。**今のデータはすべて失われる**ので、必要なら先に `backup` を手動実行しておく

```sql
truncate private.action_logs, private.reservations, private.entry_tokens, private.admins,
         private.announcements, private.users, private.resources;
delete from auth.identities;
delete from auth.users;
```

### 4.3 データを流し込む

Docker が使える PC で、`backup.dump` のあるフォルダから実行する。`<接続文字列>` は 2.9 の Session pooler のもの。外部キーの順に、`auth.users` → `auth.identities` → `private` の3回に分けて流す。

```bash
docker run --rm -v "$PWD:/work" postgres:17 pg_restore --dbname="<接続文字列>" --data-only --no-owner --schema=auth --table=users /work/backup.dump
```

```bash
docker run --rm -v "$PWD:/work" postgres:17 pg_restore --dbname="<接続文字列>" --data-only --no-owner --schema=auth --table=identities /work/backup.dump
```

```bash
docker run --rm -v "$PWD:/work" postgres:17 pg_restore --dbname="<接続文字列>" --data-only --no-owner --schema=private /work/backup.dump
```

Windows の Git Bash では、パスの変換を止めるため、各コマンドの前に `MSYS_NO_PATHCONV=1` を付ける。

### 4.4 確認

管理画面にログインし、予約・利用者・リソースが戻っていることを確かめる。復号した `backup.dump` は暗号化されていないので、作業が終わったら消す。

---

## 5. 引き継ぎ

開発者が卒業する前に、次のものを後任に渡す。

| 渡すもの | 方法 |
| --- | --- |
| GitHub リポジトリの管理権限 | Settings → Collaborators で Admin にする（または Organization に移す） |
| Supabase プロジェクトの権限 | Organization に後任を Owner として招待する |
| `BACKUP_PASSPHRASE` と DB のパスワード | 直接、安全な方法で渡す（チャットやメールに平文で書かない） |
| 管理者アカウント | 管理画面で後任を管理者に追加する |

開発の始め方（ローカル環境、テスト、作業の決まり）は、リポジトリの `CLAUDE.md` と `README.md` に書いてある。

---

## 6. 容量と費用の目安

- 操作ログが1日150行程度でも、データベースは年間約30MB。無料プランの 500MB は問題にならない（要件定義 8章）
- バックアップの成果物は1回あたり数百KB程度で、90日で自動的に消える

-- スキーマ・テーブル・権限（基本設計 1章・2章）
--
-- テーブルは API の公開対象でない private スキーマに置き、
-- public には security definer の RPC 関数だけを置く。

-- ============================================================
-- 既定の権限
-- ============================================================

-- PostgreSQL は新しい関数の実行権を既定で PUBLIC に与える。
-- Supabase はさらに public スキーマの関数・テーブルを anon / authenticated に与える。
-- これらを取り消し、公開する関数は関数ごとに明示的に grant する。
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

-- ============================================================
-- private スキーマ
-- ============================================================
create schema private;

revoke all on schema private from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on functions from public, anon, authenticated;

-- updated_at を自動で更新するトリガー関数
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ============================================================
-- 入口トークン
-- ============================================================
create table private.entry_tokens (
  id          bigint generated always as identity primary key,
  token       text not null unique,
  issued_at   timestamptz not null default now(),
  issued_by   uuid references auth.users (id) on delete set null,  -- 初回の発行は NULL
  revoked_at  timestamptz                                           -- 再発行で無効にした日時
);

-- 有効なトークンは常に1つだけ
create unique index entry_tokens_one_active on private.entry_tokens ((true)) where revoked_at is null;

-- ============================================================
-- 利用者
-- ============================================================
create table private.users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (name = btrim(name) and char_length(name) between 1 and 50),
  cohort        integer check (cohort > 0),                         -- NULL なら教員
  memo          text not null default '' check (char_length(memo) <= 500),
  suspended_at  timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 識別子は「氏名＋期生」（教員は期生なし）。削除済みは対象外
create unique index users_identity on private.users (name, cohort) nulls not distinct
  where deleted_at is null;

create trigger users_updated_at before update on private.users
  for each row execute function private.set_updated_at();

-- ============================================================
-- 管理者（Supabase Auth のユーザー）
-- ============================================================
create table private.admins (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 50),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null
);

-- ============================================================
-- リソース
-- ============================================================
create table private.resources (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (name = btrim(name) and char_length(name) between 1 and 50),
  memo_md       text not null default '',
  sort_order    integer not null default 0,
  paused_at     timestamptz,
  pause_reason  text,
  deleted_at    timestamptz,                                         -- 論理削除。名前は残す
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index resources_name on private.resources (name) where deleted_at is null;

create trigger resources_updated_at before update on private.resources
  for each row execute function private.set_updated_at();

-- ============================================================
-- 予約（予約・予約なしの利用・封鎖）
-- 状態は保存せず、時刻から導出する（要件定義 4章）
-- ============================================================
create table private.reservations (
  id              uuid primary key default gen_random_uuid(),
  resource_id     uuid not null references private.resources (id),
  user_id         uuid references private.users (id),              -- 封鎖のときは NULL
  kind            text not null check (kind in ('reservation', 'walk_in', 'block')),
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  checked_in_at   timestamptz,
  checked_out_at  timestamptz,
  cancelled_at    timestamptz,
  block_reason    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint reservations_time_order   check (end_at > start_at),
  constraint reservations_block_user   check ((kind = 'block') = (user_id is null)),
  constraint reservations_block_reason check (kind = 'block' or block_reason is null),
  constraint reservations_block_no_checkin  check (kind <> 'block' or checked_in_at is null),
  constraint reservations_walk_in_checkin   check (kind <> 'walk_in' or checked_in_at is not null)
);

create index reservations_resource_start on private.reservations (resource_id, start_at);
create index reservations_user_start on private.reservations (user_id, start_at);

create trigger reservations_updated_at before update on private.reservations
  for each row execute function private.set_updated_at();

-- ============================================================
-- お知らせ
-- ============================================================
create table private.announcements (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(btrim(title)) between 1 and 100),
  body_md           text not null,
  importance        text not null check (importance in ('normal', 'important')),
  publish_start_at  timestamptz not null,
  publish_end_at    timestamptz,                                     -- NULL なら無期限
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint announcements_publish_order check (publish_end_at is null or publish_end_at > publish_start_at)
);

create trigger announcements_updated_at before update on private.announcements
  for each row execute function private.set_updated_at();

-- ============================================================
-- 操作ログ
-- ============================================================
create table private.action_logs (
  id              bigint generated always as identity primary key,
  actor_type      text not null check (actor_type in ('user', 'admin')),
  actor_user_id   uuid references private.users (id),
  -- Auth のユーザーが消えてもログは残すため、外部キーは付けない
  actor_admin_id  uuid,
  action          text not null,
  target_type     text not null
                  check (target_type in ('reservation', 'user', 'resource', 'announcement', 'token', 'admin')),
  target_id       text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint action_logs_actor check (
    (actor_type = 'user'  and actor_user_id  is not null) or
    (actor_type = 'admin' and actor_admin_id is not null)
  )
);

create index action_logs_created on private.action_logs (created_at);
create index action_logs_actor_user on private.action_logs (actor_user_id, created_at);
create index action_logs_target on private.action_logs (target_type, target_id);

-- ============================================================
-- 権限の取り消しと RLS（多重の防御）
-- テーブルには RPC 関数（security definer、所有者は postgres）からのみ触れる
-- ============================================================
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

alter table private.entry_tokens  enable row level security;
alter table private.users         enable row level security;
alter table private.admins        enable row level security;
alter table private.resources     enable row level security;
alter table private.reservations  enable row level security;
alter table private.announcements enable row level security;
alter table private.action_logs   enable row level security;

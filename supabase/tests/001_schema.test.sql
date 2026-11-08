-- スキーマ・テーブル・権限のテスト（基本設計 1章・2章）
begin;

-- seed.sql の初期データに左右されないよう、空の状態から始める（rollback で元に戻る）
truncate private.action_logs, private.reservations, private.entry_tokens, private.admins,
         private.announcements, private.users, private.resources;

select plan(38);

-- ------------------------------------------------------------
-- スキーマとテーブル
-- ------------------------------------------------------------
select has_schema('private', 'private スキーマがある');

select has_table('private', 'entry_tokens',  '入口トークンの表がある');
select has_table('private', 'users',         '利用者の表がある');
select has_table('private', 'admins',        '管理者の表がある');
select has_table('private', 'resources',     'リソースの表がある');
select has_table('private', 'reservations',  '予約の表がある');
select has_table('private', 'announcements', 'お知らせの表がある');
select has_table('private', 'action_logs',   '操作ログの表がある');

select columns_are('private', 'entry_tokens',
  array['id', 'token', 'issued_at', 'issued_by', 'revoked_at'],
  '入口トークンの列が設計どおり');
select columns_are('private', 'users',
  array['id', 'name', 'cohort', 'memo', 'suspended_at', 'deleted_at', 'created_at', 'updated_at'],
  '利用者の列が設計どおり');
select columns_are('private', 'admins',
  array['user_id', 'display_name', 'created_at', 'created_by'],
  '管理者の列が設計どおり');
select columns_are('private', 'resources',
  array['id', 'name', 'memo_md', 'sort_order', 'paused_at', 'pause_reason', 'deleted_at', 'created_at', 'updated_at'],
  'リソースの列が設計どおり');
select columns_are('private', 'reservations',
  array['id', 'resource_id', 'user_id', 'kind', 'start_at', 'end_at', 'checked_in_at', 'checked_out_at',
        'cancelled_at', 'block_reason', 'created_at', 'updated_at'],
  '予約の列が設計どおり');
select columns_are('private', 'announcements',
  array['id', 'title', 'body_md', 'importance', 'publish_start_at', 'publish_end_at', 'deleted_at',
        'created_at', 'updated_at'],
  'お知らせの列が設計どおり');
select columns_are('private', 'action_logs',
  array['id', 'actor_type', 'actor_user_id', 'actor_admin_id', 'action', 'target_type', 'target_id',
        'detail', 'created_at'],
  '操作ログの列が設計どおり');

-- ------------------------------------------------------------
-- 権限（anon にテーブルの権限を与えない）
-- ------------------------------------------------------------
select is(
  (select count(*) from pg_catalog.pg_tables where schemaname = 'public'),
  0::bigint,
  'public スキーマにテーブルを置かない');

select ok(
  not has_schema_privilege('anon', 'private', 'USAGE')
    and not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'anon / authenticated は private スキーマを使えない');

select is(
  (select count(*)
     from pg_catalog.pg_tables t
     cross join (values ('anon'), ('authenticated')) as r(role)
    where t.schemaname = 'private'
      and has_table_privilege(r.role, format('%I.%I', t.schemaname, t.tablename),
                              'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  0::bigint,
  'anon / authenticated は private のテーブルに一切の権限を持たない');

select is(
  (select count(*) from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relkind = 'r' and not c.relrowsecurity),
  0::bigint,
  'private のテーブルはすべて RLS が有効（多重の防御）');

-- 新しく作った関数は、明示的に grant しない限り anon / authenticated から実行できない
create function public.__test_default_privilege() returns int language sql as 'select 1';

select ok(
  not has_function_privilege('anon', 'public.__test_default_privilege()', 'EXECUTE'),
  'public の新しい関数は既定で anon から実行できない');
select ok(
  not has_function_privilege('authenticated', 'public.__test_default_privilege()', 'EXECUTE'),
  'public の新しい関数は既定で authenticated から実行できない');

-- ------------------------------------------------------------
-- 利用者の制約
-- ------------------------------------------------------------
insert into private.users (id, name, cohort) values
  ('00000000-0000-0000-0000-000000000001', '山田太郎', null),
  ('00000000-0000-0000-0000-000000000002', '山田太郎', 75);

select throws_ok(
  $$insert into private.users (name, cohort) values ('山田太郎', null)$$,
  '23505', null,
  '同じ氏名の教員（期生なし）は重複して登録できない');
select throws_ok(
  $$insert into private.users (name, cohort) values ('山田太郎', 75)$$,
  '23505', null,
  '同じ氏名・期生の生徒は重複して登録できない');
select lives_ok(
  $$insert into private.users (name, cohort) values ('山田太郎', 76)$$,
  '期生が違えば登録できる');

update private.users set deleted_at = now() where id = '00000000-0000-0000-0000-000000000001';
select lives_ok(
  $$insert into private.users (name, cohort) values ('山田太郎', null)$$,
  '削除済みのアカウントと同じ識別子なら新しく登録できる');

select throws_ok(
  $$insert into private.users (name, cohort) values ('佐藤花子', 0)$$,
  '23514', null,
  '期生は正の数');
select throws_ok(
  $$insert into private.users (name) values ('   ')$$,
  '23514', null,
  '氏名は空白だけにできない');
select throws_ok(
  $$insert into private.users (name, memo) values ('佐藤花子', repeat('あ', 501))$$,
  '23514', null,
  'メモは500文字まで');

-- ------------------------------------------------------------
-- リソースの制約
-- ------------------------------------------------------------
insert into private.resources (id, name) values ('10000000-0000-0000-0000-000000000001', '3Dプリンタ');

select throws_ok(
  $$insert into private.resources (name) values ('3Dプリンタ')$$,
  '23505', null,
  '削除されていないリソースの名前は重複できない');

-- ------------------------------------------------------------
-- 予約の制約
-- ------------------------------------------------------------
select throws_ok(
  $$insert into private.reservations (resource_id, user_id, kind, start_at, end_at)
    values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
            'reservation', now(), now())$$,
  '23514', null,
  '終了は開始より後');
select throws_ok(
  $$insert into private.reservations (resource_id, user_id, kind, start_at, end_at)
    values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
            'block', now(), now() + interval '1 hour')$$,
  '23514', null,
  '封鎖には利用者を付けない');
select throws_ok(
  $$insert into private.reservations (resource_id, user_id, kind, start_at, end_at)
    values ('10000000-0000-0000-0000-000000000001', null,
            'reservation', now(), now() + interval '1 hour')$$,
  '23514', null,
  '封鎖以外には利用者が必要');
select throws_ok(
  $$insert into private.reservations (resource_id, user_id, kind, start_at, end_at)
    values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
            'walk_in', now(), now() + interval '1 hour')$$,
  '23514', null,
  '予約なしの利用はチェックイン日時が必要');
select throws_ok(
  $$insert into private.reservations (resource_id, user_id, kind, start_at, end_at)
    values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
            'other', now(), now() + interval '1 hour')$$,
  '23514', null,
  '種別は reservation / walk_in / block のいずれか');

-- ------------------------------------------------------------
-- 入口トークンの制約
-- ------------------------------------------------------------
insert into private.entry_tokens (token) values ('token-a');

select throws_ok(
  $$insert into private.entry_tokens (token) values ('token-b')$$,
  '23505', null,
  '有効なトークンは常に1つだけ');

update private.entry_tokens set revoked_at = now() where token = 'token-a';
select lives_ok(
  $$insert into private.entry_tokens (token) values ('token-b')$$,
  '古いトークンを無効にすれば新しいトークンを作れる');

-- ------------------------------------------------------------
-- お知らせの制約
-- ------------------------------------------------------------
select throws_ok(
  $$insert into private.announcements (title, body_md, importance, publish_start_at)
    values ('t', 'b', 'urgent', now())$$,
  '23514', null,
  '重要度は normal / important のいずれか');
select throws_ok(
  $$insert into private.announcements (title, body_md, importance, publish_start_at, publish_end_at)
    values ('t', 'b', 'normal', now(), now())$$,
  '23514', null,
  '公開の終了は開始より後');

select * from finish();
rollback;

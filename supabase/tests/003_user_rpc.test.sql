-- 利用者とトークンの RPC のテスト（基本設計 3章）
-- check_token / create_user / login_user / update_profile / get_home / get_day
begin;

-- seed.sql の初期データに左右されないよう、空の状態から始める（rollback で元に戻る）
truncate private.action_logs, private.reservations, private.entry_tokens, private.admins,
         private.announcements, private.users, private.resources;

select plan(34);

-- ------------------------------------------------------------
-- テスト用のデータ（postgres として用意する）
-- ------------------------------------------------------------
insert into private.entry_tokens (token, revoked_at) values ('old-token', now());
insert into private.entry_tokens (token) values ('tok');

insert into private.users (id, name, cohort, memo) values
  ('00000000-0000-0000-0000-000000000001', '既存生徒', 75, 'メモA'),
  ('00000000-0000-0000-0000-000000000002', '既存教員', null, ''),
  ('00000000-0000-0000-0000-000000000003', '削除済み', 75, '');
update private.users set deleted_at = now() where id = '00000000-0000-0000-0000-000000000003';

insert into private.resources (id, name, sort_order) values
  ('10000000-0000-0000-0000-000000000001', '3Dプリンタ', 2),
  ('10000000-0000-0000-0000-000000000002', 'PC1', 1),
  ('10000000-0000-0000-0000-000000000003', '削除済みPC', 0);
update private.resources set deleted_at = now() where id = '10000000-0000-0000-0000-000000000003';

-- 未来の日（2030-01-10）の予約
insert into private.reservations (id, resource_id, user_id, kind, start_at, end_at, cancelled_at, block_reason) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2030-01-10 10:00+09', '2030-01-10 11:00+09', null, null),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2030-01-10 11:00+09', '2030-01-10 12:00+09', now(), null),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', null,
   'block',       '2030-01-10 10:00+09', '2030-01-10 12:00+09', null, 'メンテナンス'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2030-01-11 00:30+09', '2030-01-11 01:00+09', null, null),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002',
   'reservation', '2030-01-09 23:30+09', '2030-01-10 00:30+09', null, null);

-- 過去の日（2026-01-01）の予約
insert into private.reservations (id, resource_id, user_id, kind, start_at, end_at, checked_in_at) values
  ('20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2026-01-01 10:00+09', '2026-01-01 11:00+09', '2026-01-01 10:00+09'),
  ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', '2026-01-01 10:00+09', '2026-01-01 11:00+09', null);

insert into private.announcements (id, title, body_md, importance, publish_start_at, publish_end_at, deleted_at) values
  ('30000000-0000-0000-0000-000000000001', '通常',   'b', 'normal',    now() - interval '1 day',  null,                     null),
  ('30000000-0000-0000-0000-000000000002', '重要',   'b', 'important', now() - interval '1 hour', now() + interval '1 day', null),
  ('30000000-0000-0000-0000-000000000003', '予定',   'b', 'normal',    now() + interval '1 day',  null,                     null),
  ('30000000-0000-0000-0000-000000000004', '終了',   'b', 'normal',    now() - interval '2 days', now() - interval '1 day', null),
  ('30000000-0000-0000-0000-000000000005', '削除',   'b', 'normal',    now() - interval '1 day',  null,                     now());

-- エラーのコードと detail を取り出す補助（呼び出し元のロールで実行する）
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare
  v_detail text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return jsonb_build_object('code', sqlerrm, 'detail', nullif(v_detail, '')::jsonb);
end;
$$;
grant execute on function pg_temp.err(text) to anon;

-- ------------------------------------------------------------
-- 関数の形と権限
-- ------------------------------------------------------------
select is(
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (not p.prosecdef
           or not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))),
  0::bigint,
  'public の関数はすべて security definer で search_path を指定している');

select ok(
  has_function_privilege('anon', 'public.check_token(text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.create_user(text, text, integer, text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.login_user(text, text, integer)', 'EXECUTE')
    and has_function_privilege('anon', 'public.update_profile(text, uuid, text, integer, text)', 'EXECUTE')
    and has_function_privilege('anon', 'public.get_home(text, uuid, date)', 'EXECUTE')
    and has_function_privilege('anon', 'public.get_day(text, uuid, date)', 'EXECUTE'),
  'anon は利用者向けの RPC を実行できる');

-- ここからは anon（ブラウザからの呼び出し）として実行する
set local role anon;

-- ------------------------------------------------------------
-- check_token
-- ------------------------------------------------------------
select is((public.check_token('tok') ->> 'ok')::boolean, true, '有効なトークンなら ok');
select throws_ok($$select public.check_token('old-token')$$, 'P0001', 'INVALID_TOKEN',
  '無効なトークンは拒否する');

-- ------------------------------------------------------------
-- create_user
-- ------------------------------------------------------------
select is(public.create_user('tok', '  新規生徒  ', 76, 'メモ') ->> 'name', '新規生徒',
  'アカウントを作成し、氏名の前後の空白を除く');
select is(public.create_user('tok', '新規教員', null, null) -> 'cohort', 'null'::jsonb,
  '期生なし（教員）でも作成できる');
select is(
  pg_temp.err($$select public.create_user('tok', '既存生徒', 75, '')$$),
  jsonb_build_object('code', 'IDENTITY_CONFLICT',
                     'detail', jsonb_build_object('id', '00000000-0000-0000-0000-000000000001',
                                                  'name', '既存生徒', 'cohort', 75, 'memo', 'メモA')),
  '同じ識別子なら IDENTITY_CONFLICT で、既存の人の情報を detail に入れる');
select is(pg_temp.err($$select public.create_user('tok', '既存教員', null, '')$$) ->> 'code', 'IDENTITY_CONFLICT',
  '教員どうしでも同じ氏名なら衝突する');
select lives_ok($$select public.create_user('tok', '削除済み', 75, '')$$,
  '削除済みのアカウントと同じ識別子なら作成できる');
select is(pg_temp.err($$select public.create_user('tok', '   ', 75, '')$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "name"}}'::jsonb,
  '空白だけの氏名は INVALID_INPUT');
select is(pg_temp.err($$select public.create_user('tok', '生徒X', 0, '')$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "cohort"}}'::jsonb,
  '期生が正の数でなければ INVALID_INPUT');
select is(pg_temp.err($$select public.create_user('tok', '生徒X', 75, repeat('あ', 501))$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "memo"}}'::jsonb,
  'メモが500文字を超えれば INVALID_INPUT');
select throws_ok($$select public.create_user('old-token', '生徒Y', 75, '')$$, 'P0001', 'INVALID_TOKEN',
  'create_user はトークンを確認する');

-- ------------------------------------------------------------
-- login_user
-- ------------------------------------------------------------
select is(public.login_user('tok', '既存生徒', 75) ->> 'id', '00000000-0000-0000-0000-000000000001',
  '氏名と期生でログインできる');
select is(public.login_user('tok', ' 既存教員 ', null) ->> 'id', '00000000-0000-0000-0000-000000000002',
  '教員は氏名だけでログインできる');
select throws_ok($$select public.login_user('tok', '既存生徒', 76)$$, 'P0001', 'USER_NOT_FOUND',
  '識別子が一致しなければ USER_NOT_FOUND');
select is(
  public.login_user('tok', '削除済み', 75) ->> 'id' <> '00000000-0000-0000-0000-000000000003',
  true,
  '削除済みのアカウントにはログインできない（同じ識別子の新しいアカウントになる）');

-- ------------------------------------------------------------
-- update_profile
-- ------------------------------------------------------------
select is(
  public.update_profile('tok', '00000000-0000-0000-0000-000000000001', '既存生徒', 75, '新しいメモ') ->> 'memo',
  '新しいメモ',
  '本人がメモを変更できる');
select is(
  public.update_profile('tok', '00000000-0000-0000-0000-000000000001', '改名生徒', 80, '新しいメモ')
    - 'id' - 'suspended',
  '{"name": "改名生徒", "cohort": 80, "memo": "新しいメモ"}'::jsonb,
  '本人が氏名と期生を変更できる');
select is(
  pg_temp.err($$select public.update_profile('tok', '00000000-0000-0000-0000-000000000001', '既存教員', null, '')$$)
    ->> 'code',
  'IDENTITY_CONFLICT',
  '他の人と同じ識別子には変更できない');
select throws_ok(
  $$select public.update_profile('tok', '00000000-0000-0000-0000-000000000003', 'x', 75, '')$$,
  'P0001', 'USER_NOT_FOUND',
  '削除済みのアカウントは変更できない');
select throws_ok(
  $$select public.update_profile('old-token', '00000000-0000-0000-0000-000000000001', 'x', 75, '')$$,
  'P0001', 'INVALID_TOKEN',
  'update_profile はトークンを確認する');

-- ------------------------------------------------------------
-- get_home / get_day
-- ------------------------------------------------------------
select is(public.get_home('tok', null, '2030-01-10') -> 'me', 'null'::jsonb,
  '未ログインなら me は null');
select is(
  (select array_agg(x ->> 'name' order by ord)
     from jsonb_array_elements(public.get_home('tok', null, '2030-01-10') -> 'resources') with ordinality as t(x, ord)),
  array['PC1', '3Dプリンタ'],
  'リソースは削除済みを除き、並び順で返す');
select is(
  (select array_agg(x ->> 'id' order by x ->> 'id')
     from jsonb_array_elements(public.get_home('tok', null, '2030-01-10') -> 'reservations') x),
  array['20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003',
        '20000000-0000-0000-0000-000000000005'],
  'その日にかかる占有中の予約を返す（キャンセルと別の日を除き、日をまたぐものは含む）');
select is(
  (select x - 'start_at' - 'end_at' - 'effective_end' - 'checked_in_at'
     from jsonb_array_elements(
            public.get_home('tok', '00000000-0000-0000-0000-000000000001', '2030-01-10') -> 'reservations') x
    where x ->> 'id' = '20000000-0000-0000-0000-000000000001'),
  jsonb_build_object(
    'id', '20000000-0000-0000-0000-000000000001',
    'resource_id', '10000000-0000-0000-0000-000000000001',
    'kind', 'reservation', 'status', 'reserved', 'block_reason', null, 'is_mine', true,
    'user', jsonb_build_object('id', '00000000-0000-0000-0000-000000000001',
                               'name', '改名生徒', 'cohort', 80, 'memo', '新しいメモ')),
  '予約には予約者の氏名とメモ、自分の予約かどうかを付ける');
select is(
  (select x -> 'user' from jsonb_array_elements(public.get_home('tok', null, '2030-01-10') -> 'reservations') x
    where x ->> 'id' = '20000000-0000-0000-0000-000000000003'),
  'null'::jsonb,
  '封鎖には予約者を付けない');
select is(
  (select array_agg(x ->> 'id' order by x ->> 'start_at')
     from jsonb_array_elements(
            public.get_home('tok', '00000000-0000-0000-0000-000000000001', '2030-01-10') -> 'my_reservations') x),
  array['20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004'],
  '自分の予約は、日付に関係なく予約済み・利用中のものを返す');
select is(
  (select array_agg(x ->> 'title' order by ord)
     from jsonb_array_elements(public.get_home('tok', null, '2030-01-10') -> 'announcements')
          with ordinality as t(x, ord)),
  array['重要', '通常'],
  'お知らせは公開中のものだけを、重要なものから返す');
select is(
  (public.get_home('tok', '00000000-0000-0000-0000-000000000001', '2030-01-10') -> 'me' ->> 'name'),
  '改名生徒',
  'ログイン中なら me に自分の情報を返す');
select throws_ok(
  $$select public.get_home('tok', '00000000-0000-0000-0000-000000000003', '2030-01-10')$$,
  'P0001', 'USER_NOT_FOUND',
  '削除済みの利用者 ID なら USER_NOT_FOUND（フロントはログアウトする）');
select throws_ok($$select public.get_home('old-token', null, '2030-01-10')$$, 'P0001', 'INVALID_TOKEN',
  'get_home はトークンを確認する');
select is(
  (select array_agg(x ->> 'id' order by x ->> 'id')
     from jsonb_array_elements(public.get_day('tok', null, '2026-01-01') -> 'reservations') x),
  array['20000000-0000-0000-0000-000000000011'],
  '過去の日は利用した予約を返し、無断不参加だったものは返さない');

-- ------------------------------------------------------------
-- 操作ログ（postgres に戻して確認する）
-- ------------------------------------------------------------
reset role;

select is(
  (select array_agg(action order by id) from private.action_logs),
  array['user.create', 'user.create', 'user.create', 'user.login', 'user.login', 'user.login',
        'user.update', 'user.update'],
  'アカウントの作成・ログイン・変更を操作ログに残す');

select * from finish();
rollback;

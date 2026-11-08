-- 管理者の RPC のテスト（基本設計 4章、要件定義 6章）
begin;

-- seed.sql の初期データに左右されないよう、空の状態から始める（rollback で元に戻る）
truncate private.action_logs, private.reservations, private.entry_tokens, private.admins,
         private.announcements, private.users, private.resources;

select plan(64);

-- ------------------------------------------------------------
-- 補助
-- ------------------------------------------------------------
create function pg_temp.t(p text) returns timestamptz language sql stable as $$
  select date_trunc('minute', now()) + p::interval
$$;

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

-- JWT の利用者を切り替える（auth.uid() が返す値）
create function pg_temp.login_as(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
                    case when p_uid is null then ''
                         else jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text end,
                    true)
$$;

-- 予約の状態（postgres の権限で読む）
create function pg_temp.st(p_id uuid) returns text language sql security definer as $$
  select private.reservation_status(r) from private.reservations r where r.id = p_id
$$;

-- 作成したお知らせの ID（テストでは1件しか作らない）
create view pg_temp.ann as
  select jsonb_build_object('id', a.id) as x from private.announcements a;

grant execute on function pg_temp.t(text), pg_temp.err(text), pg_temp.login_as(uuid), pg_temp.st(uuid)
  to authenticated;
grant select on pg_temp.ann to authenticated;

-- ------------------------------------------------------------
-- テスト用のデータ
-- ------------------------------------------------------------
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@example.com'),
  ('a0000000-0000-0000-0000-000000000002', 'staff@example.com');
insert into private.admins (user_id, display_name) values ('a0000000-0000-0000-0000-000000000001', '管理者');

insert into private.entry_tokens (token) values ('tok');

insert into private.users (id, name, cohort, memo) values
  ('00000000-0000-0000-0000-000000000001', 'U1', 75, ''),
  ('00000000-0000-0000-0000-000000000002', 'U2', 75, ''),
  ('00000000-0000-0000-0000-000000000003', 'U3', 75, 'メモ'),
  ('00000000-0000-0000-0000-000000000006', '重複', 75, '');
-- 6 は削除済み。7 が同じ識別子で作り直された
update private.users set deleted_at = now() where id = '00000000-0000-0000-0000-000000000006';
insert into private.users (id, name, cohort, memo) values ('00000000-0000-0000-0000-000000000007', '重複', 75, '');

insert into private.resources (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'R1'),
  ('10000000-0000-0000-0000-000000000002', 'R2'),
  ('10000000-0000-0000-0000-000000000003', 'R3'),
  ('10000000-0000-0000-0000-000000000004', 'R4');

insert into private.reservations (id, resource_id, user_id, kind, start_at, end_at, checked_in_at, block_reason) values
  ('2000000a-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('1 hour'), pg_temp.t('2 hours'), null, null),                   -- a
  ('2000000b-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('-30 minutes'), pg_temp.t('30 minutes'), pg_temp.t('-30 minutes'), null), -- b 利用中
  ('2000000c-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   'reservation', pg_temp.t('3 hours'), pg_temp.t('4 hours'), null, null),                  -- c
  ('2000000d-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003',
   'reservation', pg_temp.t('1 hour'), pg_temp.t('2 hours'), null, null),                   -- d
  ('2000000e-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003',
   'reservation', pg_temp.t('-10 minutes'), pg_temp.t('1 hour'), pg_temp.t('-10 minutes'), null), -- e 利用中
  ('2000000f-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('5 hours'), pg_temp.t('6 hours'), null, null),                  -- f
  ('20000010-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', null,
   'block', pg_temp.t('7 hours'), pg_temp.t('8 hours'), null, '点検');                       -- g

-- ------------------------------------------------------------
-- 権限
-- ------------------------------------------------------------
select is(
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'admin\_%' and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0::bigint,
  'anon は管理者の RPC を実行できない');
select is(
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'admin\_%'
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0::bigint,
  'authenticated は管理者の RPC を実行できる（中で管理者かを確認する）');

set local role authenticated;

-- 管理者でない Auth ユーザー
do $$ begin perform pg_temp.login_as('a0000000-0000-0000-0000-000000000002'); end $$;
select is(public.admin_whoami(), '{"is_admin": false, "display_name": null}'::jsonb,
  '管理者でなければ is_admin は false');
select throws_ok($$select public.admin_list_users(null, false)$$, 'P0001', 'NOT_ADMIN',
  '管理者でなければ管理者の RPC は拒否する');

-- 管理者
do $$ begin perform pg_temp.login_as('a0000000-0000-0000-0000-000000000001'); end $$;
select is(public.admin_whoami(), '{"is_admin": true, "display_name": "管理者"}'::jsonb,
  '管理者なら is_admin は true');

-- ------------------------------------------------------------
-- 予約の操作と枠の封鎖
-- ------------------------------------------------------------
select is(
  (select x - 'id' - 'start_at' - 'end_at' - 'effective_end' - 'checked_in_at' - 'checked_out_at'
            - 'cancelled_at' - 'created_at'
     from public.admin_create_block('10000000-0000-0000-0000-000000000001',
                                    pg_temp.t('2 hours'), pg_temp.t('3 hours'), 'メンテナンス') x),
  jsonb_build_object('resource_id', '10000000-0000-0000-0000-000000000001', 'resource_name', 'R1',
                     'kind', 'block', 'status', 'blocked', 'block_reason', 'メンテナンス',
                     'is_mine', false, 'user', null),
  '理由を付けて枠を封鎖できる');
select is(
  pg_temp.err($$select public.admin_create_block('10000000-0000-0000-0000-000000000001',
                pg_temp.t('90 minutes'), pg_temp.t('150 minutes'), '点検')$$) ->> 'code',
  'OVERLAP',
  '予約と重なる封鎖はできない');
select is(
  pg_temp.err($$select public.admin_create_block('10000000-0000-0000-0000-000000000003',
                pg_temp.t('9 hours'), pg_temp.t('10 hours'), '  ')$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "reason"}}'::jsonb,
  '封鎖には理由が必要');
select is(
  (select row((x ->> 'start_at')::timestamptz, (x ->> 'end_at')::timestamptz)::text
     from public.admin_update_reservation('2000000a-0000-0000-0000-000000000000',
                                          pg_temp.t('30 minutes'), pg_temp.t('90 minutes')) x),
  row(pg_temp.t('30 minutes'), pg_temp.t('90 minutes'))::text,
  '任意の予約の時刻を変更できる');
select is(
  pg_temp.err($$select public.admin_update_reservation('2000000a-0000-0000-0000-000000000000',
                null, pg_temp.t('150 minutes'))$$) ->> 'code',
  'OVERLAP',
  '変更して他の予約や封鎖と重なるならできない');
select is(public.admin_force_checkout('2000000b-0000-0000-0000-000000000000') ->> 'status', 'finished',
  '利用中の予約を強制終了できる');
select is(
  pg_temp.err($$select public.admin_force_checkout('2000000a-0000-0000-0000-000000000000')$$),
  '{"code": "INVALID_STATE", "detail": {"status": "reserved"}}'::jsonb,
  '利用中でなければ強制終了できない');
select is(public.admin_cancel_reservation('2000000a-0000-0000-0000-000000000000') ->> 'status', 'cancelled',
  '任意の予約を削除できる');
select is(
  (select public.admin_cancel_reservation((x ->> 'id')::uuid) ->> 'status'
     from jsonb_array_elements(public.admin_list_reservations(null, null, '10000000-0000-0000-0000-000000000001', null)) x
    where x ->> 'kind' = 'block'),
  'cancelled',
  '封鎖を解除できる');
select is(
  (select array_agg(x ->> 'status' order by x ->> 'start_at')
     from jsonb_array_elements(public.admin_list_reservations(
            pg_temp.t('0 minutes'), pg_temp.t('1 day'), '10000000-0000-0000-0000-000000000001', null)) x),
  array['cancelled', 'cancelled', 'reserved'],
  '予約の一覧はキャンセルを含め、リソースと期間で絞り込める');
select is(
  jsonb_array_length(public.admin_list_reservations(null, null, null, '00000000-0000-0000-0000-000000000003')),
  2,
  '予約の一覧は利用者で絞り込める');
select is(
  pg_temp.err($$select public.admin_cancel_reservation('2fffffff-0000-0000-0000-000000000000')$$) ->> 'code',
  'RESERVATION_NOT_FOUND',
  '存在しない予約は操作できない');

-- ------------------------------------------------------------
-- 利用者の管理
-- ------------------------------------------------------------
select is(
  (select array_agg(x ->> 'id' order by x ->> 'id') from jsonb_array_elements(public.admin_list_users('重複', false)) x),
  array['00000000-0000-0000-0000-000000000007'],
  '利用者の一覧は氏名で検索でき、既定では削除済みを含まない');
select is(
  jsonb_array_length(public.admin_list_users('重複', true)),
  2,
  '削除済みを含めて一覧にできる');
select is(
  public.admin_update_user('00000000-0000-0000-0000-000000000001', 'U1', 75, '管理者が変更') ->> 'memo',
  '管理者が変更',
  '利用者の情報を変更できる');
select is(
  pg_temp.err($$select public.admin_update_user('00000000-0000-0000-0000-000000000001', 'U2', 75, '')$$) ->> 'code',
  'IDENTITY_CONFLICT',
  '他の人と同じ識別子には変更できない');
select is((public.admin_suspend_user('00000000-0000-0000-0000-000000000002') ->> 'suspended')::boolean, true,
  'アカウントを利用停止できる');
select is(pg_temp.st('2000000c-0000-0000-0000-000000000000'), 'cancelled',
  '利用停止すると未来の予約はキャンセルされる');
select is((public.admin_unsuspend_user('00000000-0000-0000-0000-000000000002') ->> 'suspended')::boolean, false,
  '利用停止を解除できる');
select is(
  (select row(x ->> 'memo', x ->> 'deleted_at' is not null)::text
     from public.admin_delete_user('00000000-0000-0000-0000-000000000003') x),
  row('', true)::text,
  'アカウントを削除するとメモを消す');
select is(
  array[pg_temp.st('2000000d-0000-0000-0000-000000000000'), pg_temp.st('2000000e-0000-0000-0000-000000000000')],
  array['cancelled', 'finished'],
  'アカウントを削除すると未来の予約はキャンセルし、利用中の予約は終了させる');
select is(
  pg_temp.err($$select public.admin_delete_user('00000000-0000-0000-0000-000000000003')$$) ->> 'code',
  'USER_NOT_FOUND',
  '削除済みのアカウントは削除できない');
select is(
  pg_temp.err($$select public.admin_restore_user('00000000-0000-0000-0000-000000000006')$$) ->> 'code',
  'IDENTITY_CONFLICT',
  '同じ識別子の有効なアカウントがあれば復元できない');
select is(
  (select row(x ->> 'name', x -> 'deleted_at')::text
     from public.admin_restore_user('00000000-0000-0000-0000-000000000003') x),
  row('U3', 'null'::jsonb)::text,
  '削除したアカウントを復元できる');
select is(
  pg_temp.err($$select public.admin_restore_user('00000000-0000-0000-0000-000000000001')$$),
  '{"code": "INVALID_STATE", "detail": {"status": "active"}}'::jsonb,
  '削除されていないアカウントは復元できない');

-- ------------------------------------------------------------
-- リソースの管理
-- ------------------------------------------------------------
select is(
  public.admin_create_resource(' レーザーカッター ', '**メモ**', 5) - 'id',
  jsonb_build_object('name', 'レーザーカッター', 'memo_md', '**メモ**', 'sort_order', 5,
                     'paused', false, 'pause_reason', null, 'paused_at', null, 'deleted_at', null),
  'リソースを追加できる');
select is(
  pg_temp.err($$select public.admin_create_resource('R1', '', 0)$$) ->> 'code',
  'NAME_CONFLICT',
  '同じ名前のリソースは追加できない');
select is(
  pg_temp.err($$select public.admin_create_resource('', '', 0)$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "name"}}'::jsonb,
  'リソースの名前は必要');
select is(
  (select row(x ->> 'name', x ->> 'memo_md', x ->> 'id')::text
     from public.admin_update_resource('10000000-0000-0000-0000-000000000003', 'R3改', '新しいメモ', 3) x),
  row('R3改', '新しいメモ', '10000000-0000-0000-0000-000000000003')::text,
  'リソースの名前とメモを変更しても ID は変わらない');
select is(
  (select row(x ->> 'paused', x ->> 'pause_reason')::text
     from public.admin_pause_resource('10000000-0000-0000-0000-000000000001', '故障') x),
  row('true', '故障')::text,
  'リソースを一時停止できる');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('10 hours'), pg_temp.t('11 hours'))$$) ->> 'code',
  'RESOURCE_PAUSED',
  '一時停止中は予約できない');
select is((public.admin_resume_resource('10000000-0000-0000-0000-000000000001') ->> 'paused')::boolean, false,
  '一時停止を解除できる');
select is(
  public.admin_delete_resource('10000000-0000-0000-0000-000000000002') ->> 'deleted_at' is not null,
  true,
  'リソースを削除できる');
select is(
  array[pg_temp.st('2000000f-0000-0000-0000-000000000000'), pg_temp.st('20000010-0000-0000-0000-000000000000')],
  array['cancelled', 'cancelled'],
  'リソースを削除すると未来の予約と封鎖はキャンセルされる');
select is(
  (select x ->> 'name' from jsonb_array_elements(public.admin_list_resources()) x
    where x ->> 'id' = '10000000-0000-0000-0000-000000000002'),
  'R2',
  'リソースの一覧には削除済みも含み、削除前の名前を残す');
select is(
  pg_temp.err($$select public.admin_update_resource('10000000-0000-0000-0000-000000000002', 'x', '', 0)$$) ->> 'code',
  'RESOURCE_NOT_FOUND',
  '削除済みのリソースは変更できない');

-- ------------------------------------------------------------
-- 入口URL（トークン）
-- ------------------------------------------------------------
select is(public.admin_get_token() ->> 'token', 'tok', '現在のトークンを取得できる');
select is(
  (select row(x ->> 'token' <> 'tok', char_length(x ->> 'token'), x ->> 'token' ~ '^[A-Za-z0-9_-]+$')::text
     from public.admin_issue_token() x),
  row(true, 32, true)::text,
  'トークンを再発行できる（URL に使える32文字）');
select throws_ok($$select public.check_token('tok')$$, 'P0001', 'INVALID_TOKEN',
  '再発行すると古いトークンは即座に無効になる');
select lives_ok(format('select public.check_token(%L)', public.admin_get_token() ->> 'token'),
  '新しいトークンは有効');

-- ------------------------------------------------------------
-- お知らせの管理
-- ------------------------------------------------------------
select is(
  public.admin_create_announcement('お知らせ', '本文', 'important', pg_temp.t('-1 hour'), null)
    - 'id' - 'publish_start_at' - 'created_at',
  '{"title": "お知らせ", "body_md": "本文", "importance": "important", "publish_end_at": null,
    "deleted_at": null, "publish_state": "published"}'::jsonb,
  'お知らせを作成できる');
select is(
  pg_temp.err($$select public.admin_create_announcement('t', 'b', 'urgent', now(), null)$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "importance"}}'::jsonb,
  '重要度は normal / important');
select is(
  pg_temp.err($$select public.admin_create_announcement('t', 'b', 'normal', now(), now())$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "publish_end_at"}}'::jsonb,
  '公開の終了は開始より後');
select is(
  (select public.admin_update_announcement((x ->> 'id')::uuid, '変更後', '本文', 'normal', pg_temp.t('1 day'), null)
            ->> 'publish_state' from ann),
  'scheduled',
  'お知らせを編集でき、公開前なら予定と表示する');
select is(
  (select public.admin_delete_announcement((x ->> 'id')::uuid) ->> 'publish_state' from ann),
  'deleted',
  'お知らせを削除できる');
select is(
  (select pg_temp.err(format('select public.admin_update_announcement(%L, %L, %L, %L, now(), null)',
                             x ->> 'id', 't', 'b', 'normal')) ->> 'code' from ann),
  'ANNOUNCEMENT_NOT_FOUND',
  '削除したお知らせは編集できない');
select is(jsonb_array_length(public.admin_list_announcements(false)), 0,
  '既定ではお知らせの一覧に削除済みを含まない');
select is(jsonb_array_length(public.admin_list_announcements(true)), 1,
  '削除済みを含めて一覧にできる');

-- ------------------------------------------------------------
-- 管理者の追加（Edge Function から呼ぶ部分）
-- ------------------------------------------------------------
select is(
  pg_temp.err($$select public.admin_register_admin('a0000000-0000-0000-0000-0000000000ff', '新人')$$) ->> 'code',
  'USER_NOT_FOUND',
  'Auth のユーザーがいなければ管理者にできない');
select is(
  public.admin_register_admin('a0000000-0000-0000-0000-000000000002', '担当教員') ->> 'display_name',
  '担当教員',
  'Auth のユーザーを管理者として登録できる');
select is(
  pg_temp.err($$select public.admin_register_admin('a0000000-0000-0000-0000-000000000002', '担当教員')$$),
  '{"code": "INVALID_STATE", "detail": {"status": "admin"}}'::jsonb,
  'すでに管理者なら登録できない');
select is(
  (select array_agg(x ->> 'email' order by x ->> 'email') from jsonb_array_elements(public.admin_list_admins()) x),
  array['admin@example.com', 'staff@example.com'],
  '管理者の一覧にメールアドレスを含む');

-- ------------------------------------------------------------
-- ログの閲覧
-- ------------------------------------------------------------
select ok(
  (select bool_and(x ->> 'action' in ('user.delete', 'user.restore', 'reservation.cancel', 'reservation.force_checkout',
                                      'reservation.change')) and count(*) > 0
     from jsonb_array_elements(public.admin_list_logs(null, null, '00000000-0000-0000-0000-000000000003', null, 100, 0)
                               -> 'rows') x
    where x ->> 'actor_type' = 'admin'),
  'ログを利用者で絞り込める（その人の予約への操作も含む）');
select is(
  (select array_agg(distinct x ->> 'action' order by x ->> 'action')
     from jsonb_array_elements(public.admin_list_logs(null, null, null, '10000000-0000-0000-0000-000000000002', 100, 0)
                               -> 'rows') x),
  array['reservation.cancel', 'reservation.force_checkout', 'resource.delete'],
  'ログをリソースで絞り込める（そのリソースの予約への操作も含む）');
select is(
  (select x ->> 'target_label'
     from jsonb_array_elements(public.admin_list_logs(null, null, null, '10000000-0000-0000-0000-000000000002', 100, 0)
                               -> 'rows') x
    where x ->> 'action' = 'resource.delete'),
  'R2',
  'ログには対象の名前（削除前のリソース名）を付ける');
select is(
  (select row(jsonb_array_length(l -> 'rows'), (l ->> 'total')::int > 2)::text
     from public.admin_list_logs(null, null, null, null, 2, 0) l),
  row(2, true)::text,
  'ログは件数を指定して取得でき、全体の件数も返す');
select is(
  (select x ->> 'actor_name'
     from jsonb_array_elements(public.admin_list_logs(null, null, null, null, 1, 0) -> 'rows') x),
  '管理者',
  'ログには操作者の名前を付ける');

-- 期間で絞り込む（未来の期間には何もない）
select is(
  (public.admin_list_logs(now() + interval '1 day', null, null, null, 100, 0) ->> 'total')::int,
  0,
  'ログを期間で絞り込める');

reset role;

select is(
  (select count(*) from private.action_logs
    where actor_type <> 'admin' or actor_admin_id <> 'a0000000-0000-0000-0000-000000000001'),
  0::bigint,
  '管理者の操作は、操作した管理者を付けて記録する');

select * from finish();
rollback;

-- 予約の RPC のテスト（基本設計 3章、要件定義 4章）
-- create_reservation / cancel_reservation / change_reservation / check_in / start_walk_in / check_out
--
-- 時刻は now() からの相対で書く。トランザクション内の now() は一定なので、結果は実行時刻によらない。
-- 同時に予約したときの拒否（行ロック）は、1つのトランザクションでは再現できないので、ここでは試験しない。
begin;

select plan(43);

-- ------------------------------------------------------------
-- 補助
-- ------------------------------------------------------------
-- 現在の分（秒を切り捨てた now()）からの相対時刻
create function pg_temp.t(p text) returns timestamptz language sql stable as $$
  select date_trunc('minute', now()) + p::interval
$$;

-- エラーのコードと detail を取り出す
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

grant execute on function pg_temp.t(text) to anon;
grant execute on function pg_temp.err(text) to anon;

-- ------------------------------------------------------------
-- テスト用のデータ
-- ------------------------------------------------------------
insert into private.entry_tokens (token) values ('tok');

insert into private.users (id, name, cohort) values
  ('00000000-0000-0000-0000-000000000001', 'U1', 75),
  ('00000000-0000-0000-0000-000000000002', 'U2', 75),
  ('00000000-0000-0000-0000-000000000003', 'U3停止中', 75),
  ('00000000-0000-0000-0000-000000000004', 'U4', 75),
  ('00000000-0000-0000-0000-000000000005', 'U5', 75);
update private.users set suspended_at = now() where id = '00000000-0000-0000-0000-000000000003';

insert into private.resources (id, name) values
  ('10000000-0000-0000-0000-000000000001', 'R1作成用'),
  ('10000000-0000-0000-0000-000000000002', 'R2変更と削除用'),
  ('10000000-0000-0000-0000-000000000003', 'R3作成用'),
  ('10000000-0000-0000-0000-000000000004', 'R4チェックイン用'),
  ('10000000-0000-0000-0000-000000000005', 'R5予約なし用'),
  ('10000000-0000-0000-0000-000000000006', 'R6前倒し用'),
  ('10000000-0000-0000-0000-000000000009', 'R9一時停止中');
update private.resources set paused_at = now() where id = '10000000-0000-0000-0000-000000000009';

insert into private.reservations (id, resource_id, user_id, kind, start_at, end_at, checked_in_at) values
  -- R2: 変更と削除
  ('2000000a-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('1 hour'),   pg_temp.t('2 hours'), null),                        -- a 予約済み
  ('2000000b-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('3 hours'),  pg_temp.t('4 hours'), null),                        -- b 予約済み
  ('2000000c-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002',
   'reservation', pg_temp.t('5 hours'),  pg_temp.t('6 hours'), null),                        -- c 他人の予約
  ('2000000d-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('-30 minutes'), pg_temp.t('30 minutes'), pg_temp.t('-30 minutes')), -- d 利用中
  -- R3: 無断不参加（枠を占有しない）
  ('2000000f-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002',
   'reservation', pg_temp.t('-1 hour'), pg_temp.t('1 hour'), null),
  -- R4: チェックイン
  ('2000000e-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('-10 minutes'), pg_temp.t('50 minutes'), null),                  -- e 開始10分後
  ('2000000f-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('-20 minutes'), pg_temp.t('40 minutes'), null),                  -- f 無断不参加
  ('20000001-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('2 hours'), pg_temp.t('3 hours'), null),                         -- g 直前が埋まっている
  -- R6: 前倒し
  ('20000002-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('2 hours'), pg_temp.t('3 hours'), null),                         -- h
  ('20000003-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000003',
   'reservation', pg_temp.t('5 hours'), pg_temp.t('6 hours'), null),                         -- j 停止中の人の予約
  -- R9: 一時停止中のリソース
  ('20000004-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001',
   'reservation', pg_temp.t('1 hour'), pg_temp.t('2 hours'), null),                          -- i
  -- R5: 予約なしの利用
  ('20000005-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000002',
   'reservation', pg_temp.t('2 hours'), pg_temp.t('3 hours'), null);                         -- k

select ok(
  has_function_privilege('anon', 'public.create_reservation(text, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE')
    and has_function_privilege('anon', 'public.cancel_reservation(text, uuid, uuid)', 'EXECUTE')
    and has_function_privilege('anon', 'public.change_reservation(text, uuid, uuid, timestamptz, timestamptz)', 'EXECUTE')
    and has_function_privilege('anon', 'public.check_in(text, uuid, uuid, boolean)', 'EXECUTE')
    and has_function_privilege('anon', 'public.start_walk_in(text, uuid, uuid, timestamptz)', 'EXECUTE')
    and has_function_privilege('anon', 'public.check_out(text, uuid, uuid)', 'EXECUTE'),
  'anon は予約の RPC を実行できる');

set local role anon;

-- ------------------------------------------------------------
-- create_reservation
-- ------------------------------------------------------------
select is(
  (select x - 'id' - 'start_at' - 'end_at' - 'effective_end' - 'checked_in_at' - 'user'
     from public.create_reservation('tok', '00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
                                    pg_temp.t('1 hour'), pg_temp.t('2 hours')) x),
  jsonb_build_object('resource_id', '10000000-0000-0000-0000-000000000001', 'kind', 'reservation',
                     'status', 'reserved', 'block_reason', null, 'is_mine', true),
  '予約を作成できる');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000002',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('90 minutes'), pg_temp.t('150 minutes'))$$) ->> 'code',
  'OVERLAP',
  '同じリソースで時間帯が重なる予約はできない');
select lives_ok(
  $$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000001', pg_temp.t('2 hours'), pg_temp.t('3 hours'))$$,
  '前の予約の終了時刻ちょうどから予約できる');
select lives_ok(
  $$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000003', pg_temp.t('2 hours'), pg_temp.t('3 hours'))$$,
  '別のリソースなら同じ時間帯に予約できる（3件目）');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000004',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('4 hours'), pg_temp.t('5 hours'))$$),
  '{"code": "LIMIT_EXCEEDED", "detail": {"limit": 3}}'::jsonb,
  '予約済み＋利用中が3件あれば、新しく予約できない');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000002',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('-1 minute'), pg_temp.t('7 hours'))$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "start_at"}}'::jsonb,
  '現在の分より前に始まる予約はできない');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000002',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('8 hours'), pg_temp.t('8 hours'))$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "end_at"}}'::jsonb,
  '終了は開始より後');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000002',
                '10000000-0000-0000-0000-000000000009', pg_temp.t('8 hours'), pg_temp.t('9 hours'))$$) ->> 'code',
  'RESOURCE_PAUSED',
  '一時停止中のリソースは予約できない');
select is(
  pg_temp.err($$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000003',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('8 hours'), pg_temp.t('9 hours'))$$) ->> 'code',
  'USER_SUSPENDED',
  '利用停止中の人は予約できない');
select is(
  (public.create_reservation('tok', '00000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001',
                             pg_temp.t('5 hours 30 seconds'), pg_temp.t('6 hours')) ->> 'start_at')::timestamptz,
  pg_temp.t('5 hours'),
  '時刻は分に切り捨てる');
select lives_ok(
  $$select public.create_reservation('tok', '00000000-0000-0000-0000-000000000005',
      '10000000-0000-0000-0000-000000000003', pg_temp.t('0 minutes'), pg_temp.t('30 minutes'))$$,
  '無断不参加の予約の時間帯には予約できる');

-- ------------------------------------------------------------
-- change_reservation
-- ------------------------------------------------------------
select is(
  (public.change_reservation('tok', '00000000-0000-0000-0000-000000000001', '2000000b-0000-0000-0000-000000000000',
                             pg_temp.t('150 minutes'), null) ->> 'start_at')::timestamptz,
  pg_temp.t('150 minutes'),
  '開始前なら開始時刻を変更できる');
select is(
  pg_temp.err($$select public.change_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000b-0000-0000-0000-000000000000', pg_temp.t('90 minutes'), null)$$) ->> 'code',
  'OVERLAP',
  '開始時刻を変更して他の予約と重なるならできない');
select is(
  (public.change_reservation('tok', '00000000-0000-0000-0000-000000000001', '2000000b-0000-0000-0000-000000000000',
                             null, pg_temp.t('5 hours')) ->> 'end_at')::timestamptz,
  pg_temp.t('5 hours'),
  '次の予約の開始時刻まで延長できる');
select is(
  pg_temp.err($$select public.change_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000b-0000-0000-0000-000000000000', null, pg_temp.t('330 minutes'))$$),
  jsonb_build_object('code', 'END_EXCEEDS_NEXT', 'detail', jsonb_build_object('next_start', pg_temp.t('5 hours'))),
  '次の予約にかかる延長はできず、次の予約の開始時刻を返す');
select is(
  pg_temp.err($$select public.change_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000c-0000-0000-0000-000000000000', null, pg_temp.t('7 hours'))$$) ->> 'code',
  'NOT_OWNER',
  '他人の予約は変更できない');
select is(
  pg_temp.err($$select public.change_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000d-0000-0000-0000-000000000000', pg_temp.t('0 minutes'), null)$$),
  '{"code": "INVALID_STATE", "detail": {"status": "in_use"}}'::jsonb,
  'チェックイン後は開始時刻を変更できない');
select is(
  (public.change_reservation('tok', '00000000-0000-0000-0000-000000000001', '2000000d-0000-0000-0000-000000000000',
                             null, pg_temp.t('50 minutes')) ->> 'end_at')::timestamptz,
  pg_temp.t('50 minutes'),
  '利用中でも終了時刻を延長できる');
select is(
  pg_temp.err($$select public.change_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000b-0000-0000-0000-000000000000', pg_temp.t('-10 minutes'), null)$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "start_at"}}'::jsonb,
  '開始時刻を過去には変更できない');

-- ------------------------------------------------------------
-- cancel_reservation
-- ------------------------------------------------------------
select is(
  public.cancel_reservation('tok', '00000000-0000-0000-0000-000000000001', '2000000a-0000-0000-0000-000000000000')
    ->> 'status',
  'cancelled',
  'チェックイン前の予約を削除（キャンセル）できる');
select is(
  pg_temp.err($$select public.cancel_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000a-0000-0000-0000-000000000000')$$),
  '{"code": "INVALID_STATE", "detail": {"status": "cancelled"}}'::jsonb,
  'キャンセル済みの予約は削除できない');
select is(
  pg_temp.err($$select public.cancel_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000d-0000-0000-0000-000000000000')$$) ->> 'code',
  'INVALID_STATE',
  'チェックイン後の予約は削除できない');
select is(
  pg_temp.err($$select public.cancel_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2000000c-0000-0000-0000-000000000000')$$) ->> 'code',
  'NOT_OWNER',
  '他人の予約は削除できない');
select is(
  pg_temp.err($$select public.cancel_reservation('tok', '00000000-0000-0000-0000-000000000001',
                '2fffffff-0000-0000-0000-000000000000')$$) ->> 'code',
  'RESERVATION_NOT_FOUND',
  '存在しない予約は削除できない');

-- ------------------------------------------------------------
-- check_in
-- ------------------------------------------------------------
select is(
  public.check_in('tok', '00000000-0000-0000-0000-000000000001', '2000000e-0000-0000-0000-000000000000', false)
    ->> 'status',
  'in_use',
  '開始15分後までならチェックインできる');
select is(
  pg_temp.err($$select public.check_in('tok', '00000000-0000-0000-0000-000000000001',
                '2000000f-0000-0000-0000-000000000000', false)$$) ->> 'code',
  'CHECKIN_WINDOW_CLOSED',
  '開始15分後を過ぎたらチェックインできない');
select is(
  pg_temp.err($$select public.check_in('tok', '00000000-0000-0000-0000-000000000001',
                '20000001-0000-0000-0000-000000000000', false)$$) ->> 'code',
  'ADVANCE_REQUIRED',
  '開始前のチェックインは、前倒しを選ばないとできない');
select is(
  pg_temp.err($$select public.check_in('tok', '00000000-0000-0000-0000-000000000001',
                '20000001-0000-0000-0000-000000000000', true)$$) ->> 'code',
  'PREVIOUS_SLOT_OCCUPIED',
  '直前の時間帯が埋まっていれば前倒しできない');
select is(
  (select row(x ->> 'status', (x ->> 'start_at')::timestamptz = now(), (x ->> 'checked_in_at')::timestamptz = now())::text
     from public.check_in('tok', '00000000-0000-0000-0000-000000000001',
                          '20000002-0000-0000-0000-000000000000', true) x),
  row('in_use', true, true)::text,
  '前倒しすると開始時刻がチェックイン時刻になる');
select is(
  pg_temp.err($$select public.check_in('tok', '00000000-0000-0000-0000-000000000001',
                '20000004-0000-0000-0000-000000000000', true)$$) ->> 'code',
  'RESOURCE_PAUSED',
  '一時停止中のリソースにはチェックインできない');
select is(
  pg_temp.err($$select public.check_in('tok', '00000000-0000-0000-0000-000000000003',
                '20000003-0000-0000-0000-000000000000', true)$$) ->> 'code',
  'USER_SUSPENDED',
  '利用停止中の人はチェックインできない');
select is(
  public.cancel_reservation('tok', '00000000-0000-0000-0000-000000000003', '20000003-0000-0000-0000-000000000000')
    ->> 'status',
  'cancelled',
  '利用停止中でも自分の予約は削除できる');

-- ------------------------------------------------------------
-- start_walk_in
-- ------------------------------------------------------------
select is(
  pg_temp.err($$select public.start_walk_in('tok', '00000000-0000-0000-0000-000000000001',
                '10000000-0000-0000-0000-000000000005', pg_temp.t('3 hours'))$$),
  jsonb_build_object('code', 'END_EXCEEDS_NEXT', 'detail', jsonb_build_object('next_start', pg_temp.t('2 hours'))),
  '予約なしの利用の終了は、次の予約の開始時刻まで');
select is(
  (select x - 'id' - 'start_at' - 'end_at' - 'effective_end' - 'checked_in_at' - 'user'
     from public.start_walk_in('tok', '00000000-0000-0000-0000-000000000001',
                               '10000000-0000-0000-0000-000000000005', pg_temp.t('2 hours')) x),
  jsonb_build_object('resource_id', '10000000-0000-0000-0000-000000000005', 'kind', 'walk_in',
                     'status', 'in_use', 'block_reason', null, 'is_mine', true),
  '空いていれば予約なしで使い始められる');
select is(
  pg_temp.err($$select public.start_walk_in('tok', '00000000-0000-0000-0000-000000000002',
                '10000000-0000-0000-0000-000000000005', pg_temp.t('1 hour'))$$) ->> 'code',
  'NOT_FREE_NOW',
  '現在時刻が空いていなければ使い始められない');
select is(
  pg_temp.err($$select public.start_walk_in('tok', '00000000-0000-0000-0000-000000000004',
                '10000000-0000-0000-0000-000000000001', pg_temp.t('0 minutes'))$$),
  '{"code": "INVALID_INPUT", "detail": {"field": "end_at"}}'::jsonb,
  '終了は現在時刻より後');
select is(
  public.start_walk_in('tok', '00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
                       pg_temp.t('1 hour')) ->> 'status',
  'in_use',
  '予約が上限の3件あっても、予約なしで使い始められる');
select is(
  pg_temp.err($$select public.start_walk_in('tok', '00000000-0000-0000-0000-000000000002',
                '10000000-0000-0000-0000-000000000009', pg_temp.t('1 hour'))$$) ->> 'code',
  'RESOURCE_PAUSED',
  '一時停止中のリソースは使い始められない');

-- ------------------------------------------------------------
-- check_out
-- ------------------------------------------------------------
select is(
  public.check_out('tok', '00000000-0000-0000-0000-000000000001', '2000000e-0000-0000-0000-000000000000')
    ->> 'status',
  'finished',
  '利用中ならチェックアウトできる');
select is(
  pg_temp.err($$select public.check_out('tok', '00000000-0000-0000-0000-000000000001',
                '2000000e-0000-0000-0000-000000000000')$$),
  '{"code": "INVALID_STATE", "detail": {"status": "finished"}}'::jsonb,
  '終了した予約はチェックアウトできない');
select is(
  pg_temp.err($$select public.check_out('tok', '00000000-0000-0000-0000-000000000002',
                '2000000d-0000-0000-0000-000000000000')$$) ->> 'code',
  'NOT_OWNER',
  '他人の利用はチェックアウトできない');

-- ------------------------------------------------------------
-- 操作ログ
-- ------------------------------------------------------------
reset role;

select is(
  (select array_agg(action order by action) from (
     select action, count(*) from private.action_logs group by action) s),
  array['reservation.cancel', 'reservation.change', 'reservation.check_in', 'reservation.check_out',
        'reservation.create', 'reservation.walk_in'],
  '予約の作成・変更・削除、チェックイン、予約なしの利用、チェックアウトを操作ログに残す');

select * from finish();
rollback;

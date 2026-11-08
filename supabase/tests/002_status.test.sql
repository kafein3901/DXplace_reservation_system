-- 状態の導出と共通処理のテスト（基本設計 2章「ビューと内部関数」）
begin;

select plan(48);

-- ------------------------------------------------------------
-- テスト用のデータ
-- ------------------------------------------------------------
insert into private.users (id, name, cohort) values
  ('00000000-0000-0000-0000-000000000001', '利用者A', 75),
  ('00000000-0000-0000-0000-000000000002', '削除済み', 75),
  ('00000000-0000-0000-0000-000000000003', '停止中', 75);
update private.users set deleted_at = now()   where id = '00000000-0000-0000-0000-000000000002';
update private.users set suspended_at = now() where id = '00000000-0000-0000-0000-000000000003';

insert into private.resources (id, name) values
  ('10000000-0000-0000-0000-000000000001', '固定時刻用'),
  ('10000000-0000-0000-0000-000000000002', '重複判定用'),
  ('10000000-0000-0000-0000-000000000003', '利用中用'),
  ('10000000-0000-0000-0000-000000000004', '一時停止中'),
  ('10000000-0000-0000-0000-000000000005', '削除済み');
update private.resources set paused_at = now()  where id = '10000000-0000-0000-0000-000000000004';
update private.resources set deleted_at = now() where id = '10000000-0000-0000-0000-000000000005';

insert into private.entry_tokens (token, revoked_at) values ('old-token', now());
insert into private.entry_tokens (token) values ('valid-token');

-- 状態の導出用（固定の時刻。判定の時刻は引数 p_at で与える）
-- 開始 10:00、終了 11:00
insert into private.reservations (id, resource_id, user_id, kind, start_at, end_at,
                                  checked_in_at, checked_out_at, cancelled_at) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2026-01-01 10:00+09', '2026-01-01 11:00+09', '2026-01-01 10:00+09', null, '2026-01-01 09:00+09'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2026-01-01 10:00+09', '2026-01-01 11:00+09', '2026-01-01 10:00+09', '2026-01-01 10:30+09', null),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2026-01-01 10:00+09', '2026-01-01 11:00+09', '2026-01-01 10:05+09', null, null),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'reservation', '2026-01-01 10:00+09', '2026-01-01 11:00+09', null, null, null),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', null,
   'block',       '2026-01-01 10:00+09', '2026-01-01 11:00+09', null, null, null),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'walk_in',     '2026-01-01 10:00+09', '2026-01-01 11:00+09', '2026-01-01 10:00+09', null, null);

-- 重複判定用（now() からの相対時刻。トランザクション内の now() は一定）
--   A 予約済み      [+1h, +2h)
--   B キャンセル    [+2h, +3h)
--   C 無断不参加    [-1h, +50m)
--   D 途中で終了    [-3h, +30m)、-2h にチェックアウト
--   E 封鎖          [+5h, +6h)
--   F 利用中（別リソース） [-10m, +1h)
insert into private.reservations (id, resource_id, user_id, kind, start_at, end_at,
                                  checked_in_at, checked_out_at, cancelled_at, block_reason) values
  ('30000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', now() + interval '1 hour', now() + interval '2 hours', null, null, null, null),
  ('30000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', now() + interval '2 hours', now() + interval '3 hours', null, null, now(), null),
  ('30000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', now() - interval '1 hour', now() + interval '50 minutes', null, null, null, null),
  ('30000000-0000-0000-0000-00000000000d', '10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'reservation', now() - interval '3 hours', now() + interval '30 minutes',
   now() - interval '3 hours', now() - interval '2 hours', null, null),
  ('30000000-0000-0000-0000-00000000000e', '10000000-0000-0000-0000-000000000002', null,
   'block', now() + interval '5 hours', now() + interval '6 hours', null, null, null, 'メンテナンス'),
  ('30000000-0000-0000-0000-00000000000f', '10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'reservation', now() - interval '10 minutes', now() + interval '1 hour', now() - interval '10 minutes', null, null, null);

-- 状態を返す補助（テストを読みやすくするため）
create function pg_temp.st(p_id uuid, p_at timestamptz) returns text language sql as $$
  select private.reservation_status(r, p_at) from private.reservations r where r.id = p_id
$$;

-- ------------------------------------------------------------
-- 状態の導出
-- ------------------------------------------------------------
select is(pg_temp.st('20000000-0000-0000-0000-000000000001', '2026-01-01 10:30+09'), 'cancelled',
  'キャンセル日時があればキャンセル（チェックイン済みでも）');
select is(pg_temp.st('20000000-0000-0000-0000-000000000002', '2026-01-01 10:45+09'), 'finished',
  'チェックアウト済みなら終了');
select is(pg_temp.st('20000000-0000-0000-0000-000000000003', '2026-01-01 11:00+09'), 'finished',
  '終了時刻ちょうどで終了（強制チェックアウト）');
select is(pg_temp.st('20000000-0000-0000-0000-000000000005', '2026-01-01 10:30+09'), 'blocked',
  '封鎖は開始15分後を過ぎても封鎖のまま');
select is(pg_temp.st('20000000-0000-0000-0000-000000000003', '2026-01-01 10:59+09'), 'in_use',
  'チェックイン済みで終了前なら利用中');
select is(pg_temp.st('20000000-0000-0000-0000-000000000004', '2026-01-01 10:15+09'), 'reserved',
  '開始15分後ちょうどはまだ予約済み');
select is(pg_temp.st('20000000-0000-0000-0000-000000000004', '2026-01-01 10:15:01+09'), 'no_show',
  '開始15分後を過ぎて未チェックインなら無断不参加');
select is(pg_temp.st('20000000-0000-0000-0000-000000000004', '2026-01-01 09:00+09'), 'reserved',
  '開始前なら予約済み');
select is(pg_temp.st('20000000-0000-0000-0000-000000000006', '2026-01-01 10:30+09'), 'in_use',
  '予約なしの利用は利用中');

select ok(
  private.occupies('reserved') and private.occupies('in_use') and private.occupies('blocked')
    and not private.occupies('cancelled') and not private.occupies('finished') and not private.occupies('no_show'),
  '枠を占有するのは予約済み・利用中・封鎖だけ');

select is(
  (select private.effective_end(r) from private.reservations r where id = '20000000-0000-0000-0000-000000000002'),
  '2026-01-01 10:30+09'::timestamptz,
  '途中でチェックアウトしたら実際の終了はチェックアウト日時');
select is(
  (select private.effective_end(r) from private.reservations r where id = '20000000-0000-0000-0000-000000000003'),
  '2026-01-01 11:00+09'::timestamptz,
  'チェックアウトしていなければ実際の終了は終了時刻');

-- ------------------------------------------------------------
-- ビュー
-- ------------------------------------------------------------
select is(
  (select count(*) from private.active_users where id = '00000000-0000-0000-0000-000000000002'),
  0::bigint,
  'active_users は削除済みを含まない');
select is(
  (select count(*) from private.active_resources where id = '10000000-0000-0000-0000-000000000005'),
  0::bigint,
  'active_resources は削除済みを含まない');
select is(
  (select status from private.reservations_v where id = '30000000-0000-0000-0000-00000000000c'),
  'no_show',
  'reservations_v は現在の状態を持つ');
select is(
  (select row(resource_name, user_name, effective_end)::text from private.reservations_v
    where id = '30000000-0000-0000-0000-00000000000d'),
  row('重複判定用', '利用者A', now() - interval '2 hours')::text,
  'reservations_v はリソース名・氏名・実際の終了を持つ');

-- ------------------------------------------------------------
-- エラーの送出
-- ------------------------------------------------------------
select throws_ok(
  $$select private.raise_error('OVERLAP', '{"id": 1}'::jsonb)$$,
  'P0001', 'OVERLAP',
  'raise_error はコードをメッセージにして P0001 で送出する');

-- ------------------------------------------------------------
-- 入口トークン
-- ------------------------------------------------------------
select lives_ok($$select private.assert_token('valid-token')$$, '有効なトークンは通る');
select throws_ok($$select private.assert_token('old-token')$$, 'P0001', 'INVALID_TOKEN',
  '再発行で無効になったトークンは拒否する');
select throws_ok($$select private.assert_token('unknown')$$, 'P0001', 'INVALID_TOKEN',
  '存在しないトークンは拒否する');
select throws_ok($$select private.assert_token(null)$$, 'P0001', 'INVALID_TOKEN',
  'トークンがなければ拒否する');

-- ------------------------------------------------------------
-- 利用者
-- ------------------------------------------------------------
select is(
  (private.get_actor('valid-token', '00000000-0000-0000-0000-000000000001')).name,
  '利用者A',
  'get_actor は利用者の行を返す');
select throws_ok(
  $$select private.get_actor('valid-token', '00000000-0000-0000-0000-000000000002')$$,
  'P0001', 'USER_NOT_FOUND',
  '削除済みの利用者は見つからない扱い');
select throws_ok(
  $$select private.get_actor('valid-token', '00000000-0000-0000-0000-0000000000ff')$$,
  'P0001', 'USER_NOT_FOUND',
  '存在しない利用者は見つからない');
select throws_ok(
  $$select private.get_actor('old-token', '00000000-0000-0000-0000-000000000001')$$,
  'P0001', 'INVALID_TOKEN',
  'get_actor は先にトークンを確認する');

select throws_ok(
  $$select private.assert_not_suspended(u) from private.users u where id = '00000000-0000-0000-0000-000000000003'$$,
  'P0001', 'USER_SUSPENDED',
  '停止中の利用者は拒否する');
select lives_ok(
  $$select private.assert_not_suspended(u) from private.users u where id = '00000000-0000-0000-0000-000000000001'$$,
  '停止していない利用者は通る');

-- ------------------------------------------------------------
-- 管理者
-- ------------------------------------------------------------
insert into auth.users (id, email) values ('40000000-0000-0000-0000-000000000001', 'admin@example.com');
insert into private.admins (user_id, display_name) values ('40000000-0000-0000-0000-000000000001', '管理者');

select throws_ok($$select private.assert_admin()$$, 'P0001', 'NOT_ADMIN',
  'ログインしていなければ管理者ではない');

do $$ begin
  perform set_config('request.jwt.claims',
                     '{"sub": "40000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
end $$;
select is(private.assert_admin(), '40000000-0000-0000-0000-000000000001'::uuid,
  '管理者表にいれば管理者の ID を返す');
do $$ begin perform set_config('request.jwt.claims', '', true); end $$;

-- ------------------------------------------------------------
-- リソースのロック
-- ------------------------------------------------------------
select is(
  (private.lock_resource('10000000-0000-0000-0000-000000000002', true)).name,
  '重複判定用',
  'lock_resource はリソースの行を返す');
select throws_ok(
  $$select private.lock_resource('10000000-0000-0000-0000-0000000000ff', false)$$,
  'P0001', 'RESOURCE_NOT_FOUND',
  '存在しないリソースは見つからない');
select throws_ok(
  $$select private.lock_resource('10000000-0000-0000-0000-000000000005', false)$$,
  'P0001', 'RESOURCE_NOT_FOUND',
  '削除済みのリソースは見つからない扱い');
select throws_ok(
  $$select private.lock_resource('10000000-0000-0000-0000-000000000004', true)$$,
  'P0001', 'RESOURCE_PAUSED',
  '一時停止中のリソースは、使える状態を求めると拒否する');
select lives_ok(
  $$select private.lock_resource('10000000-0000-0000-0000-000000000004', false)$$,
  '一時停止中でも、使える状態を求めなければロックできる');

-- ------------------------------------------------------------
-- 重複の判定
-- ------------------------------------------------------------
select is(
  private.find_overlap('10000000-0000-0000-0000-000000000002',
                       now() + interval '90 minutes', now() + interval '100 minutes', null),
  '30000000-0000-0000-0000-00000000000a'::uuid,
  '予約済みの予約と重なれば、その予約を返す');
select is(
  private.find_overlap('10000000-0000-0000-0000-000000000002',
                       now() + interval '2 hours', now() + interval '3 hours', null),
  null,
  '終了時刻ちょうどから始まる区間とキャンセルした予約は重ならない');
select is(
  private.find_overlap('10000000-0000-0000-0000-000000000002', now(), now() + interval '50 minutes', null),
  null,
  '無断不参加と終了した予約は枠を占有しない');
select is(
  private.find_overlap('10000000-0000-0000-0000-000000000002',
                       now() + interval '330 minutes', now() + interval '7 hours', null),
  '30000000-0000-0000-0000-00000000000e'::uuid,
  '封鎖と重なれば、その封鎖を返す');
select is(
  private.find_overlap('10000000-0000-0000-0000-000000000002',
                       now() + interval '90 minutes', now() + interval '100 minutes',
                       '30000000-0000-0000-0000-00000000000a'),
  null,
  '除外した予約とは重ならない扱い（自分の予約の変更用）');
select is(
  private.find_overlap('10000000-0000-0000-0000-000000000002',
                       now() + interval '30 minutes', now() + interval '1 hour', null),
  null,
  '開始時刻ちょうどに終わる区間は重ならない');

-- ------------------------------------------------------------
-- 次の予約の開始時刻
-- ------------------------------------------------------------
select is(
  private.next_start('10000000-0000-0000-0000-000000000002', now(), null),
  now() + interval '1 hour',
  '次の予約の開始時刻を返す');
select is(
  private.next_start('10000000-0000-0000-0000-000000000002', now() + interval '1 hour 1 second', null),
  now() + interval '5 hours',
  'キャンセルした予約は次の予約に数えない');
select is(
  private.next_start('10000000-0000-0000-0000-000000000002', now(), '30000000-0000-0000-0000-00000000000a'),
  now() + interval '5 hours',
  '除外した予約は次の予約に数えない');
select is(
  private.next_start('10000000-0000-0000-0000-000000000002', now() + interval '7 hours', null),
  null,
  '次の予約がなければ NULL');

-- ------------------------------------------------------------
-- 保持している予約の数（上限の判定用）
-- ------------------------------------------------------------
select is(
  private.count_holding('00000000-0000-0000-0000-000000000001'),
  2,
  '予約済みと利用中だけを数える（キャンセル・無断不参加・終了は数えない）');

-- ------------------------------------------------------------
-- 操作ログ
-- ------------------------------------------------------------
create temp table log_result as
  select private.write_log('user', '00000000-0000-0000-0000-000000000001', null,
                           'reservation.create', 'reservation', '30000000-0000-0000-0000-00000000000a',
                           '{"x": 1}'::jsonb) as id;

select is(
  (select count(*) from private.action_logs l join log_result r on r.id = l.id
    where l.action = 'reservation.create' and l.detail = '{"x": 1}'::jsonb),
  1::bigint,
  'write_log は操作ログを1行追加して ID を返す');

-- ------------------------------------------------------------
-- 内部関数の権限と search_path
-- ------------------------------------------------------------
select is(
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     cross join (values ('anon'), ('authenticated')) as r(role)
    where n.nspname = 'private' and has_function_privilege(r.role, p.oid, 'EXECUTE')),
  0::bigint,
  'anon / authenticated は private の関数を実行できない');
select is(
  (select count(*) from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0::bigint,
  'private の関数はすべて search_path を指定している');

select * from finish();
rollback;

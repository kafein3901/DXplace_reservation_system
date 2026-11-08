-- 利用者とトークンの RPC（基本設計 3章）
-- check_token / create_user / login_user / update_profile / get_home / get_day

-- ============================================================
-- 内部処理（公開しない）
-- ============================================================

-- 利用者を返すときの形
create function private.user_json(u private.users)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', u.id, 'name', u.name, 'cohort', u.cohort, 'memo', u.memo,
    'suspended', u.suspended_at is not null)
$$;

-- 識別子が衝突したときに見せる、既存の人の情報（すべて公開情報）
create function private.identity_json(u private.users)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', u.id, 'name', u.name, 'cohort', u.cohort, 'memo', u.memo)
$$;

-- 氏名・期生・メモを整えて検査する。不正なら INVALID_INPUT（detail に項目名）
create function private.clean_profile(
  p_name text, p_cohort integer, p_memo text,
  out o_name text, out o_cohort integer, out o_memo text)
language plpgsql
immutable
set search_path = ''
as $$
begin
  o_name   := btrim(coalesce(p_name, ''));
  o_cohort := p_cohort;
  o_memo   := coalesce(p_memo, '');

  if char_length(o_name) not between 1 and 50 then
    perform private.raise_error('INVALID_INPUT', '{"field": "name"}');
  end if;
  if o_cohort is not null and o_cohort <= 0 then
    perform private.raise_error('INVALID_INPUT', '{"field": "cohort"}');
  end if;
  if char_length(o_memo) > 500 then
    perform private.raise_error('INVALID_INPUT', '{"field": "memo"}');
  end if;
end;
$$;

-- 識別子（氏名＋期生）が一致する、削除されていない利用者
create function private.find_identity(p_name text, p_cohort integer, p_exclude_id uuid)
returns private.users
language sql
stable
set search_path = ''
as $$
  select u.*
    from private.users u
   where u.deleted_at is null
     and u.name = p_name
     and u.cohort is not distinct from p_cohort
     and (p_exclude_id is null or u.id <> p_exclude_id)
$$;

-- 予約を返すときの形（氏名とメモは全員に公開される情報）
create function private.reservation_json(v private.reservations_v, p_viewer uuid)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id,
    'resource_id', v.resource_id,
    'kind', v.kind,
    'status', v.status,
    'start_at', v.start_at,
    'end_at', v.end_at,
    'effective_end', v.effective_end,
    'checked_in_at', v.checked_in_at,
    'block_reason', v.block_reason,
    'is_mine', p_viewer is not null and v.user_id is not distinct from p_viewer,
    'user', case when v.user_id is null then null
                 else jsonb_build_object('id', v.user_id, 'name', v.user_name,
                                         'cohort', v.user_cohort, 'memo', v.user_memo)
            end)
$$;

-- その日（東京時間）のグリッドに描く予約
-- 占有中のものと、実際に使われた終了済みのもの（チェックインした予約・予約なしの利用・封鎖）。
-- 無断不参加のまま終了時刻を過ぎたものは「終了」と導出されるが、使われていないので描かない
create function private.day_reservations(p_day date, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.reservation_json(v, p_viewer) order by v.start_at), '[]'::jsonb)
    from private.reservations_v v
    join private.active_resources res on res.id = v.resource_id
   where v.start_at < ((p_day + 1)::timestamp at time zone 'Asia/Tokyo')
     and v.effective_end > (p_day::timestamp at time zone 'Asia/Tokyo')
     and (private.occupies(v.status)
          or (v.status = 'finished' and (v.checked_in_at is not null or v.kind = 'block')))
$$;

-- 東京時間の今日
create function private.today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Tokyo')::date
$$;

-- ============================================================
-- check_token: 入口トークンの確認
-- ============================================================
create function public.check_token(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_token(p_token);
  return jsonb_build_object('ok', true, 'server_now', now());
end;
$$;

-- ============================================================
-- create_user: アカウントの作成
-- 同じ識別子の人がいれば IDENTITY_CONFLICT（detail に既存の人の情報）
-- ============================================================
create function public.create_user(p_token text, p_name text, p_cohort integer, p_memo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p        record;
  v_existing private.users;
  v_user     private.users;
begin
  perform private.assert_token(p_token);
  v_p := private.clean_profile(p_name, p_cohort, p_memo);

  v_existing := private.find_identity(v_p.o_name, v_p.o_cohort, null);
  if v_existing.id is not null then
    perform private.raise_error('IDENTITY_CONFLICT', private.identity_json(v_existing));
  end if;

  begin
    insert into private.users (name, cohort, memo)
    values (v_p.o_name, v_p.o_cohort, v_p.o_memo)
    returning * into v_user;
  exception when unique_violation then
    -- 同時に同じ識別子で作成された場合
    v_existing := private.find_identity(v_p.o_name, v_p.o_cohort, null);
    perform private.raise_error('IDENTITY_CONFLICT', private.identity_json(v_existing));
  end;

  perform private.write_log('user', v_user.id, null, 'user.create', 'user', v_user.id::text,
                            private.user_json(v_user));
  return private.user_json(v_user);
end;
$$;

-- ============================================================
-- login_user: 識別子でログインする（「同一人物です」を選んだとき）
-- ============================================================
create function public.login_user(p_token text, p_name text, p_cohort integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user private.users;
begin
  perform private.assert_token(p_token);

  v_user := private.find_identity(btrim(coalesce(p_name, '')), p_cohort, null);
  if v_user.id is null then
    perform private.raise_error('USER_NOT_FOUND');
  end if;

  -- 本人確認はしないので、なりすましの追跡のために記録する
  perform private.write_log('user', v_user.id, null, 'user.login', 'user', v_user.id::text);
  return private.user_json(v_user);
end;
$$;

-- ============================================================
-- update_profile: 本人による氏名・期生・メモの変更
-- ============================================================
create function public.update_profile(
  p_token text, p_user_id uuid, p_name text, p_cohort integer, p_memo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before   private.users;
  v_p        record;
  v_existing private.users;
  v_user     private.users;
begin
  v_before := private.get_actor(p_token, p_user_id);
  v_p := private.clean_profile(p_name, p_cohort, p_memo);

  v_existing := private.find_identity(v_p.o_name, v_p.o_cohort, v_before.id);
  if v_existing.id is not null then
    perform private.raise_error('IDENTITY_CONFLICT', private.identity_json(v_existing));
  end if;

  begin
    update private.users
       set name = v_p.o_name, cohort = v_p.o_cohort, memo = v_p.o_memo
     where id = v_before.id
    returning * into v_user;
  exception when unique_violation then
    v_existing := private.find_identity(v_p.o_name, v_p.o_cohort, v_before.id);
    perform private.raise_error('IDENTITY_CONFLICT', private.identity_json(v_existing));
  end;

  perform private.write_log('user', v_user.id, null, 'user.update', 'user', v_user.id::text,
                            jsonb_build_object('before', private.user_json(v_before),
                                               'after',  private.user_json(v_user)));
  return private.user_json(v_user);
end;
$$;

-- ============================================================
-- get_home: トップページを1回で描くためのデータ
-- ============================================================
create function public.get_home(p_token text, p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me  private.users;
  v_day date := coalesce(p_day, private.today());
begin
  perform private.assert_token(p_token);
  if p_user_id is not null then
    v_me := private.get_actor(p_token, p_user_id);
  end if;

  return jsonb_build_object(
    'server_now', now(),
    'me', case when v_me.id is null then null else private.user_json(v_me) end,
    'my_reservations', (
      select coalesce(jsonb_agg(private.reservation_json(v, v_me.id) order by v.start_at), '[]'::jsonb)
        from private.reservations_v v
       where v_me.id is not null
         and v.user_id = v_me.id
         and v.status in ('reserved', 'in_use')),
    'resources', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id, 'name', r.name, 'memo_md', r.memo_md, 'sort_order', r.sort_order,
               'paused', r.paused_at is not null, 'pause_reason', r.pause_reason)
             order by r.sort_order, r.name), '[]'::jsonb)
        from private.active_resources r),
    'reservations', private.day_reservations(v_day, v_me.id),
    'announcements', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id, 'title', a.title, 'body_md', a.body_md, 'importance', a.importance,
               'publish_start_at', a.publish_start_at, 'publish_end_at', a.publish_end_at)
             order by (a.importance = 'important') desc, a.publish_start_at desc), '[]'::jsonb)
        from private.announcements a
       where a.deleted_at is null
         and a.publish_start_at <= now()
         and (a.publish_end_at is null or a.publish_end_at > now())));
end;
$$;

-- ============================================================
-- get_day: 日付を切り替えたときのグリッドのデータ
-- ============================================================
create function public.get_day(p_token text, p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me private.users;
begin
  perform private.assert_token(p_token);
  if p_user_id is not null then
    v_me := private.get_actor(p_token, p_user_id);
  end if;

  return jsonb_build_object(
    'server_now', now(),
    'reservations', private.day_reservations(coalesce(p_day, private.today()), v_me.id));
end;
$$;

-- ============================================================
-- 権限
-- ============================================================
revoke all on all functions in schema private from public, anon, authenticated;

grant execute on function public.check_token(text)                                  to anon, authenticated;
grant execute on function public.create_user(text, text, integer, text)             to anon, authenticated;
grant execute on function public.login_user(text, text, integer)                    to anon, authenticated;
grant execute on function public.update_profile(text, uuid, text, integer, text)    to anon, authenticated;
grant execute on function public.get_home(text, uuid, date)                         to anon, authenticated;
grant execute on function public.get_day(text, uuid, date)                          to anon, authenticated;

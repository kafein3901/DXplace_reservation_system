-- 状態の導出と共通処理（基本設計 2章「ビューと内部関数」）
--
-- ここの関数は RPC 関数の中から呼ぶ内部処理で、外部には公開しない。

-- ============================================================
-- 状態の導出（要件定義 4章。導出はこの関数1か所にまとめる）
-- ============================================================
create function private.reservation_status(r private.reservations, p_at timestamptz default now())
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when r.cancelled_at is not null                          then 'cancelled'
    when r.checked_out_at is not null or r.end_at <= p_at    then 'finished'
    -- 封鎖はチェックインしないので、無断不参加の判定より前に返す
    when r.kind = 'block'                                    then 'blocked'
    when r.checked_in_at is not null                         then 'in_use'
    when r.start_at + interval '15 minutes' < p_at           then 'no_show'
    else                                                          'reserved'
  end
$$;

-- 枠を占有する状態か
create function private.occupies(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status in ('reserved', 'in_use', 'blocked')
$$;

-- 実際の終了（途中でチェックアウトしたらその日時）
create function private.effective_end(r private.reservations)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select least(r.end_at, coalesce(r.checked_out_at, r.end_at))
$$;

-- ============================================================
-- ビュー（RPC 関数は原則としてこれらを使う）
-- ============================================================
create view private.active_users as
  select * from private.users where deleted_at is null;

create view private.active_resources as
  select * from private.resources where deleted_at is null;

create view private.reservations_v as
  select r.*,
         private.reservation_status(r) as status,
         private.effective_end(r)      as effective_end,
         res.name                      as resource_name,
         u.name                        as user_name,
         u.cohort                      as user_cohort,
         u.memo                        as user_memo
    from private.reservations r
    join private.resources res on res.id = r.resource_id
    left join private.users u on u.id = r.user_id;

-- ============================================================
-- エラーの送出
-- message にエラーコード、detail に補足の JSON を入れる（基本設計 5章）
-- ============================================================
create function private.raise_error(p_code text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = p_code,
    detail  = coalesce(p_detail, '{}'::jsonb)::text;
end;
$$;

-- ============================================================
-- 認証まわり
-- ============================================================

-- 入口トークンを確認する
create function private.assert_token(p_token text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_token is null or not exists (
    select 1 from private.entry_tokens where token = p_token and revoked_at is null
  ) then
    perform private.raise_error('INVALID_TOKEN');
  end if;
end;
$$;

-- トークンを確認し、削除されていない利用者の行を返す
create function private.get_actor(p_token text, p_user_id uuid)
returns private.users
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user private.users;
begin
  perform private.assert_token(p_token);

  select * into v_user from private.users where id = p_user_id and deleted_at is null;
  if not found then
    perform private.raise_error('USER_NOT_FOUND');
  end if;

  return v_user;
end;
$$;

-- 利用停止中なら拒否する
create function private.assert_not_suspended(p_user private.users)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_user.suspended_at is not null then
    perform private.raise_error('USER_SUSPENDED');
  end if;
end;
$$;

-- 呼び出し元が管理者であることを確認し、その ID を返す
create function private.assert_admin()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not exists (select 1 from private.admins where user_id = v_uid) then
    perform private.raise_error('NOT_ADMIN');
  end if;
  return v_uid;
end;
$$;

-- ============================================================
-- 予約の判定
-- ============================================================

-- リソースの行をロックして返す（重複と上限の判定は、このロックの後に行う）
create function private.lock_resource(p_resource_id uuid, p_require_active boolean)
returns private.resources
language plpgsql
set search_path = ''
as $$
declare
  v_resource private.resources;
begin
  select * into v_resource from private.resources where id = p_resource_id for update;

  if not found or v_resource.deleted_at is not null then
    perform private.raise_error('RESOURCE_NOT_FOUND');
  end if;

  if p_require_active and v_resource.paused_at is not null then
    perform private.raise_error('RESOURCE_PAUSED');
  end if;

  return v_resource;
end;
$$;

-- 区間 [p_start, p_end) に重なる、枠を占有中の予約を1つ返す（なければ NULL）
create function private.find_overlap(
  p_resource_id uuid, p_start timestamptz, p_end timestamptz, p_exclude_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select r.id
    from private.reservations r
   where r.resource_id = p_resource_id
     and (p_exclude_id is null or r.id <> p_exclude_id)
     and r.start_at < p_end
     and private.effective_end(r) > p_start
     and private.occupies(private.reservation_status(r))
   order by r.start_at
   limit 1
$$;

-- p_after 以降に始まる、枠を占有中の予約の最も早い開始時刻（なければ NULL）
create function private.next_start(p_resource_id uuid, p_after timestamptz, p_exclude_id uuid)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(r.start_at)
    from private.reservations r
   where r.resource_id = p_resource_id
     and (p_exclude_id is null or r.id <> p_exclude_id)
     and r.start_at >= p_after
     and private.occupies(private.reservation_status(r))
$$;

-- 利用者が保持している予約の数（予約済み＋利用中。上限の判定用）
create function private.count_holding(p_user_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from private.reservations r
   where r.user_id = p_user_id
     and private.reservation_status(r) in ('reserved', 'in_use')
$$;

-- ============================================================
-- 操作ログ
-- ============================================================
create function private.write_log(
  p_actor_type text, p_actor_user_id uuid, p_actor_admin_id uuid,
  p_action text, p_target_type text, p_target_id text, p_detail jsonb default '{}'::jsonb)
returns bigint
language sql
set search_path = ''
as $$
  insert into private.action_logs
    (actor_type, actor_user_id, actor_admin_id, action, target_type, target_id, detail)
  values
    (p_actor_type, p_actor_user_id, p_actor_admin_id, p_action, p_target_type, p_target_id,
     coalesce(p_detail, '{}'::jsonb))
  returning id
$$;

-- ============================================================
-- 権限（既定の権限でも取り消しているが、明示しておく）
-- ============================================================
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

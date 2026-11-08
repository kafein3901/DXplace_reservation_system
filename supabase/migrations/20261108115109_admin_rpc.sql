-- 管理者の RPC（基本設計 4章、要件定義 6章）
--
-- authenticated のみに公開し、冒頭で private.assert_admin() により管理者表を確認する。
-- 書き込みはすべて actor_type = 'admin' で操作ログに残す。
-- 利用者・リソースの停止や削除に伴って予約を変えるときは、予約ごとにもログを残す。

-- ============================================================
-- 内部処理（公開しない）
-- ============================================================

-- 管理者の操作ログ
create function private.admin_log(
  p_admin uuid, p_action text, p_target_type text, p_target_id text, p_detail jsonb default '{}'::jsonb)
returns bigint
language sql
set search_path = ''
as $$
  select private.write_log('admin', null, p_admin, p_action, p_target_type, p_target_id, p_detail)
$$;

-- 管理画面に返す予約の形
create function private.admin_reservation_json(v private.reservations_v)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select private.reservation_json(v, null) || jsonb_build_object(
    'resource_name', v.resource_name,
    'checked_out_at', v.checked_out_at,
    'cancelled_at', v.cancelled_at,
    'created_at', v.created_at)
$$;

create function private.admin_reservation_result(p_reservation_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.admin_reservation_json(v) from private.reservations_v v where v.id = p_reservation_id
$$;

-- 管理画面に返す利用者の形
create function private.admin_user_json(u private.users)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select private.user_json(u) || jsonb_build_object(
    'suspended_at', u.suspended_at, 'deleted_at', u.deleted_at, 'created_at', u.created_at)
$$;

-- リソースの形
create function private.resource_json(r private.resources)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'name', r.name, 'memo_md', r.memo_md, 'sort_order', r.sort_order,
    'paused', r.paused_at is not null, 'pause_reason', r.pause_reason,
    'paused_at', r.paused_at, 'deleted_at', r.deleted_at)
$$;

-- お知らせの形（公開状態は時刻から導出する）
create function private.announcement_json(a private.announcements)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'title', a.title, 'body_md', a.body_md, 'importance', a.importance,
    'publish_start_at', a.publish_start_at, 'publish_end_at', a.publish_end_at,
    'deleted_at', a.deleted_at, 'created_at', a.created_at,
    'publish_state', case
      when a.deleted_at is not null                                then 'deleted'
      when a.publish_start_at > now()                              then 'scheduled'
      when a.publish_end_at is not null and a.publish_end_at <= now() then 'ended'
      else                                                              'published'
    end)
$$;

-- 予約を、リソースをロックしてから行ロックつきで取得する（管理者用。所有者は問わない）
create function private.admin_lock_reservation(p_reservation_id uuid)
returns private.reservations
language plpgsql
set search_path = ''
as $$
declare
  v_resource_id uuid;
  v_r           private.reservations;
begin
  select resource_id into v_resource_id from private.reservations where id = p_reservation_id;
  if not found then
    perform private.raise_error('RESERVATION_NOT_FOUND');
  end if;

  perform 1 from private.resources where id = v_resource_id for update;
  select * into v_r from private.reservations where id = p_reservation_id for update;
  return v_r;
end;
$$;

-- 利用者またはリソースの予約をまとめて処理する
--   予約済み・封鎖 → キャンセル（p_cancel_blocks が false なら封鎖は対象外）
--   利用中         → 終了（p_end_in_use が true のとき）
-- 予約ごとに操作ログを残し、処理した予約の ID を返す
create function private.admin_cascade(
  p_admin uuid, p_reason text, p_user_id uuid, p_resource_id uuid,
  p_cancel_blocks boolean, p_end_in_use boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_r         private.reservations;
  v_status    text;
  v_cancelled jsonb := '[]'::jsonb;
  v_ended     jsonb := '[]'::jsonb;
begin
  for v_r in
    select * from private.reservations
     where (p_user_id is null or user_id = p_user_id)
       and (p_resource_id is null or resource_id = p_resource_id)
     order by start_at
       for update
  loop
    v_status := private.reservation_status(v_r);

    if v_status = 'reserved' or (v_status = 'blocked' and p_cancel_blocks) then
      update private.reservations set cancelled_at = now() where id = v_r.id;
      perform private.admin_log(p_admin, 'reservation.cancel', 'reservation', v_r.id::text,
                                jsonb_build_object('reason', p_reason));
      v_cancelled := v_cancelled || to_jsonb(v_r.id);
    elsif v_status = 'in_use' and p_end_in_use then
      update private.reservations set checked_out_at = now() where id = v_r.id;
      perform private.admin_log(p_admin, 'reservation.force_checkout', 'reservation', v_r.id::text,
                                jsonb_build_object('reason', p_reason));
      v_ended := v_ended || to_jsonb(v_r.id);
    end if;
  end loop;

  return jsonb_build_object('cancelled', v_cancelled, 'ended', v_ended);
end;
$$;

-- 削除されていない利用者を行ロックつきで取得する
create function private.admin_lock_user(p_user_id uuid)
returns private.users
language plpgsql
set search_path = ''
as $$
declare
  v_user private.users;
begin
  select * into v_user from private.users where id = p_user_id and deleted_at is null for update;
  if not found then
    perform private.raise_error('USER_NOT_FOUND');
  end if;
  return v_user;
end;
$$;

-- リソースの名前を整えて検査する
create function private.clean_resource_name(p_name text, p_exclude_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if char_length(v_name) not between 1 and 50 then
    perform private.raise_error('INVALID_INPUT', '{"field": "name"}');
  end if;
  if exists (select 1 from private.resources
              where name = v_name and deleted_at is null
                and (p_exclude_id is null or id <> p_exclude_id)) then
    perform private.raise_error('NAME_CONFLICT');
  end if;
  return v_name;
end;
$$;

-- お知らせの入力を整えて検査する
create function private.clean_announcement(
  p_title text, p_body_md text, p_importance text, p_start timestamptz, p_end timestamptz,
  out o_title text, out o_body_md text)
language plpgsql
immutable
set search_path = ''
as $$
begin
  o_title   := btrim(coalesce(p_title, ''));
  o_body_md := coalesce(p_body_md, '');

  if char_length(o_title) not between 1 and 100 then
    perform private.raise_error('INVALID_INPUT', '{"field": "title"}');
  end if;
  if p_importance is null or p_importance not in ('normal', 'important') then
    perform private.raise_error('INVALID_INPUT', '{"field": "importance"}');
  end if;
  if p_start is null then
    perform private.raise_error('INVALID_INPUT', '{"field": "publish_start_at"}');
  end if;
  if p_end is not null and p_end <= p_start then
    perform private.raise_error('INVALID_INPUT', '{"field": "publish_end_at"}');
  end if;
end;
$$;

-- ============================================================
-- admin_whoami: 呼び出し元が管理者か（管理者でなくてもエラーにしない）
-- ============================================================
create function public.admin_whoami()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  select display_name into v_name from private.admins where user_id = auth.uid();
  return jsonb_build_object('is_admin', found, 'display_name', v_name);
end;
$$;

-- ============================================================
-- 予約の操作と枠の封鎖
-- ============================================================

-- 予約の一覧（キャンセル・無断不参加も含む）。NULL の条件は絞り込まない
create function public.admin_list_reservations(
  p_from timestamptz, p_to timestamptz, p_resource_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return (
    select coalesce(jsonb_agg(private.admin_reservation_json(v) order by v.start_at), '[]'::jsonb)
      from private.reservations_v v
     where (p_to is null or v.start_at < p_to)
       and (p_from is null or v.end_at > p_from)
       and (p_resource_id is null or v.resource_id = p_resource_id)
       and (p_user_id is null or v.user_id = p_user_id));
end;
$$;

-- 枠の封鎖（上限の対象外。一時停止中のリソースにも置ける）
create function public.admin_create_block(
  p_resource_id uuid, p_start_at timestamptz, p_end_at timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := private.assert_admin();
  v_start   timestamptz := date_trunc('minute', p_start_at);
  v_end     timestamptz := date_trunc('minute', p_end_at);
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_overlap uuid;
  v_r       private.reservations;
begin
  if v_start is null then
    perform private.raise_error('INVALID_INPUT', '{"field": "start_at"}');
  end if;
  if v_end is null or v_end <= v_start or v_end <= now() then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;
  if char_length(v_reason) not between 1 and 100 then
    perform private.raise_error('INVALID_INPUT', '{"field": "reason"}');
  end if;

  perform private.lock_resource(p_resource_id, false);

  v_overlap := private.find_overlap(p_resource_id, v_start, v_end, null);
  if v_overlap is not null then
    perform private.raise_error('OVERLAP', jsonb_build_object('reservation_id', v_overlap));
  end if;

  insert into private.reservations (resource_id, user_id, kind, start_at, end_at, block_reason)
  values (p_resource_id, null, 'block', v_start, v_end, v_reason)
  returning * into v_r;

  perform private.admin_log(v_admin, 'reservation.block', 'reservation', v_r.id::text, to_jsonb(v_r));
  return private.admin_reservation_result(v_r.id);
end;
$$;

-- 任意の予約の時刻を変更する（期限による制限はかけない。重複だけは判定する）
create function public.admin_update_reservation(
  p_reservation_id uuid, p_start_at timestamptz, p_end_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := private.assert_admin();
  v_before  private.reservations;
  v_r       private.reservations;
  v_status  text;
  v_start   timestamptz;
  v_end     timestamptz;
  v_overlap uuid;
begin
  v_before := private.admin_lock_reservation(p_reservation_id);
  v_status := private.reservation_status(v_before);
  if v_status not in ('reserved', 'in_use', 'blocked') then
    perform private.raise_invalid_state(v_status);
  end if;

  v_start := coalesce(date_trunc('minute', p_start_at), v_before.start_at);
  v_end   := coalesce(date_trunc('minute', p_end_at), v_before.end_at);
  if v_end <= v_start then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;

  v_overlap := private.find_overlap(v_before.resource_id, v_start, v_end, v_before.id);
  if v_overlap is not null then
    perform private.raise_error('OVERLAP', jsonb_build_object('reservation_id', v_overlap));
  end if;

  update private.reservations set start_at = v_start, end_at = v_end
   where id = v_before.id
  returning * into v_r;

  perform private.admin_log(v_admin, 'reservation.change', 'reservation', v_r.id::text,
                            jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_r)));
  return private.admin_reservation_result(v_r.id);
end;
$$;

-- 任意の予約・封鎖を削除する（予約済み・封鎖のとき）
create function public.admin_cancel_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := private.assert_admin();
  v_r      private.reservations;
  v_status text;
begin
  v_r := private.admin_lock_reservation(p_reservation_id);
  v_status := private.reservation_status(v_r);
  if v_status not in ('reserved', 'blocked') then
    perform private.raise_invalid_state(v_status);
  end if;

  update private.reservations set cancelled_at = now() where id = v_r.id returning * into v_r;

  perform private.admin_log(v_admin, 'reservation.cancel', 'reservation', v_r.id::text, to_jsonb(v_r));
  return private.admin_reservation_result(v_r.id);
end;
$$;

-- 利用中の予約を強制終了する
create function public.admin_force_checkout(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := private.assert_admin();
  v_r      private.reservations;
  v_status text;
begin
  v_r := private.admin_lock_reservation(p_reservation_id);
  v_status := private.reservation_status(v_r);
  if v_status <> 'in_use' then
    perform private.raise_invalid_state(v_status);
  end if;

  update private.reservations set checked_out_at = now() where id = v_r.id returning * into v_r;

  perform private.admin_log(v_admin, 'reservation.force_checkout', 'reservation', v_r.id::text, to_jsonb(v_r));
  return private.admin_reservation_result(v_r.id);
end;
$$;

-- ============================================================
-- 利用者の管理
-- ============================================================

-- 利用者の一覧（氏名で部分一致の検索）
create function public.admin_list_users(p_query text, p_include_deleted boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return (
    select coalesce(jsonb_agg(private.admin_user_json(u) order by u.name, u.cohort nulls first), '[]'::jsonb)
      from private.users u
     where (coalesce(p_include_deleted, false) or u.deleted_at is null)
       and (nullif(btrim(p_query), '') is null
            or strpos(u.name, btrim(p_query)) > 0));
end;
$$;

-- 利用者の情報を変更する
create function public.admin_update_user(p_user_id uuid, p_name text, p_cohort integer, p_memo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_before   private.users;
  v_p        record;
  v_existing private.users;
  v_user     private.users;
begin
  v_before := private.admin_lock_user(p_user_id);
  v_p := private.clean_profile(p_name, p_cohort, p_memo);

  v_existing := private.find_identity(v_p.o_name, v_p.o_cohort, v_before.id);
  if v_existing.id is not null then
    perform private.raise_error('IDENTITY_CONFLICT', private.identity_json(v_existing));
  end if;

  update private.users set name = v_p.o_name, cohort = v_p.o_cohort, memo = v_p.o_memo
   where id = v_before.id
  returning * into v_user;

  perform private.admin_log(v_admin, 'user.update', 'user', v_user.id::text,
                            jsonb_build_object('before', private.user_json(v_before),
                                               'after',  private.user_json(v_user)));
  return private.admin_user_json(v_user);
end;
$$;

-- 利用停止（未来の予約はキャンセルする。利用中はそのまま）
create function public.admin_suspend_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := private.assert_admin();
  v_user    private.users;
  v_cascade jsonb;
begin
  v_user := private.admin_lock_user(p_user_id);
  v_cascade := private.admin_cascade(v_admin, 'user.suspend', v_user.id, null, false, false);

  update private.users set suspended_at = coalesce(suspended_at, now())
   where id = v_user.id
  returning * into v_user;

  perform private.admin_log(v_admin, 'user.suspend', 'user', v_user.id::text, v_cascade);
  return private.admin_user_json(v_user);
end;
$$;

-- 利用停止の解除
create function public.admin_unsuspend_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.assert_admin();
  v_user  private.users;
begin
  v_user := private.admin_lock_user(p_user_id);

  update private.users set suspended_at = null where id = v_user.id returning * into v_user;

  perform private.admin_log(v_admin, 'user.unsuspend', 'user', v_user.id::text);
  return private.admin_user_json(v_user);
end;
$$;

-- アカウントの削除（論理削除）
--   メモを消し、未来の予約はキャンセルし、利用中の予約は終了させる。氏名はログの表示用に残す
create function public.admin_delete_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := private.assert_admin();
  v_user    private.users;
  v_cascade jsonb;
begin
  v_user := private.admin_lock_user(p_user_id);
  v_cascade := private.admin_cascade(v_admin, 'user.delete', v_user.id, null, false, true);

  update private.users set deleted_at = now(), memo = ''
   where id = v_user.id
  returning * into v_user;

  perform private.admin_log(v_admin, 'user.delete', 'user', v_user.id::text, v_cascade);
  return private.admin_user_json(v_user);
end;
$$;

-- アカウントの復元（削除の取り消し。消したメモは戻らない）
create function public.admin_restore_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_user     private.users;
  v_existing private.users;
begin
  select * into v_user from private.users where id = p_user_id for update;
  if not found then
    perform private.raise_error('USER_NOT_FOUND');
  end if;
  if v_user.deleted_at is null then
    perform private.raise_invalid_state('active');
  end if;

  v_existing := private.find_identity(v_user.name, v_user.cohort, v_user.id);
  if v_existing.id is not null then
    perform private.raise_error('IDENTITY_CONFLICT', private.identity_json(v_existing));
  end if;

  update private.users set deleted_at = null where id = v_user.id returning * into v_user;

  perform private.admin_log(v_admin, 'user.restore', 'user', v_user.id::text);
  return private.admin_user_json(v_user);
end;
$$;

-- ============================================================
-- リソースの管理
-- ============================================================

-- リソースの一覧（削除済みも含む）
create function public.admin_list_resources()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return (
    select coalesce(jsonb_agg(private.resource_json(r)
                              order by r.deleted_at nulls first, r.sort_order, r.name), '[]'::jsonb)
      from private.resources r);
end;
$$;

-- リソースの追加
create function public.admin_create_resource(p_name text, p_memo_md text, p_sort_order integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_resource private.resources;
begin
  insert into private.resources (name, memo_md, sort_order)
  values (private.clean_resource_name(p_name, null), coalesce(p_memo_md, ''), coalesce(p_sort_order, 0))
  returning * into v_resource;

  perform private.admin_log(v_admin, 'resource.create', 'resource', v_resource.id::text,
                            private.resource_json(v_resource));
  return private.resource_json(v_resource);
exception when unique_violation then
  perform private.raise_error('NAME_CONFLICT');
end;
$$;

-- リソースの名前・メモ・並び順の変更（ID は変わらない）
create function public.admin_update_resource(
  p_resource_id uuid, p_name text, p_memo_md text, p_sort_order integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_before   private.resources;
  v_resource private.resources;
begin
  v_before := private.lock_resource(p_resource_id, false);

  update private.resources
     set name = private.clean_resource_name(p_name, v_before.id),
         memo_md = coalesce(p_memo_md, ''),
         sort_order = coalesce(p_sort_order, 0)
   where id = v_before.id
  returning * into v_resource;

  perform private.admin_log(v_admin, 'resource.update', 'resource', v_resource.id::text,
                            jsonb_build_object('before', private.resource_json(v_before),
                                               'after',  private.resource_json(v_resource)));
  return private.resource_json(v_resource);
exception when unique_violation then
  perform private.raise_error('NAME_CONFLICT');
end;
$$;

-- 一時停止（故障時など）。既存の予約は残し、予約とチェックインができなくなる
create function public.admin_pause_resource(p_resource_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_resource private.resources;
begin
  perform private.lock_resource(p_resource_id, false);

  update private.resources
     set paused_at = coalesce(paused_at, now()), pause_reason = nullif(btrim(p_reason), '')
   where id = p_resource_id
  returning * into v_resource;

  perform private.admin_log(v_admin, 'resource.pause', 'resource', v_resource.id::text,
                            jsonb_build_object('reason', v_resource.pause_reason));
  return private.resource_json(v_resource);
end;
$$;

-- 一時停止の解除
create function public.admin_resume_resource(p_resource_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_resource private.resources;
begin
  perform private.lock_resource(p_resource_id, false);

  update private.resources set paused_at = null, pause_reason = null
   where id = p_resource_id
  returning * into v_resource;

  perform private.admin_log(v_admin, 'resource.resume', 'resource', v_resource.id::text);
  return private.resource_json(v_resource);
end;
$$;

-- リソースの削除（論理削除）
--   未来の予約と封鎖はキャンセルし、利用中の予約は終了させる。名前は過去のログ表示用に残す
create function public.admin_delete_resource(p_resource_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin    uuid := private.assert_admin();
  v_resource private.resources;
  v_cascade  jsonb;
begin
  perform private.lock_resource(p_resource_id, false);
  v_cascade := private.admin_cascade(v_admin, 'resource.delete', null, p_resource_id, true, true);

  update private.resources set deleted_at = now()
   where id = p_resource_id
  returning * into v_resource;

  perform private.admin_log(v_admin, 'resource.delete', 'resource', v_resource.id::text, v_cascade);
  return private.resource_json(v_resource);
end;
$$;

-- ============================================================
-- 入口URL（トークン）
-- ============================================================

-- 現在のトークン（QR コードの再表示用）。なければ null
create function public.admin_get_token()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return (
    select jsonb_build_object('token', t.token, 'issued_at', t.issued_at)
      from private.entry_tokens t
     where t.revoked_at is null);
end;
$$;

-- トークンの再発行（古いトークンは即座に無効になる）
create function public.admin_issue_token()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.assert_admin();
  v_token private.entry_tokens;
begin
  update private.entry_tokens set revoked_at = now() where revoked_at is null;

  -- 24 バイトの乱数を URL セーフな Base64（32文字）にする
  insert into private.entry_tokens (token, issued_by)
  values (translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), v_admin)
  returning * into v_token;

  -- トークンそのものはログに残さない
  perform private.admin_log(v_admin, 'token.issue', 'token', v_token.id::text);
  return jsonb_build_object('token', v_token.token, 'issued_at', v_token.issued_at);
end;
$$;

-- ============================================================
-- お知らせの管理
-- ============================================================

create function public.admin_list_announcements(p_include_deleted boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return (
    select coalesce(jsonb_agg(private.announcement_json(a) order by a.publish_start_at desc), '[]'::jsonb)
      from private.announcements a
     where coalesce(p_include_deleted, false) or a.deleted_at is null);
end;
$$;

create function public.admin_create_announcement(
  p_title text, p_body_md text, p_importance text, p_publish_start_at timestamptz, p_publish_end_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.assert_admin();
  v_p     record;
  v_a     private.announcements;
begin
  v_p := private.clean_announcement(p_title, p_body_md, p_importance, p_publish_start_at, p_publish_end_at);

  insert into private.announcements (title, body_md, importance, publish_start_at, publish_end_at)
  values (v_p.o_title, v_p.o_body_md, p_importance, p_publish_start_at, p_publish_end_at)
  returning * into v_a;

  perform private.admin_log(v_admin, 'announcement.create', 'announcement', v_a.id::text,
                            private.announcement_json(v_a));
  return private.announcement_json(v_a);
end;
$$;

create function public.admin_update_announcement(
  p_id uuid, p_title text, p_body_md text, p_importance text,
  p_publish_start_at timestamptz, p_publish_end_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := private.assert_admin();
  v_before private.announcements;
  v_p      record;
  v_a      private.announcements;
begin
  select * into v_before from private.announcements where id = p_id and deleted_at is null for update;
  if not found then
    perform private.raise_error('ANNOUNCEMENT_NOT_FOUND');
  end if;

  v_p := private.clean_announcement(p_title, p_body_md, p_importance, p_publish_start_at, p_publish_end_at);

  update private.announcements
     set title = v_p.o_title, body_md = v_p.o_body_md, importance = p_importance,
         publish_start_at = p_publish_start_at, publish_end_at = p_publish_end_at
   where id = p_id
  returning * into v_a;

  perform private.admin_log(v_admin, 'announcement.update', 'announcement', v_a.id::text,
                            jsonb_build_object('before', private.announcement_json(v_before),
                                               'after',  private.announcement_json(v_a)));
  return private.announcement_json(v_a);
end;
$$;

create function public.admin_delete_announcement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.assert_admin();
  v_a     private.announcements;
begin
  update private.announcements set deleted_at = now()
   where id = p_id and deleted_at is null
  returning * into v_a;
  if not found then
    perform private.raise_error('ANNOUNCEMENT_NOT_FOUND');
  end if;

  perform private.admin_log(v_admin, 'announcement.delete', 'announcement', v_a.id::text);
  return private.announcement_json(v_a);
end;
$$;

-- ============================================================
-- ログの閲覧
--   p_user_id: その人の操作・その人への操作・その人の予約への操作
--   p_resource_id: そのリソースへの操作・そのリソースの予約への操作
--   新しい順。p_limit は 1〜500
-- ============================================================
create function public.admin_list_logs(
  p_from timestamptz, p_to timestamptz, p_user_id uuid, p_resource_id uuid,
  p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform private.assert_admin();

  return (
    with filtered as (
      select l.*,
             case l.actor_type when 'user' then au.name else ad.display_name end as actor_name,
             case l.target_type
               when 'reservation'  then rres.name
               when 'resource'     then tres.name
               when 'user'         then tu.name
               when 'announcement' then ta.title
             end as target_label
        from private.action_logs l
        left join private.users au         on au.id = l.actor_user_id
        left join private.admins ad        on ad.user_id = l.actor_admin_id
        left join private.reservations rv  on l.target_type = 'reservation' and rv.id::text = l.target_id
        left join private.resources rres   on rres.id = rv.resource_id
        left join private.resources tres   on l.target_type = 'resource' and tres.id::text = l.target_id
        left join private.users tu         on l.target_type = 'user' and tu.id::text = l.target_id
        left join private.announcements ta on l.target_type = 'announcement' and ta.id::text = l.target_id
       where (p_from is null or l.created_at >= p_from)
         and (p_to is null or l.created_at < p_to)
         and (p_user_id is null
              or l.actor_user_id = p_user_id
              or (l.target_type = 'user' and l.target_id = p_user_id::text)
              or rv.user_id = p_user_id)
         and (p_resource_id is null
              or (l.target_type = 'resource' and l.target_id = p_resource_id::text)
              or rv.resource_id = p_resource_id)
    )
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', f.id, 'created_at', f.created_at,
                 'actor_type', f.actor_type, 'actor_user_id', f.actor_user_id,
                 'actor_admin_id', f.actor_admin_id, 'actor_name', f.actor_name,
                 'action', f.action, 'target_type', f.target_type, 'target_id', f.target_id,
                 'target_label', f.target_label, 'detail', f.detail)
               order by f.created_at desc, f.id desc)
          from (select * from filtered order by created_at desc, id desc limit v_limit offset v_offset) f),
        '[]'::jsonb)));
end;
$$;

-- ============================================================
-- 管理者
-- ============================================================

create function public.admin_list_admins()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', a.user_id, 'display_name', a.display_name, 'email', u.email,
             'created_at', a.created_at) order by a.created_at, u.email), '[]'::jsonb)
      from private.admins a
      join auth.users u on u.id = a.user_id);
end;
$$;

-- Auth のユーザーを管理者として登録する
-- Edge Function（admin-create-admin）が Auth のユーザーを作った後、呼び出した管理者の JWT で呼ぶ
create function public.admin_register_admin(p_auth_user_id uuid, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.assert_admin();
  v_name  text := btrim(coalesce(p_display_name, ''));
  v_new   private.admins;
begin
  if not exists (select 1 from auth.users where id = p_auth_user_id) then
    perform private.raise_error('USER_NOT_FOUND');
  end if;
  if char_length(v_name) not between 1 and 50 then
    perform private.raise_error('INVALID_INPUT', '{"field": "display_name"}');
  end if;
  if exists (select 1 from private.admins where user_id = p_auth_user_id) then
    perform private.raise_invalid_state('admin');
  end if;

  insert into private.admins (user_id, display_name, created_by)
  values (p_auth_user_id, v_name, v_admin)
  returning * into v_new;

  perform private.admin_log(v_admin, 'admin.create', 'admin', v_new.user_id::text,
                            jsonb_build_object('display_name', v_new.display_name));
  return jsonb_build_object('user_id', v_new.user_id, 'display_name', v_new.display_name,
                            'created_at', v_new.created_at);
end;
$$;

-- ============================================================
-- 権限: 管理者の RPC は authenticated のみ
-- ============================================================
revoke all on all functions in schema private from public, anon, authenticated;

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'admin\_%'
  loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$$;

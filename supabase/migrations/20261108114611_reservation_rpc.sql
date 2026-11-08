-- 予約の RPC（基本設計 3章、要件定義 4章）
-- create_reservation / cancel_reservation / change_reservation / check_in / start_walk_in / check_out
--
-- どの関数も、対象リソースの行をロックしてから判定し、書き込みとログの記録までを
-- 1つのトランザクションで行う。同じ枠への同時の操作は、後から来たものが判定で拒否される。

-- ============================================================
-- 内部処理（公開しない）
-- ============================================================

-- 予約の上限（予約済み＋利用中）
create function private.reservation_limit()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

-- 予約を1件、画面に返す形で取得する
create function private.reservation_result(p_reservation_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.reservation_json(v, p_viewer) from private.reservations_v v where v.id = p_reservation_id
$$;

-- 自分の予約を、リソースをロックしてから行ロックつきで取得する
create function private.lock_own_reservation(p_user_id uuid, p_reservation_id uuid, p_require_active boolean)
returns private.reservations
language plpgsql
set search_path = ''
as $$
declare
  v_found private.reservations;
  v_r     private.reservations;
begin
  select * into v_found from private.reservations where id = p_reservation_id;
  if not found then
    perform private.raise_error('RESERVATION_NOT_FOUND');
  end if;
  if v_found.user_id is distinct from p_user_id then
    perform private.raise_error('NOT_OWNER');
  end if;

  perform private.lock_resource(v_found.resource_id, p_require_active);
  -- ロックを取るまでの間に変わっているかもしれないので、取り直す
  select * into v_r from private.reservations where id = p_reservation_id for update;
  return v_r;
end;
$$;

-- 今の状態ではその操作ができない
create function private.raise_invalid_state(p_status text)
returns void
language sql
set search_path = ''
as $$
  select private.raise_error('INVALID_STATE', jsonb_build_object('status', p_status))
$$;

-- ============================================================
-- create_reservation: 予約の作成
-- ============================================================
create function public.create_reservation(
  p_token text, p_user_id uuid, p_resource_id uuid, p_start_at timestamptz, p_end_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    private.users;
  v_start   timestamptz := date_trunc('minute', p_start_at);
  v_end     timestamptz := date_trunc('minute', p_end_at);
  v_overlap uuid;
  v_r       private.reservations;
begin
  v_user := private.get_actor(p_token, p_user_id);
  perform private.assert_not_suspended(v_user);

  if v_start is null or v_start < date_trunc('minute', now()) then
    perform private.raise_error('INVALID_INPUT', '{"field": "start_at"}');
  end if;
  if v_end is null or v_end <= v_start then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;

  perform private.lock_resource(p_resource_id, true);
  -- 上限は利用者ごとなので、別のリソースへの同時の予約に備えて利用者の行もロックする
  perform 1 from private.users where id = v_user.id for update;

  v_overlap := private.find_overlap(p_resource_id, v_start, v_end, null);
  if v_overlap is not null then
    perform private.raise_error('OVERLAP', jsonb_build_object('reservation_id', v_overlap));
  end if;

  if private.count_holding(v_user.id) >= private.reservation_limit() then
    perform private.raise_error('LIMIT_EXCEEDED', jsonb_build_object('limit', private.reservation_limit()));
  end if;

  insert into private.reservations (resource_id, user_id, kind, start_at, end_at)
  values (p_resource_id, v_user.id, 'reservation', v_start, v_end)
  returning * into v_r;

  perform private.write_log('user', v_user.id, null, 'reservation.create', 'reservation', v_r.id::text,
                            to_jsonb(v_r));
  return private.reservation_result(v_r.id, v_user.id);
end;
$$;

-- ============================================================
-- cancel_reservation: 予約の削除（チェックインまで）
-- 利用停止中でも自分の予約は削除できる
-- ============================================================
create function public.cancel_reservation(p_token text, p_user_id uuid, p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   private.users;
  v_r      private.reservations;
  v_status text;
begin
  v_user := private.get_actor(p_token, p_user_id);
  v_r := private.lock_own_reservation(v_user.id, p_reservation_id, false);

  v_status := private.reservation_status(v_r);
  if v_status <> 'reserved' then
    perform private.raise_invalid_state(v_status);
  end if;

  update private.reservations set cancelled_at = now() where id = v_r.id returning * into v_r;

  perform private.write_log('user', v_user.id, null, 'reservation.cancel', 'reservation', v_r.id::text,
                            to_jsonb(v_r));
  return private.reservation_result(v_r.id, v_user.id);
end;
$$;

-- ============================================================
-- change_reservation: 開始時刻・終了時刻の変更
--   開始の変更: 予約済みで開始時刻より前。新しい開始も現在の分以降
--   終了の変更: 予約済み・利用中（終了時刻より前）。新しい終了は現在時刻より後
-- NULL の引数は変更しない
-- ============================================================
create function public.change_reservation(
  p_token text, p_user_id uuid, p_reservation_id uuid, p_start_at timestamptz, p_end_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user          private.users;
  v_before        private.reservations;
  v_r             private.reservations;
  v_status        text;
  v_new_start     timestamptz;
  v_new_end       timestamptz;
  v_start_changed boolean;
  v_end_changed   boolean;
  v_overlap       uuid;
begin
  v_user := private.get_actor(p_token, p_user_id);
  perform private.assert_not_suspended(v_user);

  if p_start_at is null and p_end_at is null then
    perform private.raise_error('INVALID_INPUT', '{"field": "start_at"}');
  end if;

  v_before := private.lock_own_reservation(v_user.id, p_reservation_id, false);
  v_status := private.reservation_status(v_before);

  v_new_start := coalesce(date_trunc('minute', p_start_at), v_before.start_at);
  v_new_end   := coalesce(date_trunc('minute', p_end_at), v_before.end_at);
  v_start_changed := v_new_start <> v_before.start_at;
  v_end_changed   := v_new_end <> v_before.end_at;

  -- 状態の判定
  if v_status not in ('reserved', 'in_use') then
    perform private.raise_invalid_state(v_status);
  end if;
  if v_start_changed and (v_status <> 'reserved' or now() >= v_before.start_at) then
    perform private.raise_invalid_state(v_status);
  end if;

  -- 入力の判定
  if v_start_changed and v_new_start < date_trunc('minute', now()) then
    perform private.raise_error('INVALID_INPUT', '{"field": "start_at"}');
  end if;
  if v_end_changed and v_new_end <= now() then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;
  if v_new_end <= v_new_start then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;

  if not v_start_changed and not v_end_changed then
    return private.reservation_result(v_before.id, v_user.id);
  end if;

  -- 重複の判定
  v_overlap := private.find_overlap(v_before.resource_id, v_new_start, v_new_end, v_before.id);
  if v_overlap is not null then
    if v_start_changed then
      perform private.raise_error('OVERLAP', jsonb_build_object('reservation_id', v_overlap));
    else
      -- 終了だけを延ばして重なった: 次の予約の開始時刻までしか延ばせない
      perform private.raise_error('END_EXCEEDS_NEXT', jsonb_build_object(
        'next_start', private.next_start(v_before.resource_id, v_before.start_at, v_before.id)));
    end if;
  end if;

  update private.reservations
     set start_at = v_new_start, end_at = v_new_end
   where id = v_before.id
  returning * into v_r;

  perform private.write_log('user', v_user.id, null, 'reservation.change', 'reservation', v_r.id::text,
                            jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_r)));
  return private.reservation_result(v_r.id, v_user.id);
end;
$$;

-- ============================================================
-- check_in: チェックイン（開始時刻から15分後まで。開始前も可）
--   開始前は p_advance = true のときだけ前倒しする（直前の時間帯が空いていること）。
--   「予約なしとして使う」を選んだ場合、フロントは start_walk_in を呼ぶ
-- ============================================================
create function public.check_in(p_token text, p_user_id uuid, p_reservation_id uuid, p_advance boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     private.users;
  v_r        private.reservations;
  v_status   text;
  v_advanced boolean := false;
begin
  v_user := private.get_actor(p_token, p_user_id);
  perform private.assert_not_suspended(v_user);
  v_r := private.lock_own_reservation(v_user.id, p_reservation_id, true);

  v_status := private.reservation_status(v_r);
  if v_status = 'no_show' then
    perform private.raise_error('CHECKIN_WINDOW_CLOSED');
  end if;
  if v_status <> 'reserved' then
    perform private.raise_invalid_state(v_status);
  end if;

  if now() >= v_r.start_at then
    update private.reservations set checked_in_at = now() where id = v_r.id returning * into v_r;
  else
    if not coalesce(p_advance, false) then
      perform private.raise_error('ADVANCE_REQUIRED', jsonb_build_object(
        'start_at', v_r.start_at,
        'can_advance', private.find_overlap(v_r.resource_id, now(), v_r.start_at, v_r.id) is null));
    end if;
    if private.find_overlap(v_r.resource_id, now(), v_r.start_at, v_r.id) is not null then
      perform private.raise_error('PREVIOUS_SLOT_OCCUPIED');
    end if;

    update private.reservations
       set start_at = now(), checked_in_at = now()
     where id = v_r.id
    returning * into v_r;
    v_advanced := true;
  end if;

  perform private.write_log('user', v_user.id, null, 'reservation.check_in', 'reservation', v_r.id::text,
                            to_jsonb(v_r) || jsonb_build_object('advanced', v_advanced));
  return private.reservation_result(v_r.id, v_user.id);
end;
$$;

-- ============================================================
-- start_walk_in: 予約なしで使い始める
--   現在時刻が空いていること。終了は自分の予約を含む次の予約の開始時刻まで。上限は判定しない
-- ============================================================
create function public.start_walk_in(p_token text, p_user_id uuid, p_resource_id uuid, p_end_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user private.users;
  v_end  timestamptz := date_trunc('minute', p_end_at);
  v_next timestamptz;
  v_r    private.reservations;
begin
  v_user := private.get_actor(p_token, p_user_id);
  perform private.assert_not_suspended(v_user);

  if v_end is null then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;

  perform private.lock_resource(p_resource_id, true);

  if private.find_overlap(p_resource_id, now(), now() + interval '1 microsecond', null) is not null then
    perform private.raise_error('NOT_FREE_NOW');
  end if;
  if v_end <= now() then
    perform private.raise_error('INVALID_INPUT', '{"field": "end_at"}');
  end if;

  v_next := private.next_start(p_resource_id, now(), null);
  if v_next is not null and v_end > v_next then
    perform private.raise_error('END_EXCEEDS_NEXT', jsonb_build_object('next_start', v_next));
  end if;

  insert into private.reservations (resource_id, user_id, kind, start_at, end_at, checked_in_at)
  values (p_resource_id, v_user.id, 'walk_in', now(), v_end, now())
  returning * into v_r;

  perform private.write_log('user', v_user.id, null, 'reservation.walk_in', 'reservation', v_r.id::text,
                            to_jsonb(v_r));
  return private.reservation_result(v_r.id, v_user.id);
end;
$$;

-- ============================================================
-- check_out: チェックアウト（利用中のとき）
-- 利用停止中でもチェックアウトできる
-- ============================================================
create function public.check_out(p_token text, p_user_id uuid, p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   private.users;
  v_r      private.reservations;
  v_status text;
begin
  v_user := private.get_actor(p_token, p_user_id);
  v_r := private.lock_own_reservation(v_user.id, p_reservation_id, false);

  v_status := private.reservation_status(v_r);
  if v_status <> 'in_use' then
    perform private.raise_invalid_state(v_status);
  end if;

  update private.reservations set checked_out_at = now() where id = v_r.id returning * into v_r;

  perform private.write_log('user', v_user.id, null, 'reservation.check_out', 'reservation', v_r.id::text,
                            to_jsonb(v_r));
  return private.reservation_result(v_r.id, v_user.id);
end;
$$;

-- ============================================================
-- 権限
-- ============================================================
revoke all on all functions in schema private from public, anon, authenticated;

grant execute on function public.create_reservation(text, uuid, uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.cancel_reservation(text, uuid, uuid)                           to anon, authenticated;
grant execute on function public.change_reservation(text, uuid, uuid, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.check_in(text, uuid, uuid, boolean)                            to anon, authenticated;
grant execute on function public.start_walk_in(text, uuid, uuid, timestamptz)                   to anon, authenticated;
grant execute on function public.check_out(text, uuid, uuid)                                    to anon, authenticated;

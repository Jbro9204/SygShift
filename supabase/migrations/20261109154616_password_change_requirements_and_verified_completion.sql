begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Staged foundation only. Installation creates no password-change request,
-- changes no credential, sends no email, and does not enable campaigns.
create table private.password_change_feature_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into private.password_change_feature_config values (true, false);

create table private.password_change_receipts (
  id bigint generated always as identity primary key,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);
create index password_change_receipts_user_time_idx
  on private.password_change_receipts(auth_user_id, changed_at desc, id desc);

create table private.password_change_batches (
  id uuid primary key,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  actor_auth_session_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  reason text not null check (char_length(reason) between 12 and 1000),
  starts_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create table private.password_change_requirements (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.password_change_batches(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  starts_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','completed','canceled')),
  completed_receipt_id bigint references private.password_change_receipts(id) on delete restrict,
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid references public.employees(id) on delete restrict,
  cancellation_reason text,
  cancellation_request_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (batch_id, employee_id),
  check ((status='completed') = (completed_receipt_id is not null and completed_at is not null)),
  check ((status='canceled') = (canceled_at is not null and canceled_by is not null
    and char_length(cancellation_reason) between 12 and 1000 and cancellation_request_id is not null))
);
create unique index password_change_requirements_open_idx
  on private.password_change_requirements(employee_id) where status='pending';
create index password_change_requirements_session_idx
  on private.password_change_requirements(auth_user_id, starts_at) where status='pending';

alter table private.employee_accounts add column password_requirement_started_at timestamptz;

create function private.password_change_immutable()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  raise check_violation using message='Password-change evidence is immutable.';
end;
$$;
create trigger password_change_receipts_immutable before update or delete
  on private.password_change_receipts for each row execute function private.password_change_immutable();
create trigger password_change_batches_immutable before update or delete
  on private.password_change_batches for each row execute function private.password_change_immutable();

create function private.password_change_requirement_update_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op <> 'UPDATE' or old.status <> 'pending' or new.status not in ('completed','canceled')
    or (to_jsonb(new)-array['status','completed_receipt_id','completed_at','canceled_at','canceled_by','cancellation_reason','cancellation_request_id'])
      is distinct from
      (to_jsonb(old)-array['status','completed_receipt_id','completed_at','canceled_at','canceled_by','cancellation_reason','cancellation_request_id']) then
    raise check_violation using message='Only a pending password-change requirement may be completed or canceled.';
  end if;
  return new;
end;
$$;
create trigger password_change_requirements_guard before update or delete
  on private.password_change_requirements for each row execute function private.password_change_requirement_update_guard();

create function private.record_auth_password_transition()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- No credential, credential digest, user metadata or session material is retained.
  -- No network request or cross-account work occurs in the Auth transaction.
  if old.encrypted_password is distinct from new.encrypted_password
    and coalesce(old.encrypted_password,'') <> '' and coalesce(new.encrypted_password,'') <> ''
    and exists(select 1 from private.employee_accounts a where a.auth_user_id=new.id) then
    insert into private.password_change_receipts(auth_user_id) values(new.id);
  end if;
  return new;
end;
$$;
create trigger sygshift_record_password_transition after update of encrypted_password
  on auth.users for each row execute function private.record_auth_password_transition();

create function private.record_password_requirement_start()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.must_change_password then
    new.password_requirement_started_at:=clock_timestamp();
  elsif tg_op='UPDATE' then
    new.password_requirement_started_at:=old.password_requirement_started_at;
  end if;
  return new;
end;
$$;
create trigger employee_password_requirement_start before insert or update of must_change_password
  on private.employee_accounts for each row execute function private.record_password_requirement_start();

create function private.password_change_session_requirement(target_auth_user_id uuid,target_session_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('id',r.id,'startsAt',r.starts_at,'reason',b.reason,
      'proofNotBefore',greatest(r.starts_at,r.created_at))
    from private.password_change_requirements r
    join private.password_change_batches b on b.id=r.batch_id
    join auth.sessions s on s.id=target_session_id and s.user_id=r.auth_user_id
    where r.auth_user_id=target_auth_user_id and r.status='pending'
      and s.created_at>=r.starts_at and r.starts_at<=statement_timestamp()
      and (s.not_after is null or s.not_after>statement_timestamp())
      and exists(select 1 from private.password_change_feature_config f where f.singleton and f.enabled)
    order by r.starts_at,r.id limit 1),'{}'::jsonb);
$$;

create function public.get_password_change_requirement()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare account private.employee_accounts; requirement jsonb; session_id uuid;
begin
  select a.* into account from private.employee_accounts a join public.employees e on e.id=a.employee_id
    join auth.sessions s on s.user_id=a.auth_user_id and s.id=nullif((select auth.jwt())->>'session_id','')::uuid
    where a.auth_user_id=(select auth.uid()) and a.disabled_at is null and e.status::text in('active','leave')
      and (s.not_after is null or s.not_after>statement_timestamp());
  if account.employee_id is null then raise insufficient_privilege using message='An active employee session is required.';end if;
  session_id:=nullif((select auth.jwt())->>'session_id','')::uuid;
  requirement:=private.password_change_session_requirement(account.auth_user_id,session_id);
  return jsonb_build_object('mustChangePassword',account.must_change_password or requirement ? 'id',
    'requirementId',requirement->'id','reason',requirement->'reason','startsAt',requirement->'startsAt');
end;
$$;

create or replace function public.get_effective_permissions()
returns text[] language sql stable security definer set search_path='' as $$
  with actor as materialized (
    select (select auth.uid()) as auth_user_id,employee.id as employee_id,employee.role,
      private.employee_requires_mfa(employee.id) as requires_mfa,
      public.has_mfa() as has_mfa,
      nullif((select auth.jwt())->>'session_id','')::uuid as session_id
    from public.employees employee
    where employee.id=private.current_employee_id() and employee.status='active'
    limit 1
  ), password_state as materialized (
    select exists(select 1 from private.employee_accounts a where a.auth_user_id=actor.auth_user_id and a.must_change_password)
      or (private.password_change_session_requirement(actor.auth_user_id,actor.session_id) ? 'id') as blocked
    from actor
  )
  select coalesce(array_agg(permission_code order by permission_code),array[]::text[])
  from actor cross join password_state
  cross join lateral unnest(private.employee_effective_permissions(actor.employee_id)) permission_code
  join public.permission_catalog catalog on catalog.code=permission_code
  -- Preserve the existing narrow Guard launch exemption. A normal Guard must
  -- not gain an MFA requirement merely because password recovery was upgraded.
  -- Effective-permission denials still apply before this projection.
  where catalog.active and (not catalog.requires_mfa or actor.has_mfa or (
    permission_code in ('apps.sygilant.access','apps.sygshift.access')
    and actor.role='guard' and not actor.requires_mfa))
    and not password_state.blocked;
$$;

create function public.mark_password_changed_verified()
returns void language plpgsql security definer set search_path='' as $$
declare account private.employee_accounts; requirement jsonb; receipt private.password_change_receipts; baseline timestamptz;
begin
  select a.* into account from private.employee_accounts a join public.employees e on e.id=a.employee_id
    join auth.users u on u.id=a.auth_user_id
    join auth.sessions s on s.user_id=a.auth_user_id and s.id=nullif((select auth.jwt())->>'session_id','')::uuid
    where a.auth_user_id=(select auth.uid()) and a.disabled_at is null and e.status::text in('active','leave')
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp())
      and (s.not_after is null or s.not_after>statement_timestamp())
      and not exists(select 1 from private.emergency_access_authority ea where ea.employee_id=e.id and ea.access_state<>'active')
    for update of a;
  if account.employee_id is null then raise insufficient_privilege using message='A linked active employee account is required.';end if;
  requirement:=private.password_change_session_requirement(account.auth_user_id,nullif((select auth.jwt())->>'session_id','')::uuid);
  baseline:=case when account.must_change_password
    then coalesce(account.password_requirement_started_at,account.invited_at,account.created_at)
    else coalesce((requirement->>'startsAt')::timestamptz,account.password_changed_at,account.created_at) end;
  if requirement ? 'id' then baseline:=greatest(baseline,(requirement->>'proofNotBefore')::timestamptz);end if;
  select p.* into receipt from private.password_change_receipts p
    where p.auth_user_id=account.auth_user_id and p.changed_at>=baseline
    order by p.changed_at desc,p.id desc limit 1;
  if receipt.id is null then
    raise check_violation using message='Choose a different password. No completed credential change was verified.';
  end if;
  if not account.must_change_password and not(requirement ? 'id') and account.password_changed_at>=receipt.changed_at then return;end if;
  update private.employee_accounts set must_change_password=false,password_changed_at=receipt.changed_at,
    activated_at=coalesce(activated_at,clock_timestamp()),updated_at=clock_timestamp()
    where employee_id=account.employee_id;
  if requirement ? 'id' then
    update private.password_change_requirements set status='completed',completed_receipt_id=receipt.id,completed_at=clock_timestamp()
      where id=(requirement->>'id')::uuid and status='pending';
  end if;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record)
    values(account.auth_user_id,account.employee_id,'private','employee_accounts','self_password_changed',account.employee_id::text,
      jsonb_build_object('passwordChanged',true,'receiptId',receipt.id,'requirementId',requirement->'id'));
end;
$$;

-- Older clients still receive the same verified completion. New clients use the
-- versioned entry point and fail closed if the migration is not installed.
create or replace function public.mark_password_changed()
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.mark_password_changed_verified();
end;
$$;

create function private.password_change_admin_proof(payload jsonb,require_fresh boolean default true)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare actor_id uuid:=(payload->>'actorEmployeeId')::uuid; proof jsonb;
begin
  perform private.emergency_access_service_role_required();
  if require_fresh then
    proof:=private.employee_preview_actor_proof(actor_id,(payload->>'actorAuthSessionId')::uuid,
      (payload->>'recentMfaAt')::timestamptz,payload->>'mfaMethod',nullif(payload->>'securityKeyTokenHash',''));
  else
    proof:=private.employee_preview_actor_authority(actor_id,(payload->>'actorAuthSessionId')::uuid);
  end if;
  if not coalesce((proof->>'ok')::boolean,false) or
    (private.password_change_session_requirement((select a.auth_user_id from private.employee_accounts a where a.employee_id=actor_id),(payload->>'actorAuthSessionId')::uuid) ? 'id') or not(
    'admin.users.password_reset'=any(coalesce(private.employee_effective_permissions(actor_id),array[]::text[]))) then
    raise insufficient_privilege using message='An active Admin with password-reset permission and fresh verification is required.';
  end if;
  return actor_id;
end;
$$;

create function private.password_change_target_preview(payload jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ids uuid[]; eligible jsonb; excluded jsonb;
begin
  if jsonb_typeof(payload->'employeeIds') is distinct from 'array' or jsonb_array_length(payload->'employeeIds') not between 1 and 100 then
    raise check_violation using message='Select between one and 100 employee accounts.';end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(payload->'employeeIds');
  if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then
    raise check_violation using message='Select each employee only once.';end if;
  with targets as(select requested.employee_id as requested_id,e.username,e.status,a.auth_user_id,a.disabled_at,a.must_change_password,
      u.deleted_at,u.banned_until,coalesce(ea.access_state,'active') access_state,
      exists(select 1 from private.password_change_requirements r where r.employee_id=requested.employee_id and r.status='pending') already_pending
    from unnest(ids) requested(employee_id) left join public.employees e on e.id=requested.employee_id
    left join private.employee_accounts a on a.employee_id=requested.employee_id left join auth.users u on u.id=a.auth_user_id
    left join private.emergency_access_authority ea on ea.employee_id=requested.employee_id), classified as(
      select *,case when username is null then 'employee_not_found' when status::text<>'active' then 'employee_not_active'
        when auth_user_id is null or deleted_at is not null then 'account_unavailable'
        when disabled_at is not null or banned_until>statement_timestamp() or access_state<>'active' then 'account_closed'
        when must_change_password then 'password_setup_pending' when already_pending then 'requirement_pending' else null end problem
      from targets)
  select coalesce(jsonb_agg(jsonb_build_object('employeeId',requested_id,'username',username) order by username) filter(where problem is null),'[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('employeeId',requested_id,'reason',problem) order by requested_id) filter(where problem is not null),'[]'::jsonb)
    into eligible,excluded from classified;
  return jsonb_build_object('eligible',eligible,'eligibleCount',jsonb_array_length(eligible),'excluded',excluded,
    'featureEnabled',exists(select 1 from private.password_change_feature_config f where f.singleton and f.enabled));
end;
$$;

create function public.service_preview_employee_password_changes(target_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.password_change_admin_proof(target_payload,false);
  return private.password_change_target_preview(target_payload);
end;
$$;

create function public.service_require_employee_password_changes(target_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid; v_batch_id uuid:=(target_payload->>'idempotencyKey')::uuid;
  requested_start timestamptz:=(target_payload->>'startsAt')::timestamptz; existing private.password_change_batches;
  preview jsonb; target uuid; reason text:=btrim(target_payload->>'reason'); request_hash text:=target_payload->>'requestHash';
begin
  actor_id:=private.password_change_admin_proof(target_payload);
  if not exists(select 1 from private.password_change_feature_config f where f.singleton and f.enabled) then
    raise object_not_in_prerequisite_state using message='Password-change campaigns are not enabled.';end if;
  if v_batch_id is null or request_hash is null or request_hash!~'^[a-f0-9]{64}$'
    or reason is null or char_length(reason) not between 12 and 1000 or requested_start is null then
    raise check_violation using message='Confirm the selected accounts, reason, and activation time.';end if;
  perform pg_advisory_xact_lock(hashtextextended('password-change-batch:'||v_batch_id::text,0));
  select * into existing from private.password_change_batches b where b.id=v_batch_id;
  if existing.id is not null then
    if existing.request_hash<>request_hash or existing.actor_employee_id<>actor_id then
      raise unique_violation using message='This request key belongs to a different password-change request.';end if;
  else
    if requested_start<statement_timestamp()-interval '1 minute' or requested_start>statement_timestamp()+interval '30 days' then
      raise check_violation using message='Choose an activation time within the next 30 days.';end if;
    -- A browser's "now" is already in the past by arrival. Never accidentally
    -- enroll a session that existed before this request was accepted.
    requested_start:=greatest(requested_start,clock_timestamp());
    preview:=private.password_change_target_preview(target_payload);
    if jsonb_array_length(preview->'excluded')<>0 or (target_payload->>'expectedCount')::integer is distinct from (preview->>'eligibleCount')::integer then
      raise check_violation using message='The account selection changed. Preview it again before confirming.';end if;
    -- Fixed order serializes overlapping batches without changing active sessions.
    for target in select value::uuid from jsonb_array_elements_text(target_payload->'employeeIds') order by value::uuid loop
      perform pg_advisory_xact_lock(hashtextextended('password-change-employee:'||target::text,0));
    end loop;
    preview:=private.password_change_target_preview(target_payload);
    if jsonb_array_length(preview->'excluded')<>0 or (target_payload->>'expectedCount')::integer is distinct from (preview->>'eligibleCount')::integer then
      raise check_violation using message='The account selection changed. Preview it again before confirming.';end if;
    insert into private.password_change_batches(id,actor_employee_id,actor_auth_session_id,request_hash,reason,starts_at)
      values(v_batch_id,actor_id,(target_payload->>'actorAuthSessionId')::uuid,request_hash,reason,requested_start);
    insert into private.password_change_requirements(batch_id,employee_id,auth_user_id,starts_at)
      select v_batch_id,e.id,a.auth_user_id,requested_start from public.employees e
      join private.employee_accounts a on a.employee_id=e.id
      where e.id in(select (value->>'employeeId')::uuid from jsonb_array_elements(preview->'eligible'));
    insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record)
      select a.auth_user_id,actor_id,'private','password_change_batches','require_next_login_change',v_batch_id::text,
        jsonb_build_object('count',target_payload->'expectedCount','startsAt',requested_start)
      from private.employee_accounts a where a.employee_id=actor_id;
  end if;
  return jsonb_build_object('batchId',v_batch_id,'excluded','[]'::jsonb,'requirements',coalesce((
    select jsonb_agg(jsonb_build_object('id',r.id,'employeeId',r.employee_id,'username',e.username,'status',r.status,'startsAt',r.starts_at))
      from private.password_change_requirements r join public.employees e on e.id=r.employee_id where r.batch_id=v_batch_id),'[]'::jsonb));
end;
$$;

create function public.service_list_employee_password_changes(target_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.password_change_admin_proof(target_payload,false);
  return jsonb_build_object('featureEnabled',exists(select 1 from private.password_change_feature_config f where f.singleton and f.enabled),
    'requirements',coalesce((select jsonb_agg(to_jsonb(records)) from (
      select r.id,r.employee_id as "employeeId",e.username,r.status,r.starts_at as "startsAt",b.reason,
        r.completed_at as "completedAt",r.canceled_at as "canceledAt"
      from private.password_change_requirements r join private.password_change_batches b on b.id=r.batch_id
      join public.employees e on e.id=r.employee_id
      where r.employee_id=(target_payload->>'employeeId')::uuid order by r.created_at desc,r.id limit 50
    )records),'[]'::jsonb));
end;
$$;

create function public.service_cancel_employee_password_change(target_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid; requirement private.password_change_requirements; reason text:=btrim(target_payload->>'reason');
  request_id uuid:=(target_payload->>'idempotencyKey')::uuid;
begin
  actor_id:=private.password_change_admin_proof(target_payload);
  if reason is null or char_length(reason) not between 12 and 1000 or request_id is null
    or coalesce(target_payload->>'requestHash','')!~'^[a-f0-9]{64}$' then
    raise check_violation using message='A cancellation reason and request identifier are required.';end if;
  select * into requirement from private.password_change_requirements where id=(target_payload->>'requirementId')::uuid for update;
  if requirement.id is null then raise no_data_found using message='Password-change requirement not found.';end if;
  if requirement.status='canceled' and requirement.cancellation_request_id=request_id and requirement.canceled_by=actor_id
    and requirement.cancellation_reason=reason then
    return jsonb_build_object('id',requirement.id,'status','canceled');end if;
  if requirement.status<>'pending' then raise check_violation using message='Only a pending requirement may be canceled.';end if;
  update private.password_change_requirements set status='canceled',canceled_at=clock_timestamp(),canceled_by=actor_id,
    cancellation_reason=reason,cancellation_request_id=request_id where id=requirement.id;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record)
    select a.auth_user_id,actor_id,'private','password_change_requirements','cancel_next_login_change',requirement.id::text,
      jsonb_build_object('reason',reason,'requestId',request_id) from private.employee_accounts a where a.employee_id=actor_id;
  return jsonb_build_object('id',requirement.id,'status','canceled');
end;
$$;

alter table private.password_change_feature_config enable row level security;
alter table private.password_change_feature_config force row level security;
alter table private.password_change_receipts enable row level security;
alter table private.password_change_receipts force row level security;
alter table private.password_change_batches enable row level security;
alter table private.password_change_batches force row level security;
alter table private.password_change_requirements enable row level security;
alter table private.password_change_requirements force row level security;
revoke all on table private.password_change_feature_config,private.password_change_receipts,
  private.password_change_batches,private.password_change_requirements from public,anon,authenticated,service_role;
revoke all on sequence private.password_change_receipts_id_seq from public,anon,authenticated,service_role;
revoke all on function private.password_change_immutable(),private.password_change_requirement_update_guard(),
  private.record_auth_password_transition(),private.record_password_requirement_start(),
  private.password_change_session_requirement(uuid,uuid),private.password_change_admin_proof(jsonb,boolean),
  private.password_change_target_preview(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.get_password_change_requirement(),public.mark_password_changed(),public.mark_password_changed_verified() from public,anon;
grant execute on function public.get_password_change_requirement(),public.mark_password_changed(),public.mark_password_changed_verified() to authenticated;
revoke all on function public.service_preview_employee_password_changes(jsonb),public.service_require_employee_password_changes(jsonb),
  public.service_list_employee_password_changes(jsonb),public.service_cancel_employee_password_change(jsonb) from public,anon,authenticated;
grant execute on function public.service_preview_employee_password_changes(jsonb),public.service_require_employee_password_changes(jsonb),
  public.service_list_employee_password_changes(jsonb),public.service_cancel_employee_password_change(jsonb) to service_role;
notify pgrst,'reload schema';
commit;

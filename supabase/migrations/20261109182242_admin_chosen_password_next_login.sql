begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

do $$
begin
  if to_regclass('private.password_change_receipts') is null
    or to_regprocedure('private.password_change_admin_proof(jsonb,boolean)') is null
    or to_regprocedure('public.mark_password_changed_verified()') is null then
    raise object_not_in_prerequisite_state using message='Install the verified password-change foundation before Admin-set passwords.';
  end if;
end;
$$;

-- Passwords remain exclusively in Supabase Auth. This ledger contains no
-- plaintext, password digest, email address, or recoverable credential.
create table private.admin_password_set_operations (
  id uuid primary key,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  actor_auth_session_id uuid not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  exact_username text not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  reason text not null check(char_length(reason) between 12 and 1000),
  require_change_at_next_login boolean not null,
  status text not null default 'prepared' check(status in('prepared','confirmed','known_failed','uncertain','canceled')),
  prior_receipt_id bigint not null,
  assigned_receipt_id bigint references private.password_change_receipts(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  error_code text,
  check((status='confirmed')=(assigned_receipt_id is not null))
);
create index admin_password_set_employee_created_idx on private.admin_password_set_operations(employee_id,created_at desc,id);
create unique index admin_password_set_unfinished_idx on private.admin_password_set_operations(employee_id) where status in('prepared','uncertain');
alter table private.password_change_receipts add column provider_transaction_id xid8 not null default pg_current_xact_id();
create index password_change_receipts_transaction_idx on private.password_change_receipts(auth_user_id,provider_transaction_id,id desc);
create table private.admin_password_set_provider_receipts (
  operation_id uuid primary key references private.admin_password_set_operations(id) on delete restrict,
  password_receipt_id bigint unique not null references private.password_change_receipts(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  provider_transaction_id xid8 not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create trigger admin_password_set_provider_receipts_immutable before update or delete on private.admin_password_set_provider_receipts
  for each row execute function private.password_change_immutable();

create function private.guard_admin_password_set_marker()
returns trigger language plpgsql security definer set search_path='' as $$
declare marker text:=new.raw_app_meta_data->>'sygshift_password_set_operation_id'; o private.admin_password_set_operations;
  receipt_id bigint; receipt_count integer;
begin
  if marker is not distinct from (old.raw_app_meta_data->>'sygshift_password_set_operation_id') then
    -- Ordinary profile metadata updates are unchanged. A repeated Admin request
    -- contains this same marker after another password UPDATE in its transaction;
    -- reject it so it cannot replace a password the employee has since chosen.
    if marker ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and exists(select 1 from private.admin_password_set_operations previous_operation where previous_operation.id=marker::uuid and previous_operation.auth_user_id=new.id)
      and exists(select 1 from private.password_change_receipts p where p.auth_user_id=new.id and p.provider_transaction_id=pg_current_xact_id()) then
      raise check_violation using message='An Admin password operation cannot be replayed.';
    end if;
    return new;
  end if;
  if marker is null then return new;end if;
  if marker !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise check_violation using message='An Admin password operation must accompany an actual credential replacement.';
  end if;
  -- Auth holds this user row before its trigger executes. Cancellation takes the
  -- same user-row -> operation-row order, fencing late provider transactions.
  select source.* into o from private.admin_password_set_operations source
    join private.employee_accounts a on a.employee_id=source.employee_id and a.auth_user_id=new.id
    where source.id=marker::uuid and source.auth_user_id=new.id and source.status in('prepared','uncertain') for update of source;
  if o.id is null then
    raise check_violation using message='The Admin password operation is no longer open for this identity.';
  end if;
  -- GoTrue updates the password first and app_metadata later inside ONE
  -- transaction. Bind only that transaction's preceding credential receipt.
  -- A metadata-only call cannot reuse a receipt from an earlier transaction.
  select max(p.id),count(*) into receipt_id,receipt_count from private.password_change_receipts p
    where p.auth_user_id=new.id and p.provider_transaction_id=pg_current_xact_id() and p.id>o.prior_receipt_id;
  if receipt_id is null or receipt_count<>1 then
    raise check_violation using message='The Admin marker must follow a password replacement in the same provider transaction.';
  end if;
  insert into private.admin_password_set_provider_receipts(operation_id,password_receipt_id,auth_user_id,provider_transaction_id)
    values(o.id,receipt_id,new.id,pg_current_xact_id());
  return new;
end;
$$;
create trigger sygshift_guard_admin_password_marker before update of raw_app_meta_data on auth.users
  for each row execute function private.guard_admin_password_set_marker();

create table private.admin_set_password_requirements (
  id uuid primary key references private.admin_password_set_operations(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  starts_at timestamptz not null,
  proof_not_before timestamptz,
  ready boolean not null default false,
  status text not null default 'pending' check(status in('pending','completed','canceled')),
  completed_receipt_id bigint references private.password_change_receipts(id) on delete restrict,
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid references public.employees(id) on delete restrict,
  check((status='completed')=(completed_receipt_id is not null and completed_at is not null)),
  check(not ready or proof_not_before is not null)
);
create index admin_set_password_requirement_pending_idx on private.admin_set_password_requirements(auth_user_id,starts_at desc,id) where status='pending';
create table private.admin_password_set_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null references private.admin_password_set_operations(id) on delete restrict,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  event_type text not null check(event_type in('prepared','confirmed','known_failed','uncertain','canceled','password_changed','requirement_canceled')),
  reason text check(reason is null or char_length(reason) between 12 and 1000),
  occurred_at timestamptz not null default clock_timestamp()
);
create trigger admin_password_set_events_immutable before update or delete on private.admin_password_set_events
  for each row execute function private.password_change_immutable();

create function private.admin_password_set_public(target_id uuid,allow_write boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',o.id,'operationId',o.id,'employeeId',o.employee_id,'authUserId',o.auth_user_id,
    'username',o.exact_username,'status',o.status,'requireChangeAtNextLogin',o.require_change_at_next_login,
    'providerWriteAllowed',allow_write,'createdAt',o.created_at,'finishedAt',o.finished_at,'errorCode',o.error_code,
    'providerUpdateVerified',exists(select 1 from private.admin_password_set_provider_receipts p where p.operation_id=o.id),
    'expiresAt',null)
  from private.admin_password_set_operations o where o.id=target_id;
$$;

create function public.service_get_employee_password_set(target_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare target_id uuid;
begin
  perform private.password_change_admin_proof(target_payload,false);
  select o.id into target_id from private.admin_password_set_operations o
    where o.employee_id=(target_payload->>'employeeId')::uuid
      and (not(target_payload ? 'operationId') or o.id=(target_payload->>'operationId')::uuid)
    order by o.created_at desc,o.id limit 1;
  return private.admin_password_set_public(target_id,false);
end;
$$;

create function public.service_begin_employee_password_set(target_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid; target_id uuid:=(target_payload->>'employeeId')::uuid;
  operation_id uuid:=(target_payload->>'idempotencyKey')::uuid;
  existing private.admin_password_set_operations; account private.employee_accounts;
  target_username text; target_status text; auth_deleted timestamptz; at_time timestamptz:=clock_timestamp();
  required boolean; metadata_hash text:=target_payload->>'requestHash'; written_reason text:=btrim(target_payload->>'reason');
begin
  actor_id:=private.password_change_admin_proof(target_payload);
  if to_regprocedure('private.assert_individual_password_boundary()') is null then
    raise object_not_in_prerequisite_state using message='Install the individual password access boundary before setting employee passwords.';
  end if;
  perform private.assert_individual_password_boundary();
  if target_id is null or operation_id is null or target_id=actor_id
    or metadata_hash is null or metadata_hash!~'^[a-f0-9]{64}$'
    or written_reason is null or char_length(written_reason) not between 12 and 1000
    or jsonb_typeof(target_payload->'requireChangeAtNextLogin') is distinct from 'boolean'
    or target_payload ?| array['password','temporaryPassword','newPassword','passwordHash','passwordDigest'] then
    raise check_violation using message='Confirm the employee, password-change choice, and reason. Credentials must never enter this ledger.';
  end if;
  required:=(target_payload->>'requireChangeAtNextLogin')::boolean;
  perform pg_advisory_xact_lock(hashtextextended('admin-password-set:'||target_id::text,0));
  select * into existing from private.admin_password_set_operations where id=operation_id;
  if existing.id is not null then
    if existing.actor_employee_id<>actor_id or existing.employee_id<>target_id or existing.request_hash<>metadata_hash
      or existing.exact_username is distinct from lower(btrim(target_payload->>'confirmationUsername'))
      or existing.require_change_at_next_login<>required then
      raise unique_violation using message='This reference belongs to a different password request.';
    end if;
    return private.admin_password_set_public(existing.id,false);
  end if;
  select a.* into account from private.employee_accounts a where a.employee_id=target_id for update;
  select lower(e.username),e.status::text into target_username,target_status from public.employees e where e.id=target_id;
  select u.deleted_at into auth_deleted from auth.users u where u.id=account.auth_user_id;
  if account.auth_user_id is null or target_status not in('active','leave') or auth_deleted is not null
    or not exists(select 1 from auth.users u where u.id=account.auth_user_id)
    or target_username is distinct from lower(btrim(target_payload->>'confirmationUsername')) then
    raise check_violation using message='The selected employee account or confirmation is unavailable.';
  end if;
  if exists(select 1 from private.admin_password_set_operations where employee_id=target_id and status in('prepared','uncertain')) then
    raise check_violation using message='An earlier password update is unconfirmed. Review that exact request before starting another.';
  end if;
  insert into private.admin_password_set_operations(id,actor_employee_id,actor_auth_session_id,employee_id,auth_user_id,
    exact_username,request_hash,reason,require_change_at_next_login,prior_receipt_id,created_at)
    values(operation_id,actor_id,(target_payload->>'actorAuthSessionId')::uuid,target_id,account.auth_user_id,target_username,
      metadata_hash,written_reason,required,coalesce((select max(p.id) from private.password_change_receipts p where p.auth_user_id=account.auth_user_id),0),at_time);
  if required then
    insert into private.admin_set_password_requirements(id,employee_id,auth_user_id,starts_at)
      values(operation_id,target_id,account.auth_user_id,at_time);
  end if;
  insert into private.admin_password_set_events(operation_id,actor_employee_id,event_type) values(operation_id,actor_id,'prepared');
  return private.admin_password_set_public(operation_id,true);
end;
$$;

create function public.service_finish_employee_password_set(target_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid; o private.admin_password_set_operations; account private.employee_accounts;
  receipt private.password_change_receipts; outcome text:=target_payload->>'outcome'; at_time timestamptz:=clock_timestamp();
  target_id uuid;
begin
  actor_id:=private.password_change_admin_proof(target_payload);
  select employee_id into target_id from private.admin_password_set_operations where id=(target_payload->>'operationId')::uuid;
  if target_id is null then raise no_data_found using message='The password request was not found.';end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-password-set:'||target_id::text,0));
  select * into account from private.employee_accounts where employee_id=target_id for update;
  -- The provider and cancellation both lock Auth user -> operation. Follow
  -- that order before clearing the transient marker at finalization.
  perform 1 from auth.users where id=account.auth_user_id for update;
  select * into o from private.admin_password_set_operations where id=(target_payload->>'operationId')::uuid for update;
  if account.auth_user_id is distinct from o.auth_user_id
    or not exists(select 1 from public.employees e where e.id=o.employee_id and lower(e.username)=o.exact_username)
    or outcome not in('confirmed','known_failed','unknown') or target_payload ?| array['password','temporaryPassword','newPassword','passwordHash','passwordDigest'] then
    raise insufficient_privilege using message='The password request identity or result could not be verified.';
  end if;
  if o.status in('confirmed','known_failed','canceled') then
    update auth.users set raw_app_meta_data=raw_app_meta_data-'sygshift_password_set_operation_id'
      where id=o.auth_user_id and raw_app_meta_data->>'sygshift_password_set_operation_id'=o.id::text;
    return private.admin_password_set_public(o.id,false);
  end if;
  select p.* into receipt from private.password_change_receipts p
    join private.admin_password_set_provider_receipts tagged on tagged.password_receipt_id=p.id and tagged.operation_id=o.id
    where p.auth_user_id=o.auth_user_id and p.id>o.prior_receipt_id and p.changed_at>=o.created_at order by p.id desc limit 1;
  if receipt.id is not null and exists(select 1 from private.password_change_receipts p where p.auth_user_id=o.auth_user_id and p.id>receipt.id) then
    update private.admin_password_set_operations set status='known_failed',finished_at=at_time,error_code='password_changed_after_assignment' where id=o.id;
    update private.admin_set_password_requirements set status='canceled',canceled_at=at_time,canceled_by=actor_id where id=o.id and status='pending';
    insert into private.admin_password_set_events(operation_id,actor_employee_id,event_type) values(o.id,actor_id,'known_failed');
    update auth.users set raw_app_meta_data=raw_app_meta_data-'sygshift_password_set_operation_id'
      where id=o.auth_user_id and raw_app_meta_data->>'sygshift_password_set_operation_id'=o.id::text;
    return private.admin_password_set_public(o.id,false);
  end if;
  if outcome='confirmed' then
    if (target_payload->>'providerAuthUserId')::uuid is distinct from o.auth_user_id or receipt.id is null then
      raise check_violation using message='The provider did not confirm the exact employee password update.';
    end if;
    -- The Admin-assigned credential is not the employee's later password change.
    -- Completion evidence must be newer than this finalization boundary.
    update private.admin_password_set_operations set status='confirmed',assigned_receipt_id=receipt.id,finished_at=at_time,error_code=null where id=o.id;
    update private.admin_set_password_requirements set status='canceled',canceled_at=at_time,canceled_by=actor_id
      where employee_id=o.employee_id and id<>o.id and status='pending';
    update private.password_change_requirements set status='canceled',canceled_at=at_time,canceled_by=actor_id,
      cancellation_reason=o.reason,cancellation_request_id=o.id where employee_id=o.employee_id and status='pending';
    update private.employee_accounts set must_change_password=false,password_changed_at=receipt.changed_at,updated_at=at_time
      where employee_id=o.employee_id;
    if o.require_change_at_next_login then
      update private.admin_set_password_requirements set ready=true,proof_not_before=at_time where id=o.id;
    end if;
  elsif outcome='known_failed' and receipt.id is null then
    update private.admin_password_set_operations set status='known_failed',finished_at=at_time,error_code='provider_rejected' where id=o.id;
    update private.admin_set_password_requirements set status='canceled',canceled_at=at_time,canceled_by=actor_id where id=o.id and status='pending';
  else
    update private.admin_password_set_operations set status='uncertain',error_code='provider_result_unconfirmed' where id=o.id;
  end if;
  insert into private.admin_password_set_events(operation_id,actor_employee_id,event_type)
    select id,actor_id,status from private.admin_password_set_operations where id=o.id;
  -- Keep only the immutable private receipt after a terminal outcome. Leaving
  -- this marker in Auth metadata makes later ordinary password+metadata updates
  -- look like a replay when the provider merges their unrelated metadata.
  if exists(select 1 from private.admin_password_set_operations where id=o.id and status in('confirmed','known_failed','canceled')) then
    update auth.users set raw_app_meta_data=raw_app_meta_data-'sygshift_password_set_operation_id'
      where id=o.auth_user_id and raw_app_meta_data->>'sygshift_password_set_operation_id'=o.id::text;
  end if;
  return private.admin_password_set_public(o.id,false);
end;
$$;

create function public.service_cancel_employee_password_set(target_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_id uuid; o private.admin_password_set_operations; target_id uuid; target_auth uuid; provider_marker text;
begin
  actor_id:=private.password_change_admin_proof(target_payload);
  select employee_id,auth_user_id into target_id,target_auth from private.admin_password_set_operations where id=(target_payload->>'operationId')::uuid;
  if target_id is null then raise no_data_found using message='The password request was not found.';end if;
  if target_id is distinct from (target_payload->>'employeeId')::uuid
    or char_length(btrim(coalesce(target_payload->>'reason',''))) not between 12 and 1000 then
    raise check_violation using message='Confirm the selected employee and a cancellation reason.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-password-set:'||target_id::text,0));
  select u.raw_app_meta_data->>'sygshift_password_set_operation_id' into provider_marker from auth.users u where u.id=target_auth for update;
  select * into o from private.admin_password_set_operations where id=(target_payload->>'operationId')::uuid for update;
  if o.exact_username is distinct from lower(btrim(target_payload->>'confirmationUsername'))
    or not exists(select 1 from private.employee_accounts a where a.employee_id=o.employee_id and a.auth_user_id=o.auth_user_id) then
    raise insufficient_privilege using message='The selected employee account changed.';
  end if;
  if o.status='canceled' then return private.admin_password_set_public(o.id,false);end if;
  if o.status not in('prepared','uncertain') then
    raise check_violation using message='Only an unconfirmed password request can be canceled.';
  end if;
  if provider_marker=o.id::text or exists(select 1 from private.admin_password_set_provider_receipts p where p.operation_id=o.id) then
    raise check_violation using message='The provider saved this password. Confirm its result instead of canceling.';
  end if;
  update private.admin_password_set_operations set status='canceled',finished_at=clock_timestamp(),error_code='canceled_before_provider_write' where id=o.id;
  update private.admin_set_password_requirements set status='canceled',canceled_at=clock_timestamp(),canceled_by=actor_id where id=o.id and status='pending';
  insert into private.admin_password_set_events(operation_id,actor_employee_id,event_type,reason)
    values(o.id,actor_id,'canceled',btrim(target_payload->>'reason'));
  return private.admin_password_set_public(o.id,false);
end;
$$;

create or replace function private.password_change_session_requirement(target_auth_user_id uuid,target_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  -- Ordinary logins do not perform an auth.sessions lookup for this feature.
  if not exists(select 1 from private.admin_set_password_requirements r where r.auth_user_id=target_auth_user_id and r.status='pending')
    and not exists(select 1 from private.password_change_feature_config f where f.singleton and f.enabled
      and exists(select 1 from private.password_change_requirements r where r.auth_user_id=target_auth_user_id and r.status='pending')) then return '{}'::jsonb;end if;
  if not exists(select 1 from auth.sessions s where s.id=target_session_id and s.user_id=target_auth_user_id
    and (s.not_after is null or s.not_after>statement_timestamp())) then
    select jsonb_build_object('id',r.id,'kind','admin_set','startsAt',r.starts_at,'ready',false,
      'reason','A current employee session is required.','proofNotBefore',r.proof_not_before) into result
      from private.admin_set_password_requirements r where r.auth_user_id=target_auth_user_id and r.status='pending'
      order by r.starts_at desc,r.id limit 1;
    return coalesce(result,'{}'::jsonb);
  end if;
  select jsonb_build_object('id',r.id,'kind','admin_set','startsAt',r.starts_at,'ready',r.ready,
    'reason','Your administrator requires a new password.','proofNotBefore',r.proof_not_before) into result
    from private.admin_set_password_requirements r join auth.sessions s on s.id=target_session_id and s.user_id=r.auth_user_id
    where r.auth_user_id=target_auth_user_id and r.status='pending' and s.created_at>=r.starts_at and r.starts_at<=statement_timestamp()
      and (s.not_after is null or s.not_after>statement_timestamp()) order by r.starts_at desc,r.id limit 1;
  if result is not null then return result;end if;
  select jsonb_build_object('id',r.id,'kind','campaign','startsAt',r.starts_at,'ready',true,'reason',b.reason,
    'proofNotBefore',greatest(r.starts_at,r.created_at)) into result
    from private.password_change_requirements r join private.password_change_batches b on b.id=r.batch_id
    join auth.sessions s on s.id=target_session_id and s.user_id=r.auth_user_id
    where r.auth_user_id=target_auth_user_id and r.status='pending' and s.created_at>=r.starts_at and r.starts_at<=statement_timestamp()
      and (s.not_after is null or s.not_after>statement_timestamp())
      and exists(select 1 from private.password_change_feature_config f where f.singleton and f.enabled)
    order by r.starts_at,r.id limit 1;
  return coalesce(result,'{}'::jsonb);
end;
$$;

create or replace function public.mark_password_changed_verified()
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
  if requirement ? 'id' and not coalesce((requirement->>'ready')::boolean,true) then
    raise check_violation using message='The administrator password update is not yet confirmed. Please contact your administrator.';
  end if;
  baseline:=case when account.must_change_password then coalesce(account.password_requirement_started_at,account.invited_at,account.created_at)
    else coalesce((requirement->>'startsAt')::timestamptz,account.password_changed_at,account.created_at) end;
  if requirement ? 'id' then baseline:=greatest(baseline,(requirement->>'proofNotBefore')::timestamptz);end if;
  select p.* into receipt from private.password_change_receipts p where p.auth_user_id=account.auth_user_id
    and p.changed_at>=baseline order by p.changed_at desc,p.id desc limit 1;
  if receipt.id is null then raise check_violation using message='Choose a different password. No completed credential change was verified.';end if;
  if not account.must_change_password and not(requirement ? 'id') and account.password_changed_at>=receipt.changed_at then return;end if;
  update private.employee_accounts set must_change_password=false,password_changed_at=receipt.changed_at,
    activated_at=coalesce(activated_at,clock_timestamp()),updated_at=clock_timestamp() where employee_id=account.employee_id;
  if requirement ? 'id' then
    if requirement->>'kind'='admin_set' then
      update private.admin_set_password_requirements set status='completed',completed_receipt_id=receipt.id,completed_at=clock_timestamp()
        where id=(requirement->>'id')::uuid and status='pending';
      insert into private.admin_password_set_events(operation_id,actor_employee_id,event_type)
        values((requirement->>'id')::uuid,account.employee_id,'password_changed');
    else
      update private.password_change_requirements set status='completed',completed_receipt_id=receipt.id,completed_at=clock_timestamp()
        where id=(requirement->>'id')::uuid and status='pending';
    end if;
  end if;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record)
    values(account.auth_user_id,account.employee_id,'private','employee_accounts','self_password_changed',account.employee_id::text,
      jsonb_build_object('passwordChanged',true,'receiptId',receipt.id,'requirementId',requirement->'id'));
end;
$$;

alter table private.admin_password_set_operations enable row level security;
alter table private.admin_password_set_operations force row level security;
alter table private.admin_set_password_requirements enable row level security;
alter table private.admin_set_password_requirements force row level security;
alter table private.admin_password_set_events enable row level security;
alter table private.admin_password_set_events force row level security;
alter table private.admin_password_set_provider_receipts enable row level security;
alter table private.admin_password_set_provider_receipts force row level security;
revoke all on table private.admin_password_set_operations,private.admin_set_password_requirements,private.admin_password_set_events,private.admin_password_set_provider_receipts from public,anon,authenticated,service_role;
revoke all on sequence private.admin_password_set_events_id_seq from public,anon,authenticated,service_role;
revoke all on function private.admin_password_set_public(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function private.guard_admin_password_set_marker() from public,anon,authenticated,service_role;
revoke all on function public.service_get_employee_password_set(jsonb),public.service_begin_employee_password_set(jsonb),public.service_finish_employee_password_set(jsonb),public.service_cancel_employee_password_set(jsonb) from public,anon,authenticated;
grant execute on function public.service_get_employee_password_set(jsonb),public.service_begin_employee_password_set(jsonb),public.service_finish_employee_password_set(jsonb),public.service_cancel_employee_password_set(jsonb) to service_role;
notify pgrst,'reload schema';
commit;

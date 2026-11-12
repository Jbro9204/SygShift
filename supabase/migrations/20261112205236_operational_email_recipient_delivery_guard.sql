begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';

-- Do not replace claimants, retry history, source audiences, or security email
-- delivery. This boundary is exclusively for the five operational email lanes.
do $preflight$
declare item record; actual text; metadata_ok boolean;
begin
  for item in select * from (values
    ('public.service_claim_notification_batch(integer)', '03cf0f7c948839dc21274d12f5755b7d'),
    ('private.service_claim_notification_batch_pre_call_off(integer)', 'cdf3e8111e99d0e4066172880d092424'),
    ('public.service_claim_employee_notification_batch(integer)', '04a1a9e927be69cd329e2fc43df67660'),
    ('private.service_claim_employee_notification_batch_pre_call_off(integer)', '11ddfe3ec4e15c6ecd7608636fe93b14'),
    ('public.service_filter_notification_recipients(text,uuid,jsonb)', '284d52e3f1eac114823e97876cf82968'),
    ('public.service_claim_timekeeping_notification_batch(integer)', 'f1e611dd9378bd9a4407e750fad10ab3'),
    ('public.service_claim_time_off_notification_batch(integer)', '05ae34871e1bad549880d0c3e5d6b8ab'),
    ('public.service_get_announcement_email_recipients(uuid)', '6920f867592b2cb40f81b72560bf96e1'),
    ('public.service_claim_support_ticket_notification_batch(integer)', '3fa61260ba733975e4a7e73b18eb50e9'),
    ('private.support_employee_can_view(uuid,public.support_tickets)', 'b68974bcf6176b9e367c624f125e640d')
  ) expected(signature,fingerprint)
  loop
    select md5(pg_get_functiondef(to_regprocedure(item.signature))) into actual;
    if actual is distinct from item.fingerprint then
      raise exception 'Operational email dependency drift: %', item.signature;
    end if;
    select pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,case when item.signature like 'public.%' then 'service_role'::regrole else p.proowner end))
      into metadata_ok from pg_proc p where p.oid=to_regprocedure(item.signature);
    if metadata_ok is distinct from true then raise exception 'Operational email dependency security metadata drift: %',item.signature;end if;
  end loop;
  select md5(pg_get_functiondef('private.preferred_delivery_email(text,text)'::regprocedure)) into actual;
  select pg_get_userbyid(p.proowner)='postgres' and not p.prosecdef and p.provolatile='i' and p.proconfig=array['search_path=""']::text[]
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.privilege_type='EXECUTE' and a.grantee not in(p.proowner,'service_role'::regrole))
    into metadata_ok from pg_proc p where p.oid='private.preferred_delivery_email(text,text)'::regprocedure;
  if actual is distinct from 'd4fbf5510bffe6cc09f7386901aaa546' or metadata_ok is distinct from true then
    raise exception 'Operational email canonical-address dependency drift.';
  end if;
end
$preflight$;

-- The ambiguity check is performed immediately before each provider handoff.
-- Keep that exact expression indexed inside the existing private boundary.
create index operational_email_current_address_idx on private.employee_contacts(private.preferred_delivery_email(personal_email,company_email));

-- Deploy inert, then cut over only after the old provider callers are verified
-- drained. Operators update this private singleton under all five lane locks.
create table private.operational_email_delivery_control (
  id boolean primary key default true check(id),
  guarded_enabled boolean not null default false,
  legacy_pause_until timestamptz check(legacy_pause_until is null or isfinite(legacy_pause_until)),
  changed_at timestamptz not null default clock_timestamp(),
  reason text not null check(length(btrim(reason)) between 8 and 500)
);
alter table private.operational_email_delivery_control enable row level security;
alter table private.operational_email_delivery_control force row level security;
revoke all on private.operational_email_delivery_control from public,anon,authenticated,service_role;
insert into private.operational_email_delivery_control(id,reason) values(true,'Installed inert; guarded email cutover requires verified old-caller quiescence.');
create trigger operational_email_delivery_control_audit after update or delete on private.operational_email_delivery_control
for each row execute function private.write_audit_event();

-- Audience rows freeze first-dispatch identities, not publish-time identities.
-- Outcome rows are append-only; an unresolved claim is held, never resent.
create table private.operational_email_delivery_ledger (
  id uuid primary key default gen_random_uuid(),
  lane text not null check(lane in ('general','timekeeping','time_off','support','employee')),
  job_id uuid not null,
  event text not null check(event in ('audience','claimed','accepted','unknown','suppressed')),
  employee_id uuid references public.employees(id) on delete restrict,
  employee_ids uuid[],
  source_message_type text,
  source_aggregate_id uuid,
  attempt_id uuid,
  address_hash text check(address_hash is null or address_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  constraint operational_email_event_shape check (
    (event='audience' and employee_id is null and employee_ids is not null and cardinality(employee_ids)<=10000 and attempt_id is null and address_hash is null and source_message_type is not null and source_aggregate_id is not null)
    or (event='claimed' and employee_id is not null and employee_ids is null and attempt_id is not null and address_hash is not null and source_message_type is null and source_aggregate_id is null)
    or (event in ('accepted','unknown') and employee_id is not null and employee_ids is null and attempt_id is not null and address_hash is null and source_message_type is null and source_aggregate_id is null)
    or (event='suppressed' and employee_id is not null and employee_ids is null and address_hash is null and source_message_type is null and source_aggregate_id is null)
  )
);
create unique index operational_email_audience_once on private.operational_email_delivery_ledger(lane,job_id) where event='audience';
create unique index operational_email_claim_once on private.operational_email_delivery_ledger(lane,job_id,employee_id) where event='claimed';
create unique index operational_email_result_once on private.operational_email_delivery_ledger(lane,job_id,employee_id) where event in ('accepted','unknown','suppressed');
create index operational_email_job_lookup on private.operational_email_delivery_ledger(lane,job_id);
alter table private.operational_email_delivery_ledger enable row level security;
alter table private.operational_email_delivery_ledger force row level security;
revoke all on private.operational_email_delivery_ledger from public,anon,authenticated,service_role;
create function private.reject_operational_email_ledger_change() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Operational email delivery evidence is append-only.'; end $$;
revoke all on function private.reject_operational_email_ledger_change() from public,anon,authenticated,service_role;
create trigger operational_email_ledger_append_only before update or delete on private.operational_email_delivery_ledger
for each row execute function private.reject_operational_email_ledger_change();

-- Shared per-lane lock plus a fresh VOLATILE lookup prevents a legacy claimant
-- from missing an audience committed while its outer statement was starting.
create function private.operational_email_claim_allowed(target_lane text,target_job_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare control private.operational_email_delivery_control%rowtype;
begin
  if coalesce((select auth.role()),'')<>'service_role' then return false;end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email-batch:'||target_lane,0)) then return false;end if;
  select * into control from private.operational_email_delivery_control where id;
  if not found then return false;end if;
  if current_setting('sygshift.operational_email_claim_lane',true)=target_lane then return control.guarded_enabled;end if;
  return not control.guarded_enabled and (control.legacy_pause_until is null or control.legacy_pause_until<=statement_timestamp())
    and not exists(select 1 from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and event='audience');
end $$;
revoke all on function private.operational_email_claim_allowed(text,uuid) from public,anon,authenticated,service_role;

do $claim_fence$
declare item record; definition text; marker_count integer;
begin
  for item in select * from (values
    ('private.service_claim_notification_batch_pre_call_off(integer)','general','where outbox.delivered_at is null'),
    ('private.service_claim_employee_notification_batch_pre_call_off(integer)','employee','where delivery.delivered_at is null'),
    ('public.service_claim_timekeeping_notification_batch(integer)','timekeeping','where outbox.message_type = ''automatic_clock_out_employee'''),
    ('public.service_claim_time_off_notification_batch(integer)','time_off','where outbox.message_type = ''time_off_decision'''),
    ('public.service_claim_support_ticket_notification_batch(integer)','support','and notification.available_at <= clock_timestamp()')
  ) mapping(signature,lane,marker) loop
    definition:=pg_get_functiondef(item.signature::regprocedure);
    marker_count:=(length(definition)-length(replace(definition,item.marker,'')))/length(item.marker);
    if marker_count<>1 then raise exception 'Operational claimant predicate drift: %',item.signature;end if;
    definition:=replace(definition,item.marker,
      case when item.lane='support' then 'and private.operational_email_claim_allowed(''support'',notification.id) '||item.marker
        when item.lane='employee' then 'where private.operational_email_claim_allowed(''employee'',delivery.id) and delivery.delivered_at is null'
        else 'where private.operational_email_claim_allowed('||quote_literal(item.lane)||',outbox.id) and '||substr(item.marker,7) end);
    execute definition;
  end loop;
end $claim_fence$;

create function private.operational_email_job(target_job_id uuid,target_lane text,require_open boolean default true)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if target_job_id is null or target_lane not in ('general','timekeeping','time_off','support','employee') then
    raise invalid_parameter_value using message='Choose a supported operational email job.';
  end if;
  if target_lane in ('general','timekeeping','time_off') then
    select jsonb_build_object('jobId',o.id,'lane',target_lane,'messageType',o.message_type,'aggregateId',o.aggregate_id,
      'recipientEmployeeId',o.recipient_employee_id,'open',o.delivered_at is null and o.failed_at is null,
      'terminalState',case when o.delivered_at is not null then 'delivered' when o.failed_at is null then 'open' when o.last_error like 'Suppressed — no currently eligible%' then 'suppressed' else 'held' end)
      into result from private.notification_outbox o where o.id=target_job_id and o.attempt_count>0 and o.attempted_at is not null
      and ((target_lane='general' and o.message_type in('announcement_published','schedule_published','call_off_supervisor_alert','document_signature_required'))
        or (target_lane='timekeeping' and o.message_type='automatic_clock_out_employee')
        or (target_lane='time_off' and o.message_type='time_off_decision'));
  elsif target_lane='support' then
    select jsonb_build_object('jobId',n.id,'lane',target_lane,'messageType',n.message_type,'aggregateId',n.ticket_id,
      'recipientEmployeeId',n.recipient_employee_id,'open',n.delivered_at is null and n.failed_at is null,
      'terminalState',case when n.delivered_at is not null then 'delivered' when n.failed_at is null then 'open' when n.last_error like 'Suppressed — no currently eligible%' then 'suppressed' else 'held' end)
      into result from public.support_ticket_notifications n where n.id=target_job_id and n.attempt_count>0 and n.attempted_at is not null;
  else
    select jsonb_build_object('jobId',d.id,'lane',target_lane,'messageType','direct_employee_notification','aggregateId',d.notification_id,
      'recipientEmployeeId',d.recipient_employee_id,'open',d.delivered_at is null and d.failed_at is null,
      'terminalState',case when d.delivered_at is not null then 'delivered' when d.failed_at is null then 'open' when d.last_error like 'Suppressed — no currently eligible%' then 'suppressed' else 'held' end)
      into result from public.employee_notification_email_deliveries d where d.id=target_job_id and d.attempt_count>0 and d.attempted_at is not null;
  end if;
  if exists(select 1 from private.operational_email_delivery_ledger l where l.lane=target_lane and l.job_id=target_job_id and l.event='audience'
    and (l.source_message_type is distinct from result->>'messageType' or l.source_aggregate_id is distinct from (result->>'aggregateId')::uuid)) then
    raise check_violation using message='The operational email source no longer matches its retained audience.';
  end if;
  if result is null or (require_open and not (result->>'open')::boolean) then
    raise invalid_parameter_value using message='This operational email job is missing, unclaimed, closed, or belongs to another lane.';
  end if;
  if (result->>'messageType'='announcement_published' and not exists(select 1 from public.announcements where id=(result->>'aggregateId')::uuid))
    or (result->>'messageType'='schedule_published' and not exists(select 1 from public.schedules where id=(result->>'aggregateId')::uuid))
    or (result->>'messageType'='call_off_supervisor_alert' and not exists(select 1 from public.call_off_reports where id=(result->>'aggregateId')::uuid))
    or (result->>'messageType'='automatic_clock_out_employee' and not exists(select 1 from public.timekeeping_operational_exceptions where id=(result->>'aggregateId')::uuid))
    or (result->>'messageType'='time_off_decision' and not exists(select 1 from public.time_off_requests where id=(result->>'aggregateId')::uuid and employee_id=(result->>'recipientEmployeeId')::uuid))
    or (target_lane='support' and not exists(select 1 from public.support_tickets where id=(result->>'aggregateId')::uuid))
    or (target_lane='employee' and not exists(select 1 from public.employee_notifications where id=(result->>'aggregateId')::uuid and recipient_employee_id=(result->>'recipientEmployeeId')::uuid)) then
    raise check_violation using message='The operational email source could not be verified.';
  end if;
  return result;
end $$;

create function private.operational_email_source_member(job jsonb,target_employee_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare kind text:=job->>'messageType'; source_record_id uuid:=(job->>'aggregateId')::uuid;
begin
  if job->>'lane'='support' then
    return exists(select 1 from public.support_tickets t where t.id=source_record_id and private.support_employee_can_view(target_employee_id,t));
  elsif job->>'lane'='employee' then
    return exists(select 1 from public.employee_notifications n where n.id=source_record_id and n.recipient_employee_id=target_employee_id
      and n.resolved_at is null and n.dismissed_at is null and (n.expires_at is null or n.expires_at>statement_timestamp()));
  elsif kind='announcement_published' then
    return exists(select 1 from private.announcement_recipient_snapshots s where s.announcement_id=source_record_id and s.employee_id=target_employee_id and s.email_enabled);
  elsif kind='schedule_published' then
    return exists(select 1 from public.employees e where e.id=target_employee_id and e.status='active'
      and (e.role in ('dispatcher','scheduler','supervisor','admin') or exists(
        select 1 from public.shift_assignments a join public.shifts s on s.id=a.shift_id
        where a.employee_id=e.id and a.status<>'canceled' and s.schedule_id=source_record_id and s.canceled_at is null)));
  elsif kind='call_off_supervisor_alert' then
    return exists(select 1 from public.employees e where e.id=target_employee_id and e.status='active' and e.role in('supervisor','admin'))
      and exists(select 1 from public.call_off_reports r join public.shifts s on s.id=r.shift_id where r.id=source_record_id
        and r.canceled_at is null and r.resolved_at is null and r.duplicate_of_call_off_report_id is null and r.replacement_needed
        and statement_timestamp()<s.ends_at+interval '1 hour');
  elsif kind='automatic_clock_out_employee' then
    return exists(select 1 from public.timekeeping_operational_exceptions e where e.id=source_record_id and e.employee_id=target_employee_id);
  elsif kind='time_off_decision' then
    return exists(select 1 from public.time_off_requests r where r.id=source_record_id and r.employee_id=target_employee_id)
      and (job->>'recipientEmployeeId')::uuid=target_employee_id;
  elsif kind='document_signature_required' then
    return (job->>'recipientEmployeeId')::uuid=target_employee_id;
  end if;
  return false;
end $$;

create function private.operational_email_address(job jsonb,target_employee_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare result text; kind text:=job->>'messageType'; announcement_type public.announcement_kind;
begin
  if not coalesce(private.operational_email_source_member(job,target_employee_id),false) then return null; end if;
  if kind='announcement_published' then select a.kind into announcement_type from public.announcements a where a.id=(job->>'aggregateId')::uuid; end if;
  select private.preferred_delivery_email(c.personal_email,c.company_email) into result
    from public.employees e join private.employee_contacts c on c.employee_id=e.id
    left join private.employee_accounts a on a.employee_id=e.id left join auth.users u on u.id=a.auth_user_id
    where e.id=target_employee_id and e.status in('active','leave') and a.disabled_at is null
      and (a.employee_id is null or (u.id is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=statement_timestamp())))
      and not exists(select 1 from private.emergency_access_authority x where x.employee_id=e.id and x.access_state<>'active')
      and (kind<>'document_signature_required' or a.employee_id is not null)
      and not exists(select 1 from public.employees other_employee
        join private.employee_contacts other_contact on other_contact.employee_id=other_employee.id
        where other_employee.id<>e.id and other_employee.status in('active','leave')
          and private.preferred_delivery_email(other_contact.personal_email,other_contact.company_email)
            =private.preferred_delivery_email(c.personal_email,c.company_email))
      and not exists(select 1 from private.employee_notification_preferences p where p.employee_id=e.id and
        case when kind='schedule_published' then not p.schedule_published
          when kind='time_off_decision' then not p.time_off_decision
          when kind='announcement_published' and announcement_type in('open_shift','overtime','event') then not p.open_shift_available
          when kind='announcement_published' then not p.announcements else false end);
  if result is not null and (length(result)>254 or result!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then return null;end if;
  return result;
end $$;

create function public.service_resolve_operational_email_recipients(target_job_id uuid,target_lane text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job jsonb; ids uuid[];
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise insufficient_privilege; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email:'||target_lane||':'||target_job_id,0)) then
    raise lock_not_available using message='This operational email job is being checked.';
  end if;
  job:=private.operational_email_job(target_job_id,target_lane);
  select employee_ids into ids from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and event='audience';
  if ids is null then
    if target_lane in('employee','support') or job->>'messageType' in('time_off_decision','document_signature_required') then
      ids:=array[(job->>'recipientEmployeeId')::uuid];
    elsif job->>'messageType'='automatic_clock_out_employee' then
      select array_agg(e.employee_id) into ids from public.timekeeping_operational_exceptions e where e.id=(job->>'aggregateId')::uuid;
    elsif job->>'messageType'='announcement_published' then
      select array_agg(s.employee_id order by s.employee_id) into ids from private.announcement_recipient_snapshots s
        where s.announcement_id=(job->>'aggregateId')::uuid and s.email_enabled;
    elsif job->>'messageType'='schedule_published' then
      select array_agg(a.id order by a.id) into ids from (
        select e.id from public.employees e where e.status='active' and e.role in('dispatcher','scheduler','supervisor','admin')
        union select e.id from public.shift_assignments a join public.shifts s on s.id=a.shift_id join public.employees e on e.id=a.employee_id
        where s.schedule_id=(job->>'aggregateId')::uuid and s.canceled_at is null and a.status<>'canceled' and e.status='active'
      ) a;
    else
      select array_agg(e.id order by e.id) into ids from public.employees e
        where e.status='active' and e.role in('supervisor','admin') and private.operational_email_source_member(job,e.id);
    end if;
    ids:=coalesce(array_remove(ids,null),array[]::uuid[]);
    if cardinality(ids)>10000 then raise program_limit_exceeded using message='Operational email audience exceeds its reviewed bound.'; end if;
    insert into private.operational_email_delivery_ledger(lane,job_id,event,employee_ids,source_message_type,source_aggregate_id)
      values(target_lane,target_job_id,'audience',ids,job->>'messageType',(job->>'aggregateId')::uuid);
  end if;
  return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('recipientEmployeeIds',to_jsonb(ids));
end $$;

create function public.service_claim_operational_email_recipient(target_job_id uuid,target_lane text,target_employee_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job jsonb; ids uuid[]; result text; address text; attempt uuid;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise insufficient_privilege; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email:'||target_lane||':'||target_job_id,0)) then raise lock_not_available; end if;
  job:=private.operational_email_job(target_job_id,target_lane);
  select employee_ids into ids from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and event='audience';
  if ids is null or target_employee_id is null or not target_employee_id=any(ids) then raise insufficient_privilege using message='Recipient is outside the retained operational audience.'; end if;
  select event into result from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and employee_id=target_employee_id and event in('accepted','unknown','suppressed');
  if result is null then
    select attempt_id into attempt from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and employee_id=target_employee_id and event='claimed';
    if attempt is not null then result:='unknown'; else
      address:=private.operational_email_address(job,target_employee_id);
      if address is null then
        insert into private.operational_email_delivery_ledger(lane,job_id,event,employee_id) values(target_lane,target_job_id,'suppressed',target_employee_id);
        result:='suppressed';
      else
        attempt:=gen_random_uuid();
        insert into private.operational_email_delivery_ledger(lane,job_id,event,employee_id,attempt_id,address_hash)
          values(target_lane,target_job_id,'claimed',target_employee_id,attempt,encode(sha256(convert_to(address,'UTF8')),'hex'));
        return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('employeeId',target_employee_id,'state','send','attemptId',attempt,'email',address);
      end if;
    end if;
  end if;
  return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('employeeId',target_employee_id,'state',case when result='unknown' then 'held' else result end);
end $$;

create function public.service_record_operational_email_recipient_result(target_job_id uuid,target_lane text,target_employee_id uuid,target_attempt_id uuid,target_outcome text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job jsonb; result text; attempt uuid;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise insufficient_privilege; end if;
  if target_outcome is null or target_outcome not in('accepted','unknown','suppressed') then raise invalid_parameter_value; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email:'||target_lane||':'||target_job_id,0)) then raise lock_not_available; end if;
  job:=private.operational_email_job(target_job_id,target_lane,false);
  select attempt_id into attempt from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and employee_id=target_employee_id and event='claimed';
  if attempt is null or target_attempt_id is distinct from attempt then raise insufficient_privilege using message='The delivery attempt does not match the retained claim.'; end if;
  select event into result from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and employee_id=target_employee_id and event in('accepted','unknown','suppressed');
  if result is null then
    insert into private.operational_email_delivery_ledger(lane,job_id,event,employee_id,attempt_id) values(target_lane,target_job_id,target_outcome,target_employee_id,attempt);
    result:=target_outcome;
  elsif result<>target_outcome and not (result='accepted' and target_outcome='unknown') then
    raise check_violation using message='Recorded delivery evidence cannot be replaced. Reconciliation is required.';
  end if;
  return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('employeeId',target_employee_id,'state',case when result='unknown' then 'held' else result end);
end $$;

create function public.service_finalize_operational_email_job(target_job_id uuid,target_lane text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job jsonb; ids uuid[]; accepted_count integer; suppressed_count integer; held_count integer; pending_count integer; result text; reason text;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise insufficient_privilege; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email:'||target_lane||':'||target_job_id,0)) then raise lock_not_available; end if;
  job:=private.operational_email_job(target_job_id,target_lane,false);
  select employee_ids into ids from private.operational_email_delivery_ledger where lane=target_lane and job_id=target_job_id and event='audience';
  if ids is null then raise check_violation using message='The operational email audience has not been retained.'; end if;
  select count(*) filter(where outcome='accepted'),count(*) filter(where outcome='suppressed'),count(*) filter(where outcome in('unknown','claimed')),count(*) filter(where outcome is null)
    into accepted_count,suppressed_count,held_count,pending_count from (select (select l.event from private.operational_email_delivery_ledger l
      where l.lane=target_lane and l.job_id=target_job_id and l.employee_id=e.id and l.event<>'audience'
      order by case when l.event='claimed' then 1 else 0 end limit 1) outcome from unnest(ids) e(id)) states;
  if pending_count>0 then raise check_violation using message='Not every retained recipient has a verified delivery outcome.'; end if;
  result:=case when held_count>0 then 'held' when accepted_count>0 then 'delivered' else 'suppressed' end;
  if job->>'terminalState'<>'open' and job->>'terminalState'<>result then
    raise check_violation using message='The held delivery requires explicit reconciliation; automatic terminal-state replacement is not allowed.';
  end if;
  reason:=case when result='held' then 'Held — provider outcome requires reconciliation; automatic resend is blocked.' when result='suppressed' then 'Suppressed — no currently eligible operational recipients.' else null end;
  if target_lane in('general','timekeeping','time_off') then
    update private.notification_outbox set delivered_at=case when result='delivered' then clock_timestamp() else null end,
      failed_at=case when result<>'delivered' then clock_timestamp() else null end,last_error=reason
      where id=target_job_id and delivered_at is null and failed_at is null;
  elsif target_lane='support' then
    update public.support_ticket_notifications set delivered_at=case when result='delivered' then clock_timestamp() else null end,
      failed_at=case when result<>'delivered' then clock_timestamp() else null end,last_error=reason
      where id=target_job_id and delivered_at is null and failed_at is null;
  else
    update public.employee_notification_email_deliveries set delivered_at=case when result='delivered' then clock_timestamp() else null end,
      failed_at=case when result<>'delivered' then clock_timestamp() else null end,last_error=reason
      where id=target_job_id and delivered_at is null and failed_at is null;
  end if;
  return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('status',result,'acceptedCount',accepted_count,'suppressedCount',suppressed_count,'heldCount',held_count);
end $$;

-- A transport/lookup failure cannot use the legacy negative-result routines:
-- those routines may clear failed_at and revive a deliberately held job.
create function public.service_defer_operational_email_job(target_job_id uuid,target_lane text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare job jsonb; result text; uncertain boolean; attempts integer; reason text;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise insufficient_privilege; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email:'||target_lane||':'||target_job_id,0)) then raise lock_not_available; end if;
  job:=private.operational_email_job(target_job_id,target_lane,false);
  if job->>'terminalState'<>'open' then
    return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('status',job->>'terminalState');
  end if;
  select exists(select 1 from private.operational_email_delivery_ledger l where l.lane=target_lane and l.job_id=target_job_id
    and (l.event='unknown' or (l.event='claimed' and not exists(select 1 from private.operational_email_delivery_ledger r
      where r.lane=l.lane and r.job_id=l.job_id and r.employee_id=l.employee_id and r.event in('accepted','unknown','suppressed'))))) into uncertain;
  if target_lane in('general','timekeeping','time_off') then select attempt_count into attempts from private.notification_outbox where id=target_job_id;
  elsif target_lane='support' then select attempt_count into attempts from public.support_ticket_notifications where id=target_job_id;
  else select attempt_count into attempts from public.employee_notification_email_deliveries where id=target_job_id;end if;
  result:=case when uncertain or attempts>=5 then 'held' else 'deferred' end;
  reason:=case when result='held' then 'Held — operational delivery requires reconciliation; automatic resend is blocked.'
    else 'Deferred — operational recipient verification was unavailable; no new provider send was authorized.' end;
  if target_lane in('general','timekeeping','time_off') then
    update private.notification_outbox set available_at=clock_timestamp()+interval '15 minutes',
      failed_at=case when result='held' then clock_timestamp() else null end,last_error=reason where id=target_job_id and delivered_at is null and failed_at is null;
  elsif target_lane='support' then
    update public.support_ticket_notifications set available_at=clock_timestamp()+interval '15 minutes',
      failed_at=case when result='held' then clock_timestamp() else null end,last_error=reason where id=target_job_id and delivered_at is null and failed_at is null;
  else
    update public.employee_notification_email_deliveries set available_at=clock_timestamp()+interval '15 minutes',
      failed_at=case when result='held' then clock_timestamp() else null end,last_error=reason where id=target_job_id and delivered_at is null and failed_at is null;
  end if;
  return (job-'recipientEmployeeId'-'open'-'terminalState')||jsonb_build_object('status',result);
end $$;

-- Existing names remain the legacy-safe entry points. New workers claim and
-- freeze an audience in one transaction through this service-only facade.
create function public.service_claim_guarded_operational_email_batch(target_lane text,target_limit integer default 10)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare claimed jsonb; item jsonb; result jsonb:='[]'::jsonb; prior_marker text:=current_setting('sygshift.operational_email_claim_lane',true); job_id uuid;
begin
  if coalesce((select auth.role()),'')<>'service_role' then raise insufficient_privilege;end if;
  if target_lane is null or target_lane not in('general','timekeeping','time_off','support','employee') then raise invalid_parameter_value;end if;
  if not pg_try_advisory_xact_lock(hashtextextended('operational-email-batch:'||target_lane,0)) then return '[]'::jsonb;end if;
  if not coalesce((select guarded_enabled from private.operational_email_delivery_control where id),false) then return '[]'::jsonb;end if;
  perform set_config('sygshift.operational_email_claim_lane',target_lane,true);
  begin
    claimed:=case target_lane
      when 'general' then public.service_claim_notification_batch(target_limit)
      when 'timekeeping' then public.service_claim_timekeeping_notification_batch(target_limit)
      when 'time_off' then public.service_claim_time_off_notification_batch(target_limit)
      when 'support' then public.service_claim_support_ticket_notification_batch(target_limit)
      when 'employee' then public.service_claim_employee_notification_batch(target_limit) end;
    if jsonb_typeof(claimed) is distinct from 'array' then raise check_violation using message='The operational claimant returned an invalid batch.';end if;
    for item in select value from jsonb_array_elements(claimed) loop
      job_id:=(item->>'id')::uuid;
      begin
        perform public.service_resolve_operational_email_recipients(job_id,target_lane);
        result:=result||jsonb_build_array(item);
      exception when invalid_parameter_value or check_violation then
        if target_lane in('general','timekeeping','time_off') then
          update private.notification_outbox set failed_at=clock_timestamp(),last_error='Held — operational email source verification failed before provider handoff.' where id=job_id and delivered_at is null and failed_at is null;
        elsif target_lane='support' then
          update public.support_ticket_notifications set failed_at=clock_timestamp(),last_error='Held — operational email source verification failed before provider handoff.' where id=job_id and delivered_at is null and failed_at is null;
        else
          update public.employee_notification_email_deliveries set failed_at=clock_timestamp(),last_error='Held — operational email source verification failed before provider handoff.' where id=job_id and delivered_at is null and failed_at is null;
        end if;
      end;
    end loop;
  exception when others then
    perform set_config('sygshift.operational_email_claim_lane',coalesce(prior_marker,''),true);raise;
  end;
  perform set_config('sygshift.operational_email_claim_lane',coalesce(prior_marker,''),true);
  return result;
end $$;

revoke all on function private.operational_email_job(uuid,text,boolean),private.operational_email_source_member(jsonb,uuid),private.operational_email_address(jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.service_resolve_operational_email_recipients(uuid,text),public.service_claim_operational_email_recipient(uuid,text,uuid),public.service_record_operational_email_recipient_result(uuid,text,uuid,uuid,text),public.service_finalize_operational_email_job(uuid,text),public.service_defer_operational_email_job(uuid,text),public.service_claim_guarded_operational_email_batch(text,integer) from public,anon,authenticated;
grant execute on function public.service_resolve_operational_email_recipients(uuid,text),public.service_claim_operational_email_recipient(uuid,text,uuid),public.service_record_operational_email_recipient_result(uuid,text,uuid,uuid,text),public.service_finalize_operational_email_job(uuid,text),public.service_defer_operational_email_job(uuid,text),public.service_claim_guarded_operational_email_batch(text,integer) to service_role;
comment on table private.operational_email_delivery_ledger is 'First-dispatch retained employee identities and append-only provider outcomes. Unresolved claims are held, not automatically resent; contains no raw email addresses.';
notify pgrst,'reload schema';
commit;

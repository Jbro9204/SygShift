-- Run against a linked/staging database in a rollback-only transaction.
-- No test punch, schedule change, audit, or notification survives this file.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create temporary table early_clock_results(test text,passed boolean) on commit drop;
do $tests$
declare
  account record; selected_account record; dashboard jsonb; result jsonb; repeated jsonb;
  future_shift uuid; candidate_shift uuid; found_candidate boolean := false; initial_count bigint;
  initial_fingerprint text; final_fingerprint text; blocked_audits bigint;
begin
  select count(*),md5(string_agg(to_jsonb(event)::text,'|' order by id)) into initial_count,initial_fingerprint from public.time_events event;
  for account in select a.auth_user_id,e.id from public.employees e join private.employee_accounts a on a.employee_id=e.id where e.status='active' and a.disabled_at is null loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',account.auth_user_id,'role','authenticated','aal','aal2')::text,true);
    dashboard := public.get_timekeeping_dashboard();
    if dashboard->'lastEvent'->>'kind' in ('clock_in','break_start','break_end') then continue; end if;
    if exists(select 1 from jsonb_array_elements(dashboard->'eligibleShifts') s where (s->>'startsAt')::timestamptz<=clock_timestamp()+interval '5 minutes' and (s->>'endsAt')::timestamptz>=clock_timestamp()) then continue; end if;
    select s.id into candidate_shift from public.shift_assignments a join public.shifts s on s.id=a.shift_id join public.schedules sc on sc.id=s.schedule_id
      where a.employee_id=account.id and a.status in ('assigned','confirmed') and a.canceled_at is null and sc.status='published' and s.canceled_at is null and s.assignment_type='standard' and s.starts_at>clock_timestamp()+interval '12 hours'
      order by s.starts_at,s.id limit 1;
    if candidate_shift is null then continue; end if;
    selected_account:=account; future_shift:=candidate_shift; found_candidate:=true; exit;
  end loop;
  if not found_candidate then raise exception 'No suitable future assignment for runtime regression'; end if;
  if not exists(select 1 from jsonb_array_elements(dashboard->'eligibleShifts') s where (s->>'shiftId')::uuid=future_shift) then raise exception 'Dashboard omits the next future assignment'; end if;
  insert into early_clock_results values('Home dashboard retains the next shift beyond 12 hours',true);

  result:=public.record_time_event('clock_in',null,'2099-01-01','early-regression-default');
  repeated:=public.record_time_event('clock_in',null,null,'early-regression-repeat');
  if result->>'code' is distinct from 'EARLY_CLOCK_IN_BLOCKED' or repeated->>'code' is distinct from 'EARLY_CLOCK_IN_BLOCKED' then raise exception 'Default early attempt lost structured popup contract'; end if;
  if (result->>'clockInEligibleAt')::timestamptz<>(result->>'scheduledShiftStart')::timestamptz-interval '5 minutes' or result->>'employeeTimeZone' is null then raise exception 'Missing trusted time or employee-local display'; end if;
  select count(*) into blocked_audits from private.audit_events where employee_id=selected_account.id and operation='EARLY_CLOCK_IN_BLOCKED' and request_id in ('early-regression-default','early-regression-repeat');
  if blocked_audits>1 then raise exception 'Repeat attempts duplicated the short-window audit'; end if;
  result:=public.record_time_event('clock_in',future_shift,null,'early-regression-explicit');
  if result->>'code' is distinct from 'EARLY_CLOCK_IN_BLOCKED' then raise exception 'Explicit early attempt lost popup contract'; end if;
  if (select count(*) from public.time_events)<>initial_count then raise exception 'Early attempt created a punch'; end if;
  insert into early_clock_results values('Explicit/default/repeated early attempts: structured response, no punch, audit deduplication, client time ignored',true);

  -- Nested rollback isolates the boundary/punch lifecycle from preserved data.
  begin
    alter table public.shifts disable trigger shifts_published_immutable;
    update public.shifts set starts_at=clock_timestamp()+interval '5 minutes 30 seconds',ends_at=clock_timestamp()+interval '8 hours' where id=future_shift;
    alter table public.shifts enable trigger shifts_published_immutable;
    result:=public.record_time_event('clock_in',future_shift,null,'early-regression-before-boundary');
    if result->>'code' is distinct from 'EARLY_CLOCK_IN_BLOCKED' then raise exception 'Clock-in accepted before five-minute boundary'; end if;
    alter table public.shifts disable trigger shifts_published_immutable;
    update public.shifts set starts_at=clock_timestamp()+interval '5 minutes'-interval '1 second' where id=future_shift;
    alter table public.shifts enable trigger shifts_published_immutable;
    result:=public.record_time_event('clock_in',future_shift,'2099-01-01','early-regression-allowed');
    if result->>'kind' is distinct from 'clock_in' or abs(extract(epoch from (result->>'recordedAt')::timestamptz-clock_timestamp()))>10 then raise exception 'Eligible clock-in did not use trusted server time'; end if;
    repeated:=public.record_time_event('clock_in',future_shift,null,'early-regression-allowed');
    if repeated->>'id' is distinct from result->>'id' then raise exception 'Idempotency failed'; end if;
    begin
      perform public.record_time_event('clock_in',future_shift,null,'early-regression-duplicate');
      raise exception 'Duplicate active clock-in was allowed';
    exception when check_violation then if sqlerrm not like '%Clock out before%' then raise; end if; end;
    perform public.record_time_event('break_start',null,null,'early-regression-break');
    begin
      perform public.record_time_event('clock_out',null,null,'early-regression-out-on-break');
      raise exception 'Clock-out while on break was allowed';
    exception when check_violation then if sqlerrm not like '%active work time%' then raise; end if; end;
    perform public.record_time_event('break_end',null,null,'early-regression-resume');
    result:=public.record_time_event('clock_out',null,null,'early-regression-out');
    if result->>'kind'<>'clock_out' or (result->>'shiftId')::uuid<>future_shift then raise exception 'Clock-out lost active shift'; end if;
    raise exception using errcode='Z0001',message='Rollback successful lifecycle';
  exception when sqlstate 'Z0001' then null; end;
  insert into early_clock_results values('Five-minute boundary, valid clock-in, retry idempotency, duplicate protection, break/resume/clock-out',true);

  begin
    alter table public.shifts disable trigger shifts_published_immutable;
    update public.shifts set assignment_type='dispatch_phone_duty' where id=future_shift;
    alter table public.shifts enable trigger shifts_published_immutable;
    begin
      perform public.record_time_event('clock_in',future_shift,null,'early-regression-concurrent');
      raise exception 'Concurrent nonpayable shift was accepted';
    exception when check_violation then if sqlerrm not like '%not an active published assignment%' then raise; end if; end;
    dashboard:=public.get_timekeeping_dashboard();
    if exists(select 1 from jsonb_array_elements(dashboard->'eligibleShifts') s where (s->>'shiftId')::uuid=future_shift) then raise exception 'Concurrent phone duty exposed as a paid choice'; end if;
    raise exception using errcode='Z0001',message='Rollback concurrent test';
  exception when sqlstate 'Z0001' then null; end;
  insert into early_clock_results values('Concurrent phone duty remains excluded from payable clock choices',true);

  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  begin
    perform public.record_time_event('clock_in',future_shift,null,'early-regression-anonymous');
    raise exception 'Anonymous punch accepted';
  exception when insufficient_privilege then null; end;
  if has_function_privilege('anon','public.record_time_event(public.time_event_kind,uuid,timestamptz,text)','execute') then raise exception 'Anonymous execute privilege opened'; end if;
  insert into early_clock_results values('Authentication and execute permissions preserved',true);
  select md5(string_agg(to_jsonb(event)::text,'|' order by id)) into final_fingerprint from public.time_events event;
  if initial_fingerprint is distinct from final_fingerprint then raise exception 'Original time events changed'; end if;
  insert into early_clock_results values('Original punch history fingerprint unchanged after nested rollback',true);
end
$tests$;
select * from early_clock_results;
rollback;

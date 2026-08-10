begin;

set search_path = '';

-- Work type is descriptive payroll data. Both supported values are paid and
-- overtime-eligible; this migration does not introduce or infer a lower rate.
alter table public.shifts
  add column if not exists work_type text not null default 'post';

alter table public.shifts
  drop constraint if exists shifts_work_type_check,
  add constraint shifts_work_type_check check (work_type in ('post', 'training'));

alter table public.time_events
  add column if not exists work_type text not null default 'post';

alter table public.time_events
  drop constraint if exists time_events_work_type_check,
  add constraint time_events_work_type_check check (work_type in ('post', 'training'));

update public.time_events event
set work_type = shift.work_type
from public.shifts shift
where shift.id = event.shift_id
  and event.work_type is distinct from shift.work_type;

create table public.time_event_work_type_corrections (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  work_type text not null,
  reason text not null,
  corrected_by uuid not null references public.employees(id) on delete restrict,
  corrected_at timestamptz not null default clock_timestamp(),
  constraint time_event_work_type_corrections_type_check check (work_type in ('post', 'training')),
  constraint time_event_work_type_corrections_reason_present check (char_length(btrim(reason)) between 8 and 1000)
);

create index time_event_work_type_corrections_event_idx
  on public.time_event_work_type_corrections(time_event_id, corrected_at desc, id desc);

alter table public.time_event_work_type_corrections enable row level security;
revoke all on table public.time_event_work_type_corrections from public, anon, authenticated;

create trigger time_event_work_type_corrections_audit
after insert on public.time_event_work_type_corrections
for each row execute function private.write_audit_event();

create trigger time_event_work_type_corrections_append_only
before update or delete on public.time_event_work_type_corrections
for each row execute function private.prevent_append_only_change();

create or replace function private.set_time_event_work_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shift_id is not null then
    select shift.work_type into new.work_type
    from public.shifts shift
    where shift.id = new.shift_id;
  end if;
  new.work_type := coalesce(new.work_type, 'post');
  return new;
end;
$$;

drop trigger if exists time_events_set_work_type on public.time_events;
create trigger time_events_set_work_type
before insert on public.time_events
for each row execute function private.set_time_event_work_type();

create table if not exists private.payroll_pay_codes (
  work_type text primary key,
  pay_code text not null unique,
  label text not null,
  paid boolean not null default true,
  overtime_eligible boolean not null default true,
  rate_source text not null default 'employee_base_rate',
  confirmed_at timestamptz,
  confirmed_by uuid references public.employees(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  constraint payroll_pay_codes_work_type_check check (work_type in ('post', 'training')),
  constraint payroll_pay_codes_code_present check (btrim(pay_code) <> ''),
  constraint payroll_pay_codes_label_present check (btrim(label) <> ''),
  constraint payroll_pay_codes_rate_source_check check (rate_source in ('employee_base_rate', 'configured_rate')),
  constraint payroll_pay_codes_paid_required check (paid),
  constraint payroll_pay_codes_overtime_required check (overtime_eligible)
);

insert into private.payroll_pay_codes (work_type, pay_code, label, paid, overtime_eligible, rate_source)
values
  ('post', 'POST', 'Post Time', true, true, 'employee_base_rate'),
  ('training', 'TRAINING', 'Training Time', true, true, 'employee_base_rate')
on conflict (work_type) do nothing;

drop trigger if exists payroll_pay_codes_audit on private.payroll_pay_codes;
create trigger payroll_pay_codes_audit
after insert or update on private.payroll_pay_codes
for each row execute function private.write_audit_event();

create or replace function public.get_work_type_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not public.has_mfa() or not (
    public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
  ) then
    raise insufficient_privilege using message = 'MFA-verified time management permission is required.';
  end if;

  return jsonb_build_object(
    'codes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'workType', code.work_type,
        'payCode', code.pay_code,
        'label', code.label,
        'paid', code.paid,
        'overtimeEligible', code.overtime_eligible,
        'rateSource', code.rate_source,
        'confirmedAt', code.confirmed_at,
        'confirmedBy', code.confirmed_by
      ) order by code.work_type)
      from private.payroll_pay_codes code
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.confirm_work_type_configuration(
  target_post_pay_code text,
  target_training_pay_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_post text := upper(btrim(coalesce(target_post_pay_code, '')));
  clean_training text := upper(btrim(coalesce(target_training_pay_code, '')));
begin
  if actor_id is null
     or not public.has_effective_permission('time.export_payroll')
     or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified payroll export permission is required.';
  end if;
  if clean_post = '' or clean_training = '' then
    raise check_violation using message = 'Both payroll pay codes are required.';
  end if;
  if clean_post = clean_training then
    raise check_violation using message = 'Post Time and Training Time must use distinct payroll pay codes.';
  end if;

  update private.payroll_pay_codes code
  set pay_code = case code.work_type when 'post' then clean_post else clean_training end,
      paid = true,
      overtime_eligible = true,
      rate_source = 'employee_base_rate',
      confirmed_at = clock_timestamp(),
      confirmed_by = actor_id,
      updated_at = clock_timestamp();

  return public.get_work_type_configuration();
end;
$$;

create or replace function public.set_shift_work_type(
  target_shift_id uuid,
  target_work_type text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  updated_shift public.shifts%rowtype;
begin
  if actor_id is null or not public.has_effective_permission('schedule.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified schedule management permission is required.';
  end if;
  if target_work_type not in ('post', 'training') then
    raise check_violation using message = 'Choose Post Time or Training Time.';
  end if;

  update public.shifts shift
  set work_type = target_work_type,
      updated_at = clock_timestamp()
  from public.schedules schedule
  where shift.id = target_shift_id
    and schedule.id = shift.schedule_id
    and schedule.status = 'draft'
  returning shift.* into updated_shift;

  if updated_shift.id is null then
    raise check_violation using message = 'Only a shift in the current working draft can change work type.';
  end if;

  return jsonb_build_object('shiftId', updated_shift.id, 'workType', updated_shift.work_type);
end;
$$;

create or replace function public.scheduler_create_typed_open_shift(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  event_requires_armed boolean,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  if target_work_type not in ('post', 'training') then
    raise check_violation using message = 'Choose Post Time or Training Time.';
  end if;

  result := public.scheduler_create_open_shift(
    target_week_starts_on,
    target_post_id,
    event_name,
    event_location_name,
    event_site_id,
    event_time_zone,
    event_requires_armed,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_overtime,
    target_notes,
    publish_announcement,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );

  perform public.set_shift_work_type((result ->> 'shift_id')::uuid, target_work_type);
  return result || jsonb_build_object('work_type', target_work_type);
end;
$$;

create or replace function public.scheduler_update_typed_draft_shift(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare result jsonb;
begin
  if target_work_type not in ('post', 'training') then
    raise check_violation using message = 'Choose Post Time or Training Time.';
  end if;

  result := public.scheduler_update_draft_shift(
    target_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note
  );
  perform public.set_shift_work_type(target_shift_id, target_work_type);
  return result;
end;
$$;

create or replace function public.replace_schedule_week_draft_with_work_types(
  source_schedule_id uuid,
  destination_week_starts_on date,
  include_assignments boolean default true,
  include_events boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  source_week date;
  destination_schedule_id uuid;
  day_offset integer;
begin
  result := public.replace_schedule_week_draft_from_revision(
    source_schedule_id,
    destination_week_starts_on,
    include_assignments,
    include_events
  );

  select schedule.week_starts_on into source_week
  from public.schedules schedule
  where schedule.id = source_schedule_id;
  destination_schedule_id := (result -> 'schedule' ->> 'id')::uuid;
  day_offset := destination_week_starts_on - source_week;

  update public.shifts destination
  set work_type = source.work_type,
      updated_at = clock_timestamp()
  from public.shifts source
  where destination.schedule_id = destination_schedule_id
    and destination.canceled_at is null
    and source.schedule_id = source_schedule_id
    and source.canceled_at is null
    and (include_events or source.event_id is null)
    and destination.post_id is not distinct from source.post_id
    and destination.event_id is not distinct from source.event_id
    and destination.starts_at = source.starts_at + make_interval(days => day_offset)
    and destination.ends_at = source.ends_at + make_interval(days => day_offset)
    and destination.time_zone = source.time_zone;

  return result;
end;
$$;

create or replace function public.get_shift_work_type_map(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role;
  selected_schedule_id uuid;
  can_view_all boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  select employee.role into actor_role from public.employees employee where employee.id = actor_id;
  can_view_all := public.has_effective_permission('schedule.view')
    or public.has_effective_permission('schedule.manage')
    or actor_role in ('admin', 'supervisor', 'scheduler', 'dispatcher');

  select schedule.id into selected_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status = case when can_view_all then schedule.status else 'published'::public.schedule_status end
  order by
    case when can_view_all and schedule.status = 'draft' then 0 when schedule.status = 'published' then 1 else 2 end,
    schedule.revision desc
  limit 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object('shiftId', shift.id, 'workType', shift.work_type) order by shift.starts_at, shift.id)
    from public.shifts shift
    where shift.schedule_id = selected_schedule_id
      and shift.canceled_at is null
      and (can_view_all or exists (
        select 1 from public.shift_assignments assignment
        where assignment.shift_id = shift.id and assignment.employee_id = actor_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
      ))
  ), '[]'::jsonb);
end;
$$;

create or replace function public.correct_time_event_work_type(
  target_time_event_id uuid,
  target_work_type text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  event_record public.time_events%rowtype;
  correction_count integer := 0;
  correction_ids uuid[] := '{}'::uuid[];
  correction_event_ids uuid[] := '{}'::uuid[];
  corrected_timestamp timestamptz := clock_timestamp();
  event_operational_date date;
  clean_reason text := btrim(coalesce(target_reason, ''));
begin
  if actor_id is null or not public.has_effective_permission('time.manage') or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified time management permission is required.';
  end if;
  if target_work_type not in ('post', 'training') then
    raise check_violation using message = 'Choose Post Time or Training Time.';
  end if;
  if char_length(clean_reason) < 8 then
    raise check_violation using message = 'Explain why the work type is being corrected.';
  end if;

  select event.* into event_record
  from public.time_events event
  where event.id = target_time_event_id;
  if event_record.id is null then
    raise no_data_found using message = 'The selected time event could not be found.';
  end if;

  select (coalesce((
    select correction.replacement_time
    from public.time_event_corrections correction
    where correction.time_event_id = event_record.id
      and correction.approved_at is not null
    order by correction.approved_at desc, correction.created_at desc, correction.id desc
    limit 1
  ), event_record.recorded_at) at time zone 'America/Denver')::date
  into event_operational_date;

  with occurrence_events as (
    select event.id
    from public.time_events event
    where event.employee_id = event_record.employee_id
      and event.shift_id is not distinct from event_record.shift_id
      and (coalesce((
        select correction.replacement_time
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
        order by correction.approved_at desc, correction.created_at desc, correction.id desc
        limit 1
      ), event.recorded_at) at time zone 'America/Denver')::date = event_operational_date
  ), inserted as (
    insert into public.time_event_work_type_corrections (
      time_event_id,
      work_type,
      reason,
      corrected_by,
      corrected_at
    )
    select occurrence.id, target_work_type, clean_reason, actor_id, corrected_timestamp
    from occurrence_events occurrence
    returning id, time_event_id
  )
  select count(*)::integer, array_agg(inserted.id), array_agg(inserted.time_event_id)
  into correction_count, correction_ids, correction_event_ids
  from inserted;

  if correction_count = 0 then
    raise no_data_found using message = 'No punches were found for this time record.';
  end if;

  return jsonb_build_object(
    'correctionCount', correction_count,
    'correctionIds', correction_ids,
    'eventIds', correction_event_ids,
    'workType', target_work_type,
    'reason', clean_reason,
    'correctedAt', corrected_timestamp,
    'correctedBy', actor_id
  );
end;
$$;

create or replace function private.effective_time_event_work_type(target_time_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select correction.work_type
    from public.time_event_work_type_corrections correction
    where correction.time_event_id = event.id
    order by correction.corrected_at desc, correction.id desc
    limit 1
  ), event.work_type, 'post')
  from public.time_events event
  where event.id = target_time_event_id
$$;

create or replace function public.get_time_work_type_map(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_view_team boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'Choose a valid work-type date range.';
  end if;

  can_view_team := public.has_effective_permission('time.view')
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll');

  return coalesce((
    with effective_events as (
      select
        event.*,
        coalesce((
          select correction.replacement_time
          from public.time_event_corrections correction
          where correction.time_event_id = event.id
            and correction.approved_at is not null
          order by correction.approved_at desc, correction.created_at desc, correction.id desc
          limit 1
        ), event.recorded_at) as effective_at
      from public.time_events event
    ), mapped as (
      select
        event.employee_id,
        event.shift_id,
        (event.effective_at at time zone 'America/Denver')::date as operational_date,
        private.effective_time_event_work_type(event.id) as work_type
      from effective_events event
      where (event.effective_at at time zone 'America/Denver')::date between target_from_date and target_through_date
        and (can_view_team or event.employee_id = actor_id)
    ), grouped as (
      select
        mapped.employee_id,
        mapped.shift_id,
        mapped.operational_date,
        case when count(distinct mapped.work_type) = 1 then min(mapped.work_type) else 'post' end as work_type,
        count(distinct mapped.work_type) > 1 as mixed_work_types
      from mapped
      group by mapped.employee_id, mapped.shift_id, mapped.operational_date
    )
    select jsonb_agg(jsonb_build_object(
      'employeeId', grouped.employee_id,
      'shiftId', grouped.shift_id,
      'operationalDate', grouped.operational_date,
      'workType', grouped.work_type,
      'payCode', code.pay_code,
      'label', code.label,
      'paid', code.paid,
      'overtimeEligible', code.overtime_eligible,
      'rateSource', code.rate_source,
      'mixedWorkTypes', grouped.mixed_work_types
    ) order by grouped.operational_date, grouped.employee_id)
    from grouped
    join private.payroll_pay_codes code on code.work_type = grouped.work_type
  ), '[]'::jsonb);
end;
$$;

-- Locked payroll rows are enriched before becoming append-only. Existing
-- calculations and overtime totals are untouched.
create or replace function private.enrich_payroll_export_work_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_work_type text := 'post';
  work_type_count integer := 0;
  pay_code_record private.payroll_pay_codes%rowtype;
begin
  select
    count(distinct private.effective_time_event_work_type(event.id)),
    min(private.effective_time_event_work_type(event.id))
  into work_type_count, effective_work_type
  from public.time_events event
  where event.employee_id = new.employee_id
    and event.shift_id is not distinct from new.shift_id
    and (coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
      order by correction.approved_at desc, correction.created_at desc, correction.id desc
      limit 1
    ), event.recorded_at) at time zone 'America/Denver')::date = new.operational_date;

  if work_type_count > 1 then
    raise exception using
      errcode = '23514',
      message = 'Mixed Post and Training time must be resolved before payroll can be locked.';
  end if;

  effective_work_type := coalesce(effective_work_type, 'post');
  select code.* into pay_code_record
  from private.payroll_pay_codes code
  where code.work_type = effective_work_type;

  new.row_payload := new.row_payload || jsonb_build_object(
    'workType', effective_work_type,
    'workTypeLabel', pay_code_record.label,
    'payCode', pay_code_record.pay_code,
    'workTypePaid', pay_code_record.paid,
    'workTypeOvertimeEligible', pay_code_record.overtime_eligible,
    'workTypeRateSource', pay_code_record.rate_source
  );
  return new;
end;
$$;

drop trigger if exists payroll_export_rows_work_type on private.payroll_export_rows;
create trigger payroll_export_rows_work_type
before insert on private.payroll_export_rows
for each row execute function private.enrich_payroll_export_work_type();

revoke all on function private.set_time_event_work_type() from public, anon, authenticated;
revoke all on function private.effective_time_event_work_type(uuid) from public, anon, authenticated;
revoke all on function private.enrich_payroll_export_work_type() from public, anon, authenticated;
revoke all on function public.get_work_type_configuration() from public, anon;
revoke all on function public.confirm_work_type_configuration(text, text) from public, anon;
revoke all on function public.set_shift_work_type(uuid, text) from public, anon;
revoke all on function public.scheduler_create_typed_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, text, boolean, uuid, text, text) from public, anon;
revoke all on function public.scheduler_update_typed_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text) from public, anon;
revoke all on function public.replace_schedule_week_draft_with_work_types(uuid, date, boolean, boolean) from public, anon;
revoke all on function public.get_shift_work_type_map(date) from public, anon;
revoke all on function public.correct_time_event_work_type(uuid, text, text) from public, anon;
revoke all on function public.get_time_work_type_map(date, date) from public, anon;

grant execute on function public.get_work_type_configuration() to authenticated;
grant execute on function public.confirm_work_type_configuration(text, text) to authenticated;
grant execute on function public.set_shift_work_type(uuid, text) to authenticated;
grant execute on function public.scheduler_create_typed_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, text, boolean, uuid, text, text) to authenticated;
grant execute on function public.scheduler_update_typed_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, text, uuid, text, text) to authenticated;
grant execute on function public.replace_schedule_week_draft_with_work_types(uuid, date, boolean, boolean) to authenticated;
grant execute on function public.get_shift_work_type_map(date) to authenticated;
grant execute on function public.correct_time_event_work_type(uuid, text, text) to authenticated;
grant execute on function public.get_time_work_type_map(date, date) to authenticated;

comment on column public.time_events.work_type is
  'Original paid work classification captured when the punch is created. Later changes are append-only corrections.';
comment on table public.time_event_work_type_corrections is
  'Append-only work-type corrections that preserve the original punch and original classification.';
comment on table private.payroll_pay_codes is
  'Confirmed payroll mapping. Post and Training Time remain paid and overtime-eligible.';

notify pgrst, 'reload schema';

commit;

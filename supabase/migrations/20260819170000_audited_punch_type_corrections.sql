begin;

-- A punch type correction is an effective, append-only correction. The source
-- event remains unchanged for audit purposes while all operational readers use
-- the latest approved effective type.
alter table public.time_event_corrections
  add column if not exists replacement_kind public.time_event_kind;

alter table public.time_event_corrections
  drop constraint if exists time_event_corrections_action;

alter table public.time_event_corrections
  add constraint time_event_corrections_action check (
    voided or replacement_time is not null or replacement_kind is not null
  );

alter table public.time_event_maintenance_notes
  drop constraint if exists time_event_maintenance_notes_action;

alter table public.time_event_maintenance_notes
  add constraint time_event_maintenance_notes_action check (
    action in (
      'manual_add',
      'time_adjust',
      'punch_type_update',
      'void',
      'location_update',
      'site_post_update',
      'work_type_update',
      'automatic_clock_out'
    )
  );

create or replace function private.protect_time_event_correction_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'time_event_corrections is append-only.';
  end if;

  if old.approved_at is not null or old.declined_at is not null then
    raise exception 'Reviewed time corrections cannot be changed.';
  end if;

  if new.time_event_id is distinct from old.time_event_id
    or new.replacement_time is distinct from old.replacement_time
    or new.replacement_kind is distinct from old.replacement_kind
    or new.voided is distinct from old.voided
    or new.reason is distinct from old.reason
    or new.requested_by is distinct from old.requested_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Correction request details cannot be changed.';
  end if;

  if new.approved_at is not null and new.declined_at is not null then
    raise exception 'A correction cannot be both approved and declined.';
  end if;

  if new.approved_at is null and new.declined_at is null then
    raise exception 'Only review decisions may be added to a correction.';
  end if;

  if new.approved_at is not null
    and (
      new.approved_by is null
      or new.declined_by is not null
      or new.declined_at is not null
    )
  then
    raise exception 'Approved corrections require only approval fields.';
  end if;

  if new.declined_at is not null
    and (
      new.declined_by is null
      or new.approved_by is not null
      or new.approved_at is not null
      or btrim(coalesce(new.decision_note, '')) = ''
    )
  then
    raise exception 'Declined corrections require a decision note.';
  end if;

  return new;
end
$$;

create or replace function private.current_effective_time_event_kind(target_event_id uuid)
returns public.time_event_kind
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select correction.replacement_kind
    from public.time_event_corrections correction
    where correction.time_event_id = event.id
      and correction.approved_at is not null
      and correction.replacement_kind is not null
    order by correction.approved_at desc, correction.created_at desc, correction.id desc
    limit 1
  ), event.kind)
  from public.time_events event
  where event.id = target_event_id
$$;

revoke all on function private.current_effective_time_event_kind(uuid) from public, anon, authenticated;

create or replace function public.supervisor_correct_time_event_details(
  target_time_event_id uuid,
  target_replacement_time timestamptz default null,
  target_replacement_kind public.time_event_kind default null,
  target_voided boolean default false,
  target_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_reason text := btrim(coalesce(target_reason, ''));
  target_event public.time_events%rowtype;
  current_effective_at timestamptz;
  current_voided boolean;
  current_effective_kind public.time_event_kind;
  resolved_replacement_time timestamptz;
  resolved_replacement_kind public.time_event_kind;
  inserted_correction public.time_event_corrections%rowtype;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Operations access with MFA is required to maintain employee time.';
  end if;

  if target_time_event_id is null then
    raise check_violation using message = 'A time event is required.';
  end if;

  if clean_reason = '' then
    raise check_violation using message = 'A maintenance reason is required.';
  end if;

  if coalesce(target_voided, false)
    and (target_replacement_time is not null or target_replacement_kind is not null)
  then
    raise check_violation using message = 'Void the duplicate or accidental punch, or correct its details; do not do both.';
  end if;

  if not coalesce(target_voided, false)
    and target_replacement_time is null
    and target_replacement_kind is null
  then
    raise check_violation using message = 'Choose a corrected time, punch type, or both.';
  end if;

  select * into target_event
  from public.time_events event
  where event.id = target_time_event_id
  for update;

  if target_event.id is null then
    raise no_data_found using message = 'The selected time event was not found.';
  end if;

  select effective.effective_at, effective.voided
  into current_effective_at, current_voided
  from private.current_effective_time_event(target_event.id) effective;

  current_effective_kind := private.current_effective_time_event_kind(target_event.id);

  if coalesce(current_voided, false) then
    raise check_violation using message = 'This punch is already voided and cannot be corrected.';
  end if;

  if not coalesce(target_voided, false) then
    resolved_replacement_time := coalesce(target_replacement_time, current_effective_at);
    resolved_replacement_kind := coalesce(target_replacement_kind, current_effective_kind);

    if resolved_replacement_time > clock_timestamp() + interval '15 minutes' then
      raise check_violation using message = 'Replacement time cannot be in the future.';
    end if;

    if resolved_replacement_time is not distinct from current_effective_at
      and resolved_replacement_kind is not distinct from current_effective_kind
    then
      raise check_violation using message = 'The corrected punch is unchanged. Update the time, punch type, or both.';
    end if;
  end if;

  insert into public.time_event_corrections (
    time_event_id,
    replacement_time,
    replacement_kind,
    voided,
    reason,
    requested_by,
    approved_by,
    approved_at,
    decision_note
  )
  values (
    target_event.id,
    case when coalesce(target_voided, false) then null else resolved_replacement_time end,
    case when coalesce(target_voided, false) then null else resolved_replacement_kind end,
    coalesce(target_voided, false),
    clean_reason,
    actor_id,
    actor_id,
    clock_timestamp(),
    'Operations maintenance correction.'
  )
  returning * into inserted_correction;

  insert into public.time_event_maintenance_notes (
    time_event_id,
    action,
    note,
    created_by
  )
  values (
    target_event.id,
    case
      when coalesce(target_voided, false) then 'void'
      when resolved_replacement_kind is distinct from current_effective_kind then 'punch_type_update'
      else 'time_adjust'
    end,
    clean_reason,
    actor_id
  );

  return jsonb_build_object(
    'id', inserted_correction.id,
    'timeEventId', inserted_correction.time_event_id,
    'replacementTime', inserted_correction.replacement_time,
    'replacementKind', inserted_correction.replacement_kind,
    'recordedKind', target_event.kind,
    'voided', inserted_correction.voided,
    'requestedBy', inserted_correction.requested_by,
    'approvedBy', inserted_correction.approved_by,
    'approvedAt', inserted_correction.approved_at,
    'reason', inserted_correction.reason
  );
end
$$;

revoke all on function public.supervisor_correct_time_event_details(uuid, timestamptz, public.time_event_kind, boolean, text) from public, anon;
grant execute on function public.supervisor_correct_time_event_details(uuid, timestamptz, public.time_event_kind, boolean, text) to authenticated;

-- Patch established readers at their source-event boundary. Downstream payroll,
-- exception, dashboard, and attendance calculations then consume the effective
-- kind without rewriting the original event.
create or replace function private.patch_effective_punch_kind(
  target_function regprocedure,
  target_fragment text,
  replacement_fragment text
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  function_sql text;
  patched_sql text;
begin
  select pg_get_functiondef(target_function) into function_sql;
  if function_sql is null or position(target_fragment in function_sql) = 0 then
    raise check_violation using message = format('Effective punch-type patch target was not found in %s.', target_function::text);
  end if;

  patched_sql := replace(function_sql, target_fragment, replacement_fragment);
  if patched_sql = function_sql then
    raise check_violation using message = format('Effective punch-type patch did not change %s.', target_function::text);
  end if;
  execute patched_sql;
end
$$;

select private.patch_effective_punch_kind(
  'public.get_time_maintenance(date,date,uuid)'::regprocedure,
  E'      event.kind,',
  E'      private.current_effective_time_event_kind(event.id) as kind,\n      event.kind as recorded_kind,'
);
select private.patch_effective_punch_kind(
  'public.get_time_maintenance(date,date,uuid)'::regprocedure,
  E'    \'kind\', kind,',
  E'    \'kind\', kind,\n    \'recordedKind\', recorded_kind,'
);

select private.patch_effective_punch_kind(
  'private.get_timekeeping_review_base(date,date)'::regprocedure,
  E'      event.kind,',
  E'      private.current_effective_time_event_kind(event.id) as kind,'
);

select private.patch_effective_punch_kind(
  'private.get_timekeeping_occurrence_context(uuid,uuid,date)'::regprocedure,
  E'    event.kind,',
  E'    private.current_effective_time_event_kind(event.id) as kind,'
);
select private.patch_effective_punch_kind(
  'private.get_timekeeping_occurrence_context(uuid,uuid,date,timestamptz)'::regprocedure,
  E'    event.kind,',
  E'    private.current_effective_time_event_kind(event.id) as kind,'
);

select private.patch_effective_punch_kind(
  'public.get_team_attendance_summary(date,date)'::regprocedure,
  E'      time_event.kind,',
  E'      private.current_effective_time_event_kind(time_event.id) as kind,'
);
select private.patch_effective_punch_kind(
  'private.get_attendance_reconciliation_snapshot(uuid)'::regprocedure,
  E'    time_event.kind,',
  E'    private.current_effective_time_event_kind(time_event.id) as kind,'
);

select private.patch_effective_punch_kind(
  'public.get_overview_metrics_payload()'::regprocedure,
  E'      event.kind,',
  E'      private.current_effective_time_event_kind(event.id) as kind,'
);
select private.patch_effective_punch_kind(
  'public.get_timekeeping_dashboard(date)'::regprocedure,
  E'    \'kind\', event.kind,',
  E'    \'kind\', private.current_effective_time_event_kind(event.id),'
);
select private.patch_effective_punch_kind(
  'public.record_time_event(public.time_event_kind,uuid,timestamptz,text)'::regprocedure,
  E'  select event.kind, event.shift_id',
  E'  select private.current_effective_time_event_kind(event.id), event.shift_id'
);

select private.patch_effective_punch_kind(
  'private.apply_adjustment_request_event(uuid,uuid,uuid,public.time_event_kind,timestamptz,text,uuid)'::regprocedure,
  E'    and event.kind = target_kind',
  E'    and private.current_effective_time_event_kind(event.id) = target_kind'
);
select private.patch_effective_punch_kind(
  'public.review_time_adjustment_request(uuid,text,text,boolean)'::regprocedure,
  E'      and event.kind = \'clock_in\'',
  E'      and private.current_effective_time_event_kind(event.id) = \'clock_in\''
);
select private.patch_effective_punch_kind(
  'public.review_time_adjustment_request(uuid,text,text,boolean)'::regprocedure,
  E'      and event.kind = \'clock_out\'',
  E'      and private.current_effective_time_event_kind(event.id) = \'clock_out\''
);
select private.patch_effective_punch_kind(
  'private.get_unscheduled_time_session_start(uuid,uuid,timestamptz)'::regprocedure,
  E'      and prior_event.kind = \'clock_out\'',
  E'      and private.current_effective_time_event_kind(prior_event.id) = \'clock_out\''
);
select private.patch_effective_punch_kind(
  'private.get_unscheduled_time_session_start(uuid,uuid,timestamptz)'::regprocedure,
  E'    and candidate.kind = \'clock_in\'',
  E'    and private.current_effective_time_event_kind(candidate.id) = \'clock_in\''
);
select private.patch_effective_punch_kind(
  'public.service_run_timekeeping_automation(uuid)'::regprocedure,
  E'      select event.id, event.kind, effective.effective_at',
  E'      select event.id, private.current_effective_time_event_kind(event.id) as kind, effective.effective_at'
);
select private.patch_effective_punch_kind(
  'public.service_run_timekeeping_automation(uuid)'::regprocedure,
  E'          and event.kind = \'clock_in\'',
  E'          and private.current_effective_time_event_kind(event.id) = \'clock_in\''
);

drop function private.patch_effective_punch_kind(regprocedure, text, text);

comment on column public.time_event_corrections.replacement_kind is
  'Authorized effective punch type; the immutable source kind remains on public.time_events.';
comment on function public.supervisor_correct_time_event_details(uuid, timestamptz, public.time_event_kind, boolean, text) is
  'Corrects punch time and/or type through an approved append-only record, or voids a duplicate or accidental punch.';

commit;

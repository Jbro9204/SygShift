begin;

create or replace function public.scheduler_update_draft_shift(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.update_schedule_draft_shift(
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
  )
$$;

comment on function public.scheduler_update_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) is
  'API-facing scheduler draft shift update RPC with a single signature to avoid PostgREST overload ambiguity.';

create or replace function public.scheduler_create_open_shift(
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
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.create_supervisor_open_shift(
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
  )
$$;

comment on function public.scheduler_create_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) is
  'API-facing scheduler open-shift creation RPC with a single signature to avoid PostgREST overload ambiguity.';

create or replace function public.scheduler_resolve_review_shift(
  target_shift_id uuid,
  target_employee_id uuid,
  resolution_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.resolve_schedule_review_shift(
    target_shift_id,
    target_employee_id,
    resolution_note,
    target_credential_override_note
  )
$$;

comment on function public.scheduler_resolve_review_shift(uuid, uuid, text, text) is
  'API-facing scheduler review resolution RPC with a single signature to avoid PostgREST overload ambiguity.';

revoke all on function public.scheduler_update_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) from public, anon;
revoke all on function public.scheduler_create_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) from public, anon;
revoke all on function public.scheduler_resolve_review_shift(uuid, uuid, text, text) from public, anon;

grant execute on function public.scheduler_update_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) to authenticated;
grant execute on function public.scheduler_create_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) to authenticated;
grant execute on function public.scheduler_resolve_review_shift(uuid, uuid, text, text) to authenticated;

do $$
begin
  if to_regprocedure('public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text)') is not null then
    revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text) from authenticated;
  end if;

  if to_regprocedure('public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean)') is not null then
    revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean) from authenticated;
  end if;

  if to_regprocedure('public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text)') is not null then
    revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text) from authenticated;
  end if;

  if to_regprocedure('public.resolve_schedule_review_shift(uuid, uuid, text)') is not null then
    revoke all on function public.resolve_schedule_review_shift(uuid, uuid, text) from authenticated;
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

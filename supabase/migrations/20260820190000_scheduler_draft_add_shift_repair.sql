begin;

-- The Add shift workflow is a draft editor. The legacy implementation created
-- and published a brand-new revision on every save, which conflicts with the
-- one-published-revision-per-week integrity rule whenever a working draft is
-- already open. Reuse the authoritative working draft instead.
do $repair_scheduler_add_shift$
declare
  function_sql text;
  updated_sql text;
  schedule_setup_start integer;
  event_setup_start integer;
  publication_start integer;
  announcement_start integer;
  draft_schedule_setup text := $draft_setup$  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || target_week_starts_on::text));
  perform public.ensure_schedule_draft(target_week_starts_on);

  select schedule.* into latest_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1
  for update;

  if latest_schedule.id is null then
    raise check_violation using message = 'The working schedule draft could not be opened.';
  end if;

  new_schedule_id := latest_schedule.id;
  new_revision := latest_schedule.revision;

$draft_setup$;
  draft_update text := $draft_update$  update public.schedules schedule
  set updated_at = clock_timestamp()
  where schedule.id = new_schedule_id;

$draft_update$;
  audit_insert text := $audit_insert$  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    auth.uid(),
    actor_id,
    'public',
    'shifts',
    'add_to_draft',
    new_shift_id::text,
    jsonb_build_object(
      'schedule_id', new_schedule_id,
      'schedule_revision', new_revision,
      'employee_id', target_employee_id,
      'announcement_prepared', new_announcement_id is not null
    )
  );

$audit_insert$;
begin
  select pg_get_functiondef(
    'private.create_supervisor_open_shift_unmerged(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)'::regprocedure
  ) into function_sql;

  schedule_setup_start := position('  select schedule.* into latest_schedule' in function_sql);
  event_setup_start := position('  if is_event_shift then' in function_sql);

  if schedule_setup_start = 0 or event_setup_start <= schedule_setup_start then
    raise check_violation using message = 'The scheduler draft setup boundaries could not be found safely.';
  end if;

  updated_sql := substring(function_sql from 1 for schedule_setup_start - 1)
    || draft_schedule_setup
    || substring(function_sql from event_setup_start);

  publication_start := position('  if latest_schedule.status = ''published'' then' in updated_sql);
  announcement_start := position('  if target_employee_id is null and coalesce(publish_announcement, true) then' in updated_sql);

  if publication_start = 0 or announcement_start <= publication_start then
    raise check_violation using message = 'The legacy scheduler publication block could not be found safely.';
  end if;

  updated_sql := substring(updated_sql from 1 for publication_start - 1)
    || draft_update
    || substring(updated_sql from announcement_start);

  -- A requested opening announcement remains unpublished while the shift is a
  -- draft. Publishing the schedule activates it through the schedule trigger
  -- below, so guards never receive an opening before the schedule is live.
  updated_sql := replace(
    updated_sql,
    E'      new_shift_id,\n      new_event_id,\n      clock_timestamp(),\n      shift_ends_at,',
    E'      new_shift_id,\n      new_event_id,\n      null,\n      shift_ends_at,'
  );

  updated_sql := replace(
    updated_sql,
    E'  return jsonb_build_object(\n',
    audit_insert || E'  return jsonb_build_object(\n'
  );

  if updated_sql = function_sql
    or position('perform public.ensure_schedule_draft(target_week_starts_on);' in updated_sql) = 0
    or position('schedule.status = ''draft''' in updated_sql) = 0
    or position(E'  update public.schedules\n  set\n    status = ''published''' in updated_sql) > 0
    or position(E'new_event_id,\n      null,\n      shift_ends_at' in updated_sql) = 0
    or position('''add_to_draft''' in updated_sql) = 0
  then
    raise check_violation using message = 'The scheduler add-shift draft repair could not be installed safely.';
  end if;

  execute updated_sql;
end
$repair_scheduler_add_shift$;

create or replace function private.publish_prepared_schedule_announcements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    update public.announcements announcement
    set
      published_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where announcement.published_at is null
      and announcement.shift_id in (
        select shift.id
        from public.shifts shift
        where shift.schedule_id = new.id
          and shift.canceled_at is null
      );
  end if;

  return new;
end
$$;

drop trigger if exists schedules_publish_prepared_announcements on public.schedules;
create trigger schedules_publish_prepared_announcements
after update of status on public.schedules
for each row
when (new.status = 'published' and old.status is distinct from 'published')
execute function private.publish_prepared_schedule_announcements();

revoke all on function private.publish_prepared_schedule_announcements() from public, anon, authenticated;

comment on function private.create_supervisor_open_shift_unmerged(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text) is
  'Adds an assigned or open shift to the authoritative working draft without changing the live published schedule.';

comment on function private.publish_prepared_schedule_announcements() is
  'Publishes opening announcements prepared on a schedule draft only when that draft becomes the live schedule.';

notify pgrst, 'reload schema';

commit;

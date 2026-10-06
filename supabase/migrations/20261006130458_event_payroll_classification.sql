begin;

set search_path = '';

-- EP and TRUEP are payroll reporting categories, not rates. Finance and
-- Payroll continue to own rate and overtime allocation decisions.
alter table public.sites
  add column if not exists supports_ep_truep_payroll boolean not null default false;

alter table public.shifts
  add column if not exists payroll_category text not null default 'regular';

alter table public.shifts
  drop constraint if exists shifts_payroll_category_check,
  add constraint shifts_payroll_category_check
    check (payroll_category in ('regular', 'ep', 'truep'));

alter table public.time_events
  add column if not exists payroll_category text not null default 'regular';

alter table public.time_events
  drop constraint if exists time_events_payroll_category_check,
  add constraint time_events_payroll_category_check
    check (payroll_category in ('regular', 'ep', 'truep'));

-- Existing live data is intentionally Regular. Existing locked payroll JSON
-- remains untouched and therefore visibly legacy/unclassified.
create table public.time_event_payroll_category_corrections (
  id uuid primary key default gen_random_uuid(),
  time_event_id uuid not null references public.time_events(id) on delete restrict,
  payroll_category text not null,
  reason text not null,
  corrected_by uuid not null references public.employees(id) on delete restrict,
  corrected_at timestamptz not null default clock_timestamp(),
  constraint time_event_payroll_category_corrections_category_check
    check (payroll_category in ('regular', 'ep', 'truep')),
  constraint time_event_payroll_category_corrections_reason_present
    check (char_length(btrim(reason)) between 8 and 1000)
);

create index time_event_payroll_category_corrections_event_idx
  on public.time_event_payroll_category_corrections
    (time_event_id, corrected_at desc, id desc);

alter table public.time_event_payroll_category_corrections enable row level security;
revoke all on table public.time_event_payroll_category_corrections
  from public, anon, authenticated;

create trigger time_event_payroll_category_corrections_audit
after insert on public.time_event_payroll_category_corrections
for each row execute function private.write_audit_event();

create trigger time_event_payroll_category_corrections_append_only
before update or delete on public.time_event_payroll_category_corrections
for each row execute function private.prevent_append_only_change();

create function private.shift_location_supports_ep_truep_payroll(
  target_post_id uuid,
  target_event_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select site.supports_ep_truep_payroll
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id
    union all
    select site.supports_ep_truep_payroll
    from public.events event
    join public.sites site on site.id = event.site_id
    where event.id = target_event_id
    limit 1
  ), false)
$$;

create function private.shift_payroll_category_preservation_allowed(
  target_schedule_id uuid,
  target_post_id uuid,
  target_event_id uuid,
  target_starts_at timestamptz,
  target_ends_at timestamptz,
  target_payroll_category text,
  target_coverage_source_shift_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.shifts source_shift
      join public.schedules source_schedule on source_schedule.id = source_shift.schedule_id
      join public.schedules destination_schedule on destination_schedule.id = target_schedule_id
      where source_shift.id = target_coverage_source_shift_id
        and source_schedule.week_starts_on = destination_schedule.week_starts_on
        and source_shift.post_id is not distinct from target_post_id
        and source_shift.event_id is not distinct from target_event_id
        and source_shift.starts_at = target_starts_at
        and source_shift.ends_at = target_ends_at
        and source_shift.payroll_category = target_payroll_category
    )
    or exists (
      with recursive schedule_ancestors as (
        select schedule.previous_revision_id as schedule_id
        from public.schedules schedule
        where schedule.id = target_schedule_id
        union all
        select schedule.previous_revision_id
        from public.schedules schedule
        join schedule_ancestors ancestor on ancestor.schedule_id = schedule.id
        where schedule.previous_revision_id is not null
      )
      select 1
      from schedule_ancestors ancestor
      join public.shifts source_shift on source_shift.schedule_id = ancestor.schedule_id
      where source_shift.canceled_at is null
        and source_shift.post_id is not distinct from target_post_id
        and source_shift.event_id is not distinct from target_event_id
        and source_shift.starts_at = target_starts_at
        and source_shift.ends_at = target_ends_at
        and source_shift.payroll_category = target_payroll_category
    )
$$;

create function private.enforce_shift_payroll_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inherited_category text;
begin
  if tg_op = 'INSERT' and new.coverage_source_shift_id is not null then
    select shift.payroll_category
    into inherited_category
    from public.shifts shift
    where shift.id = new.coverage_source_shift_id;

    if inherited_category is null then
      raise check_violation using message = 'The source shift for replacement coverage was not found.';
    end if;

    new.payroll_category := inherited_category;
  end if;

  new.payroll_category := lower(btrim(coalesce(new.payroll_category, 'regular')));

  if new.payroll_category not in ('regular', 'ep', 'truep') then
    raise check_violation using message = 'Choose Regular, EP, or TRUEP.';
  end if;

  if new.payroll_category = 'regular' then
    return new;
  end if;

  -- A no-op category on the same shift/location remains editable after a site
  -- is disabled. Disabling the site never rewrites historical classification.
  if tg_op = 'UPDATE'
    and new.payroll_category is not distinct from old.payroll_category
    and new.schedule_id is not distinct from old.schedule_id
    and new.post_id is not distinct from old.post_id
    and new.event_id is not distinct from old.event_id
  then
    return new;
  end if;

  if private.shift_location_supports_ep_truep_payroll(new.post_id, new.event_id) then
    return new;
  end if;

  if tg_op = 'INSERT' and private.shift_payroll_category_preservation_allowed(
    new.schedule_id,
    new.post_id,
    new.event_id,
    new.starts_at,
    new.ends_at,
    new.payroll_category,
    new.coverage_source_shift_id
  ) then
    return new;
  end if;

  raise check_violation using message =
    'EP and TRUEP are available only for a site with EP / TRUEP payroll enabled.';
end;
$$;

drop trigger if exists shifts_enforce_payroll_category on public.shifts;
create trigger shifts_enforce_payroll_category
before insert or update of payroll_category, schedule_id, post_id, event_id,
  coverage_source_shift_id on public.shifts
for each row execute function private.enforce_shift_payroll_category();

create function private.set_shift_payroll_category(
  target_shift_id uuid,
  target_payroll_category text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  shift_record public.shifts%rowtype;
  schedule_status public.schedule_status;
  clean_category text := lower(btrim(coalesce(target_payroll_category, 'regular')));
begin
  if clean_category not in ('regular', 'ep', 'truep') then
    raise check_violation using message = 'Choose Regular, EP, or TRUEP.';
  end if;

  select shift.*
  into shift_record
  from public.shifts shift
  where shift.id = target_shift_id
  for update of shift;

  if shift_record.id is null then
    raise no_data_found using message = 'The shift could not be found.';
  end if;

  select schedule.status
  into schedule_status
  from public.schedules schedule
  where schedule.id = shift_record.schedule_id;

  if shift_record.payroll_category = clean_category then
    return;
  end if;

  if schedule_status <> 'draft' then
    raise check_violation using message = 'Published schedule history cannot be reclassified.';
  end if;

  update public.shifts shift
  set payroll_category = clean_category,
      updated_at = clock_timestamp()
  where shift.id = target_shift_id;
end;
$$;

create function private.set_time_event_payroll_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shift_id is not null then
    select shift.payroll_category
    into new.payroll_category
    from public.shifts shift
    where shift.id = new.shift_id;
  end if;

  new.payroll_category := coalesce(new.payroll_category, 'regular');
  return new;
end;
$$;

drop trigger if exists time_events_set_payroll_category on public.time_events;
create trigger time_events_set_payroll_category
before insert on public.time_events
for each row execute function private.set_time_event_payroll_category();

create function private.effective_time_event_shift_id(target_time_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select event.shift_id
  from private.get_effective_time_events() event
  where event.id = target_time_event_id
$$;

create function private.get_effective_time_event_payroll_categories(
  target_employee_id uuid default null
)
returns table (
  id uuid,
  employee_id uuid,
  occurrence_key text,
  assignment_anchor timestamptz,
  original_shift_id uuid,
  shift_id uuid,
  kind public.time_event_kind,
  effective_at timestamptz,
  voided boolean,
  payroll_category text
)
language sql
stable
security definer
set search_path = ''
as $$
with effective_events as materialized (
  select event.*
  from private.get_effective_time_events_with_occurrence(target_employee_id) event
), latest_category_correction as (
  select distinct on (correction.time_event_id)
    correction.time_event_id,
    correction.payroll_category
  from public.time_event_payroll_category_corrections correction
  join effective_events event on event.id = correction.time_event_id
  order by correction.time_event_id, correction.corrected_at desc, correction.id desc
)
select
  event.id,
  event.employee_id,
  event.occurrence_key,
  event.assignment_anchor,
  event.original_shift_id,
  event.shift_id,
  event.kind,
  event.effective_at,
  event.voided,
  coalesce(
    category_correction.payroll_category,
    case
      when event.shift_id is distinct from source_event.shift_id
        or event.original_shift_id is distinct from source_event.shift_id
      then effective_shift.payroll_category
      else null
    end,
    source_event.payroll_category,
    effective_shift.payroll_category,
    'regular'
  ) as payroll_category
from effective_events event
join public.time_events source_event on source_event.id = event.id
left join latest_category_correction category_correction
  on category_correction.time_event_id = event.id
left join public.shifts effective_shift on effective_shift.id = event.shift_id
$$;

create function private.effective_time_event_payroll_category(target_time_event_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select event.payroll_category
  from private.get_effective_time_event_payroll_categories() event
  where event.id = target_time_event_id
$$;

create function private.lock_payroll_category_occurrence(target_occurrence_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(target_occurrence_key, '')), '') is null then
    raise check_violation using message =
      'A worked-time occurrence is required before its payroll category can be locked.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('payroll-category-occurrence:' || target_occurrence_key, 0)
  );
end;
$$;

-- Keep old named-argument site clients compatible. NULL preserves the flag on
-- UPDATE; INSERT still defaults it to false.
drop function public.upsert_site(uuid, text, text, text, text, text, text, text, boolean);

create or replace function public.get_sites_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view sites and posts.';
  end if;

  if not public.has_effective_permission('sites.manage') then
    raise insufficient_privilege using message = 'Sites and posts permission is required.';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', site.id,
      'code', site.code,
      'name', site.name,
      'address_line_1', site.address_line_1,
      'city', site.city,
      'region', site.region,
      'postal_code', site.postal_code,
      'time_zone', site.time_zone,
      'active', site.active,
      'supports_ep_truep_payroll', site.supports_ep_truep_payroll,
      'posts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', post.id,
          'name', post.name,
          'requires_armed', post.requires_armed,
          'active', post.active,
          'default_start_time', post.default_start_time,
          'default_end_time', post.default_end_time
        ) order by post.active desc, post.name)
        from public.posts post
        where post.site_id = site.id
      ), '[]'::jsonb)
    ) order by site.active desc, site.name), '[]'::jsonb)
    from public.sites site
  );
end;
$$;

create function public.upsert_site(
  target_site_id uuid default null,
  target_code text default null,
  target_name text default null,
  target_address_line_1 text default null,
  target_city text default null,
  target_region text default null,
  target_postal_code text default null,
  target_time_zone text default 'America/Denver',
  target_active boolean default true,
  target_supports_ep_truep_payroll boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  saved_site_id uuid;
begin
  actor_id := private.require_sites_manager();

  if btrim(coalesce(target_name, '')) = '' then
    raise check_violation using message = 'Site name is required.';
  end if;

  if target_site_id is null then
    insert into public.sites (
      code, name, address_line_1, city, region, postal_code, time_zone,
      active, supports_ep_truep_payroll
    ) values (
      nullif(upper(btrim(coalesce(target_code, ''))), ''),
      btrim(target_name),
      nullif(btrim(coalesce(target_address_line_1, '')), ''),
      nullif(btrim(coalesce(target_city, '')), ''),
      nullif(upper(btrim(coalesce(target_region, ''))), ''),
      nullif(btrim(coalesce(target_postal_code, '')), ''),
      coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver'),
      coalesce(target_active, true),
      coalesce(target_supports_ep_truep_payroll, false)
    )
    returning id into saved_site_id;
  else
    update public.sites site
    set
      code = nullif(upper(btrim(coalesce(target_code, ''))), ''),
      name = btrim(target_name),
      address_line_1 = nullif(btrim(coalesce(target_address_line_1, '')), ''),
      city = nullif(btrim(coalesce(target_city, '')), ''),
      region = nullif(upper(btrim(coalesce(target_region, ''))), ''),
      postal_code = nullif(btrim(coalesce(target_postal_code, '')), ''),
      time_zone = coalesce(nullif(btrim(coalesce(target_time_zone, '')), ''), 'America/Denver'),
      active = coalesce(target_active, true),
      supports_ep_truep_payroll = coalesce(
        target_supports_ep_truep_payroll,
        site.supports_ep_truep_payroll
      ),
      updated_at = clock_timestamp()
    where site.id = target_site_id
    returning site.id into saved_site_id;

    if saved_site_id is null then
      raise no_data_found using message = 'The site record was not found.';
    end if;
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'sites',
    case when target_site_id is null then 'INSERT' else 'UPDATE' end,
    saved_site_id::text,
    (select to_jsonb(site) from public.sites site where site.id = saved_site_id)
  );

  return public.get_sites_payload();
end;
$$;

create or replace function public.get_schedule_builder_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', post.id,
        'name', post.name,
        'requires_armed', post.requires_armed,
        'site', jsonb_build_object(
          'id', site.id,
          'code', site.code,
          'name', site.name,
          'time_zone', site.time_zone,
          'supports_dispatch_phone_duty', site.supports_dispatch_phone_duty,
          'supports_ep_truep_payroll', site.supports_ep_truep_payroll
        )
      ) order by site.name, post.name)
      from public.posts post
      join public.sites site on site.id = post.site_id
      where post.active and site.active
    ), '[]'::jsonb),
    'employees',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'first_name', employee.first_name,
        'last_name', employee.last_name,
        'preferred_name', employee.preferred_name,
        'employee_number', employee.employee_number,
        'role', employee.role,
        'employment_type', employee.employment_type,
        'time_zone', employee.time_zone,
        'has_armed_guard_credential', public.has_valid_credential(employee.id, 'armed_guard', current_date)
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      where employee.status = 'active'
        and employee.role in (
          'guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin'
        )
    ), '[]'::jsonb)
  )
  where private.can_manage_schedule_drafts()
    or public.has_effective_permission('scheduler.view')
$$;

-- Canonical revision cloning must preserve an existing category, even if the
-- site was disabled after publication.
create or replace function private.copy_schedule_shift_block(
  source_shift_id uuid,
  destination_schedule_id uuid,
  actor_id uuid,
  include_only_employee_id uuid default null,
  exclude_employee_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  select shift.* into source_shift
  from public.shifts shift
  where shift.id = source_shift_id and shift.canceled_at is null;

  if source_shift.id is null then return null; end if;

  insert into public.shifts (
    schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, is_overtime, notes,
    work_type, payroll_category, time_zone_source, time_zone_employee_id,
    assignment_type, coverage_source_shift_id, created_by
  ) values (
    destination_schedule_id, source_shift.post_id, source_shift.event_id,
    source_shift.starts_at, source_shift.ends_at, source_shift.time_zone,
    source_shift.headcount_required, source_shift.requires_armed, source_shift.is_open,
    source_shift.is_overtime, source_shift.notes, source_shift.work_type,
    source_shift.payroll_category, source_shift.time_zone_source,
    source_shift.time_zone_employee_id, source_shift.assignment_type,
    source_shift.coverage_source_shift_id, actor_id
  ) returning id into copied_shift_id;

  insert into public.schedule_assignment_overrides (
    shift_id, employee_id, override_kind, note, created_by, created_at
  )
  select copied_shift_id, override_record.employee_id, override_record.override_kind,
    override_record.note, override_record.created_by, override_record.created_at
  from public.schedule_assignment_overrides override_record
  where override_record.shift_id = source_shift.id
    and (include_only_employee_id is null or override_record.employee_id = include_only_employee_id)
    and (exclude_employee_id is null or override_record.employee_id <> exclude_employee_id)
    and exists (
      select 1 from public.shift_assignments source_assignment
      where source_assignment.shift_id = source_shift.id
        and source_assignment.employee_id = override_record.employee_id
        and source_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by, assigned_at,
    confirmed_at, canceled_at, cancellation_reason
  )
  select copied_shift_id, assignment.employee_id, assignment.status,
    assignment.assigned_by, assignment.assigned_at, assignment.confirmed_at,
    assignment.canceled_at, assignment.cancellation_reason
  from public.shift_assignments assignment
  where assignment.shift_id = source_shift.id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and (include_only_employee_id is null or assignment.employee_id = include_only_employee_id)
    and (exclude_employee_id is null or assignment.employee_id <> exclude_employee_id);

  delete from public.schedule_assignment_overrides override_record
  where override_record.shift_id = copied_shift_id
    and not exists (
      select 1 from public.shift_assignments copied_assignment
      where copied_assignment.shift_id = override_record.shift_id
        and copied_assignment.employee_id = override_record.employee_id
        and copied_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  update public.shifts shift
  set is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
      updated_at = clock_timestamp()
  where shift.id = copied_shift_id;

  return copied_shift_id;
end;
$$;

-- Patch the current, DST-safe week-copy core rather than recreating its large
-- and carefully reviewed wall-clock implementation. The guarded replacements
-- make drift fail the migration instead of silently losing classification.
do $patch_week_copy_payroll_category$
declare
  definition text;
  source_schedule_guard text := $marker$
  if source_schedule.week_starts_on = destination_week_starts_on then
    raise check_violation using message = 'Choose a destination week different from the source week.';
  end if;

  select coalesce(
$marker$;
  replacement_schedule_guard text := $marker$
  if source_schedule.week_starts_on = destination_week_starts_on then
    raise check_violation using message = 'Choose a destination week different from the source week.';
  end if;

  if exists (
    select 1
    from public.shifts shift
    where shift.schedule_id = source_schedule.id
      and shift.canceled_at is null
      and (include_events or shift.event_id is null)
      and shift.payroll_category <> 'regular'
      and not private.shift_location_supports_ep_truep_payroll(shift.post_id, shift.event_id)
  ) then
    raise check_violation using message =
      'This week contains EP or TRUEP shifts whose site no longer permits that payroll category. Re-enable the site or reclassify the source draft before copying.';
  end if;

  select coalesce(
$marker$;
  insert_columns text := $marker$
      assignment_type,
      created_by
$marker$;
  replacement_insert_columns text := $marker$
      assignment_type,
      payroll_category,
      created_by
$marker$;
  insert_values text := $marker$
      source_shift.assignment_type,
      actor_id
$marker$;
  replacement_insert_values text := $marker$
      source_shift.assignment_type,
      source_shift.payroll_category,
      actor_id
$marker$;
  verification text := $marker$
      or copied_shift.assignment_type is distinct from source_shift.assignment_type
$marker$;
  replacement_verification text := $marker$
      or copied_shift.assignment_type is distinct from source_shift.assignment_type
      or copied_shift.payroll_category is distinct from source_shift.payroll_category
$marker$;
begin
  select pg_get_functiondef(
    'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)'::regprocedure
  ) into definition;

  if definition is null
    or position(source_schedule_guard in definition) = 0
    or position(insert_columns in definition) = 0
    or position(insert_values in definition) = 0
    or position(verification in definition) = 0
  then
    raise exception 'The reviewed schedule week-copy definition changed; payroll-category patch was not applied.';
  end if;

  definition := replace(definition, source_schedule_guard, replacement_schedule_guard);
  definition := replace(definition, insert_columns, replacement_insert_columns);
  definition := replace(definition, insert_values, replacement_insert_values);
  definition := replace(definition, verification, replacement_verification);
  execute definition;
end
$patch_week_copy_payroll_category$;

create function public.get_shift_payroll_category_map(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  selected_schedule_id uuid;
  can_view_all boolean;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  can_view_all := public.has_any_effective_permission(array[
    'schedule.view', 'scheduler.view', 'scheduler.manage',
    'schedule.manage', 'schedule.publish', 'schedule.delete_shift',
    'schedule.override_warnings'
  ]);

  select schedule.id into selected_schedule_id
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (schedule.status = 'published' or (schedule.status = 'draft' and can_view_all))
  order by
    case
      when can_view_all and schedule.status = 'draft' then 0
      when schedule.status = 'published' then 1
      else 2
    end,
    schedule.revision desc
  limit 1;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shiftId', shift.id,
      'payrollCategory', shift.payroll_category
    ) order by shift.starts_at, shift.id)
    from public.shifts shift
    where shift.schedule_id = selected_schedule_id
      and shift.canceled_at is null
      and (can_view_all or exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.employee_id = actor_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
          and assignment.canceled_at is null
      ))
  ), '[]'::jsonb);
end;
$$;

create function public.get_time_payroll_category_map(
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
  operational_time_zone text;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if target_from_date is null
    or target_through_date is null
    or target_through_date < target_from_date
  then
    raise check_violation using message = 'Choose a valid payroll-category date range.';
  end if;

  can_view_team := public.has_mfa()
    and (
      public.has_effective_permission('time.view')
      or public.has_effective_permission('time.manage')
      or public.has_effective_permission('time.export_payroll')
      or public.has_effective_permission('time.resolve_exceptions')
    );

  select rule.time_zone into operational_time_zone
  from private.payroll_rules rule
  where rule.id = true;

  return coalesce((
    with effective_events as materialized (
      select event.*
      from private.get_effective_time_event_payroll_categories() event
      where not event.voided
        and (can_view_team or event.employee_id = actor_id)
        and (event.assignment_anchor at time zone operational_time_zone)::date
          between target_from_date and target_through_date
    ), grouped as (
      select
        event.employee_id,
        event.occurrence_key,
        min(event.assignment_anchor) as assignment_anchor,
        (array_agg(event.shift_id order by event.effective_at, event.id))[1] as shift_id,
        min(event.payroll_category) as payroll_category,
        count(distinct event.payroll_category) > 1 as mixed_payroll_categories,
        jsonb_agg(to_jsonb(event.id) order by event.effective_at, event.id) as event_ids
      from effective_events event
      group by event.employee_id, event.occurrence_key
    )
    select jsonb_agg(jsonb_build_object(
      'employeeId', grouped.employee_id,
      'shiftId', grouped.shift_id,
      'operationalDate',
        (grouped.assignment_anchor at time zone operational_time_zone)::date,
      'payrollOccurrenceKey', grouped.occurrence_key,
      'eventIds', grouped.event_ids,
      'payrollCategory', grouped.payroll_category,
      'payrollCategoryLabel', case
        when grouped.mixed_payroll_categories then 'Conflicting categories'
        when grouped.payroll_category = 'ep' then 'EP'
        when grouped.payroll_category = 'truep' then 'TRUEP'
        else 'Regular'
      end,
      'mixedPayrollCategories', grouped.mixed_payroll_categories
    ) order by grouped.assignment_anchor, grouped.employee_id, grouped.occurrence_key)
    from grouped
  ), '[]'::jsonb);
end;
$$;

create function public.correct_time_event_payroll_category(
  target_time_event_id uuid,
  target_payroll_category text,
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
  target_state record;
  locked_occurrence_key text;
  first_clock_in timestamptz;
  current_category text;
  current_category_count integer := 0;
  clean_category text := lower(btrim(coalesce(target_payroll_category, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
  corrected_timestamp timestamptz := clock_timestamp();
  correction_count integer := 0;
  correction_ids uuid[] := '{}'::uuid[];
  correction_event_ids uuid[] := '{}'::uuid[];
begin
  if actor_id is null
    or not public.has_effective_permission('time.manage')
    or not public.has_mfa()
  then
    raise insufficient_privilege using message =
      'MFA-verified time management permission is required.';
  end if;

  if clean_category not in ('regular', 'ep', 'truep') then
    raise check_violation using message = 'Choose Regular, EP, or TRUEP.';
  end if;

  if char_length(clean_reason) < 8 then
    raise check_violation using message = 'Explain why the payroll category is being corrected.';
  end if;

  select event.* into target_state
  from private.get_effective_time_event_payroll_categories() event
  where event.id = target_time_event_id;

  if target_state.id is null then
    raise no_data_found using message = 'The selected time event could not be found.';
  end if;

  if target_state.voided then
    raise check_violation using message =
      'Voided punches cannot be used to reclassify a worked-time occurrence.';
  end if;

  locked_occurrence_key := target_state.occurrence_key;
  perform private.lock_payroll_category_occurrence(locked_occurrence_key);

  -- Re-resolve after waiting for the shared occurrence lock. A correction,
  -- void, Site/Post override, or occurrence repair may have changed ownership.
  select event.* into target_state
  from private.get_effective_time_event_payroll_categories() event
  where event.id = target_time_event_id;

  if target_state.id is null
    or target_state.voided
    or target_state.occurrence_key is distinct from locked_occurrence_key
  then
    raise check_violation using message =
      'This punch changed while its payroll category was being corrected. Refresh and try again.';
  end if;

  select min(event.effective_at) filter (where event.kind = 'clock_in')
  into first_clock_in
  from private.get_effective_time_event_payroll_categories(target_state.employee_id) event
  where not event.voided
    and event.occurrence_key = target_state.occurrence_key;

  if private.payroll_assignment_is_locked(
    target_state.occurrence_key,
    target_state.employee_id,
    target_state.shift_id,
    first_clock_in
  ) or exists (
    select 1
    from private.payroll_export_rows export_row
    cross join lateral jsonb_array_elements(
      coalesce(export_row.row_payload -> 'eventTimeline', '[]'::jsonb)
    ) timeline(event)
    join private.get_effective_time_event_payroll_categories(target_state.employee_id) occurrence
      on occurrence.id::text = timeline.event ->> 'id'
     and not occurrence.voided
     and occurrence.occurrence_key = target_state.occurrence_key
  ) then
    raise check_violation using message =
      'This worked-time occurrence is already in locked payroll and cannot be reclassified.';
  end if;

  select
    count(distinct event.payroll_category)::integer,
    min(event.payroll_category)
  into current_category_count, current_category
  from private.get_effective_time_event_payroll_categories(target_state.employee_id) event
  where not event.voided
    and event.occurrence_key = target_state.occurrence_key;

  if clean_category <> 'regular'
    and not (current_category_count = 1 and current_category = clean_category)
    and not exists (
      select 1
      from public.shifts shift
      where shift.id = target_state.shift_id
        and private.shift_location_supports_ep_truep_payroll(shift.post_id, shift.event_id)
    )
  then
    raise check_violation using message =
      'The linked site does not currently permit that payroll category.';
  end if;

  with occurrence_events as (
    select event.id
    from private.get_effective_time_event_payroll_categories(target_state.employee_id) event
    where not event.voided
      and event.occurrence_key = target_state.occurrence_key
  ), inserted as (
    insert into public.time_event_payroll_category_corrections (
      time_event_id, payroll_category, reason, corrected_by, corrected_at
    )
    select occurrence.id, clean_category, clean_reason, actor_id, corrected_timestamp
    from occurrence_events occurrence
    returning id, time_event_id
  )
  select count(*)::integer, array_agg(inserted.id), array_agg(inserted.time_event_id)
  into correction_count, correction_ids, correction_event_ids
  from inserted;

  if correction_count = 0 then
    raise no_data_found using message = 'No punches were found for this worked-time record.';
  end if;

  return jsonb_build_object(
    'correctionCount', correction_count,
    'correctionIds', correction_ids,
    'eventIds', correction_event_ids,
    'payrollOccurrenceKey', target_state.occurrence_key,
    'payrollCategory', clean_category,
    'reason', clean_reason,
    'correctedAt', corrected_timestamp,
    'correctedBy', actor_id
  );
end;
$$;

-- The category is injected before payroll review is digested or locked.
alter function public.get_timekeeping_review(date, date) set schema private;
alter function private.get_timekeeping_review(date, date)
  rename to get_timekeeping_review_pre_payroll_category;

create function public.get_timekeeping_review(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  category_map jsonb;
  enriched_rows jsonb;
  regular_category_minutes integer := 0;
  ep_minutes integer := 0;
  truep_minutes integer := 0;
  unclassified_category_minutes integer := 0;
  worked_time_paid_minutes integer := 0;
  mixed_category_count integer := 0;
  category_minutes_match_paid boolean := false;
begin
  payload := private.get_timekeeping_review_pre_payroll_category(
    target_from_date,
    target_through_date
  );
  category_map := public.get_time_payroll_category_map(
    target_from_date,
    target_through_date
  );

  select coalesce(jsonb_agg(
    row_item.value
    || jsonb_build_object(
      'payrollCategory', case
        when row_item.value ->> 'rowKind' <> 'time_event'
          then null
        when category_item.value is null and row_item.value ->> 'rowKind' = 'time_event'
          then null
        else coalesce(category_item.value ->> 'payrollCategory', 'regular')
      end,
      'payrollOccurrenceKey', coalesce(
        category_item.value ->> 'payrollOccurrenceKey',
        row_item.value ->> 'payrollOccurrenceKey'
      ),
      'payrollCategoryLabel', case
        when row_item.value ->> 'rowKind' <> 'time_event'
          then 'Not applicable'
        when category_item.value is null and row_item.value ->> 'rowKind' = 'time_event'
          then 'Unclassified'
        else coalesce(category_item.value ->> 'payrollCategoryLabel', 'Regular')
      end,
      'payrollCategoryResolved',
        category_item.value is not null or row_item.value ->> 'rowKind' <> 'time_event',
      'mixedPayrollCategories', coalesce(
        (category_item.value ->> 'mixedPayrollCategories')::boolean,
        false
      ),
      'regularCategoryMinutes', case
        when row_item.value ->> 'rowKind' <> 'time_event' then 0
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false) then 0
        when category_item.value is null and row_item.value ->> 'rowKind' = 'time_event' then 0
        when coalesce(category_item.value ->> 'payrollCategory', 'regular') = 'regular'
          then coalesce((row_item.value ->> 'paidMinutes')::integer, 0)
        else 0
      end,
      'epMinutes', case
        when row_item.value ->> 'rowKind' <> 'time_event' then 0
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false) then 0
        when category_item.value ->> 'payrollCategory' = 'ep'
          then coalesce((row_item.value ->> 'paidMinutes')::integer, 0)
        else 0
      end,
      'truepMinutes', case
        when row_item.value ->> 'rowKind' <> 'time_event' then 0
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false) then 0
        when category_item.value ->> 'payrollCategory' = 'truep'
          then coalesce((row_item.value ->> 'paidMinutes')::integer, 0)
        else 0
      end,
      'unclassifiedCategoryMinutes', case
        when row_item.value ->> 'rowKind' <> 'time_event' then 0
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false)
          or (category_item.value is null and row_item.value ->> 'rowKind' = 'time_event')
          then coalesce((row_item.value ->> 'paidMinutes')::integer, 0)
        else 0
      end,
      'payrollReady', case
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false)
          or (category_item.value is null and row_item.value ->> 'rowKind' = 'time_event')
          then false
        else coalesce((row_item.value ->> 'payrollReady')::boolean, false)
      end,
      'reviewStatus', case
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false)
          or (category_item.value is null and row_item.value ->> 'rowKind' = 'time_event')
          then 'unresolved'
        else coalesce(row_item.value ->> 'reviewStatus', 'ready')
      end,
      'payrollNotes', case
        when coalesce((category_item.value ->> 'mixedPayrollCategories')::boolean, false)
          then coalesce(row_item.value -> 'payrollNotes', '[]'::jsonb)
            || jsonb_build_array(
              'Payroll category is inconsistent within this worked-time occurrence. Correct it before payroll is locked.'
            )
        when category_item.value is null and row_item.value ->> 'rowKind' = 'time_event'
          then coalesce(row_item.value -> 'payrollNotes', '[]'::jsonb)
            || jsonb_build_array(
              'Payroll category could not be resolved from the effective worked-time occurrence. Refresh or correct the occurrence before payroll is locked.'
            )
        else coalesce(row_item.value -> 'payrollNotes', '[]'::jsonb)
      end
    )
    order by row_item.ordinality
  ), '[]'::jsonb)
  into enriched_rows
  from jsonb_array_elements(coalesce(payload -> 'rows', '[]'::jsonb))
    with ordinality as row_item(value, ordinality)
  left join lateral (
    select map_item.value
    from jsonb_array_elements(category_map) map_item(value)
    where map_item.value ->> 'employeeId' = row_item.value ->> 'employeeId'
      and (
        (
          nullif(row_item.value ->> 'payrollOccurrenceKey', '') is not null
          and map_item.value ->> 'payrollOccurrenceKey'
            = row_item.value ->> 'payrollOccurrenceKey'
        )
        or exists (
          select 1
          from jsonb_array_elements(coalesce(row_item.value -> 'eventTimeline', '[]'::jsonb)) timeline(event)
          where coalesce(map_item.value -> 'eventIds', '[]'::jsonb)
            @> jsonb_build_array(timeline.event ->> 'id')
        )
      )
    order by
      case
        when map_item.value ->> 'payrollOccurrenceKey'
          = row_item.value ->> 'payrollOccurrenceKey' then 0
        else 1
      end
    limit 1
  ) category_item on true;

  select
    coalesce(sum((row_item.value ->> 'regularCategoryMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'epMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'truepMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'unclassifiedCategoryMinutes')::integer), 0)::integer,
    coalesce(sum((row_item.value ->> 'paidMinutes')::integer) filter (
      where row_item.value ->> 'rowKind' = 'time_event'
    ), 0)::integer,
    count(*) filter (
      where coalesce((row_item.value ->> 'mixedPayrollCategories')::boolean, false)
    )::integer
  into regular_category_minutes, ep_minutes, truep_minutes,
    unclassified_category_minutes, worked_time_paid_minutes,
    mixed_category_count
  from jsonb_array_elements(enriched_rows) row_item(value);

  category_minutes_match_paid :=
    regular_category_minutes + ep_minutes + truep_minutes
      + unclassified_category_minutes
    = worked_time_paid_minutes;

  return payload || jsonb_build_object(
    'rows', enriched_rows,
    'summary', coalesce(payload -> 'summary', '{}'::jsonb) || jsonb_build_object(
      'regularCategoryMinutes', regular_category_minutes,
      'epMinutes', ep_minutes,
      'truepMinutes', truep_minutes,
      'unclassifiedCategoryMinutes', unclassified_category_minutes
    ),
    'reconciliation', coalesce(payload -> 'reconciliation', '{}'::jsonb) || jsonb_build_object(
      'passed', coalesce((payload -> 'reconciliation' ->> 'passed')::boolean, false)
        and category_minutes_match_paid
        and mixed_category_count = 0
        and unclassified_category_minutes = 0,
      'regularCategoryMinutes', regular_category_minutes,
      'epMinutes', ep_minutes,
      'truepMinutes', truep_minutes,
      'unclassifiedCategoryMinutes', unclassified_category_minutes,
      'categoryMinutesMatchPaid', category_minutes_match_paid,
      'mixedPayrollCategoryCount', mixed_category_count
    )
  );
end;
$$;

create function private.validate_payroll_export_row_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  occurrence_key text;
  effective_category text;
  category_count integer := 0;
  payload_category text := lower(nullif(new.row_payload ->> 'payrollCategory', ''));
  category_minutes integer;
begin
  occurrence_key := nullif(new.row_payload ->> 'payrollOccurrenceKey', '');
  if occurrence_key is null then
    raise check_violation using message =
      'Payroll category could not be tied to an authoritative worked-time occurrence.';
  end if;

  perform private.lock_payroll_category_occurrence(occurrence_key);

  select
    count(distinct event.payroll_category)::integer,
    min(event.payroll_category)
  into category_count, effective_category
  from private.get_effective_time_event_payroll_categories(new.employee_id) event
  where not event.voided
    and event.occurrence_key = occurrence_key;

  if category_count = 0 then
    raise check_violation using message =
      'Payroll category could not be verified for this locked worked-time row.';
  end if;

  if category_count <> 1
    or coalesce((new.row_payload ->> 'mixedPayrollCategories')::boolean, false)
  then
    raise check_violation using message =
      'Payroll cannot be locked while a worked-time occurrence has mixed payroll categories.';
  end if;

  if payload_category is null or payload_category <> effective_category then
    raise check_violation using message =
      'Payroll category changed while payroll was being locked. Refresh and review again.';
  end if;

  category_minutes :=
    coalesce((new.row_payload ->> 'regularCategoryMinutes')::integer, 0)
    + coalesce((new.row_payload ->> 'epMinutes')::integer, 0)
    + coalesce((new.row_payload ->> 'truepMinutes')::integer, 0)
    + coalesce((new.row_payload ->> 'unclassifiedCategoryMinutes')::integer, 0);

  if category_minutes <> new.paid_minutes
    or coalesce((new.row_payload ->> 'unclassifiedCategoryMinutes')::integer, 0) <> 0
  then
    raise check_violation using message =
      'Payroll category minute totals do not reconcile to paid minutes.';
  end if;

  new.row_payload := new.row_payload || jsonb_build_object(
    'payrollCategory', effective_category,
    'payrollCategoryLabel', case effective_category
      when 'ep' then 'EP'
      when 'truep' then 'TRUEP'
      else 'Regular'
    end,
    'payrollCategoryResolved', true,
    'mixedPayrollCategories', false
  );

  return new;
end;
$$;

drop trigger if exists payroll_export_rows_payroll_category on private.payroll_export_rows;
create trigger payroll_export_rows_payroll_category
before insert on private.payroll_export_rows
for each row execute function private.validate_payroll_export_row_category();

-- Give mixed-category lock failures a category-specific message before the
-- mature export implementation applies its other readiness checks.
alter function public.create_payroll_export_batch(date, date, text) set schema private;
alter function private.create_payroll_export_batch(date, date, text)
  rename to create_payroll_export_batch_pre_payroll_category;

create function public.create_payroll_export_batch(
  target_from_date date,
  target_through_date date,
  target_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  review_payload jsonb;
  occurrence_key text;
begin
  review_payload := public.get_timekeeping_review(target_from_date, target_through_date);

  -- Acquire every occurrence lock in deterministic order, then rebuild the
  -- review while those locks remain held. Category corrections use the same
  -- key, so either the correction finishes first and is included or payroll
  -- locks first and the correction observes the locked export row.
  for occurrence_key in
    select distinct row_item.value ->> 'payrollOccurrenceKey'
    from jsonb_array_elements(coalesce(review_payload -> 'rows', '[]'::jsonb)) row_item(value)
    where row_item.value ->> 'rowKind' = 'time_event'
      and nullif(row_item.value ->> 'payrollOccurrenceKey', '') is not null
    order by row_item.value ->> 'payrollOccurrenceKey'
  loop
    perform private.lock_payroll_category_occurrence(occurrence_key);
  end loop;

  review_payload := public.get_timekeeping_review(target_from_date, target_through_date);

  if exists (
    select 1
    from jsonb_array_elements(coalesce(review_payload -> 'rows', '[]'::jsonb)) row_item(value)
    where row_item.value ->> 'rowKind' = 'time_event'
      and (
        coalesce((row_item.value ->> 'mixedPayrollCategories')::boolean, false)
        or not coalesce((row_item.value ->> 'payrollCategoryResolved')::boolean, false)
        or coalesce((row_item.value ->> 'unclassifiedCategoryMinutes')::integer, 0) > 0
      )
  ) then
    raise check_violation using message =
      'Payroll cannot be locked while a worked-time occurrence has mixed or unclassified payroll categories.';
  end if;

  return private.create_payroll_export_batch_pre_payroll_category(
    target_from_date,
    target_through_date,
    target_note
  );
end;
$$;

create function public.scheduler_create_typed_open_shift_with_payroll_category_v1(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  event_requires_armed boolean,
  shift_operational_date date,
  shift_start_time time without time zone,
  shift_end_time time without time zone,
  target_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_payroll_category text default 'regular'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := public.scheduler_create_typed_open_shift(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, event_time_zone, event_requires_armed, shift_operational_date,
    shift_start_time, shift_end_time, target_headcount, target_is_overtime,
    target_notes, target_work_type, publish_announcement, target_employee_id,
    target_availability_override_note, target_credential_override_note
  );

  perform private.set_shift_payroll_category(
    (result ->> 'shift_id')::uuid,
    target_payroll_category
  );

  return result;
end;
$$;

create function public.scheduler_create_coverage_plan_with_payroll_category_v1(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  shift_operational_date date,
  shift_start_time time without time zone,
  shift_end_time time without time zone,
  target_headcount integer,
  target_armed_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_assignment_requires_armed boolean default false,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift',
  target_dispatch_overlap_acknowledged boolean default false,
  target_payroll_category text default 'regular',
  use_employee_time_zone boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  shift_id uuid;
begin
  if use_employee_time_zone then
    result := public.scheduler_create_employee_local_coverage_plan_v3(
      target_week_starts_on, target_post_id, event_name, event_location_name,
      event_site_id, event_time_zone, shift_operational_date, shift_start_time,
      shift_end_time, target_headcount, target_armed_headcount,
      target_is_overtime, target_notes, target_work_type, publish_announcement,
      target_employee_id, target_assignment_requires_armed,
      target_availability_override_note, target_credential_override_note,
      target_overtime_override_note, target_dispatch_mode,
      target_dispatch_overlap_acknowledged
    );
  else
    result := public.scheduler_create_coverage_plan_v3(
      target_week_starts_on, target_post_id, event_name, event_location_name,
      event_site_id, event_time_zone, shift_operational_date, shift_start_time,
      shift_end_time, target_headcount, target_armed_headcount,
      target_is_overtime, target_notes, target_work_type, publish_announcement,
      target_employee_id, target_assignment_requires_armed,
      target_availability_override_note, target_credential_override_note,
      target_overtime_override_note, target_dispatch_mode,
      target_dispatch_overlap_acknowledged
    );
  end if;

  for shift_id in
    select value::uuid
    from jsonb_array_elements_text(coalesce(result -> 'shift_ids', '[]'::jsonb)) item(value)
  loop
    perform private.set_shift_payroll_category(shift_id, target_payroll_category);
  end loop;

  return result;
end;
$$;

create function public.scheduler_create_coverage_plan_batch_with_payroll_category_v1(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  shift_operational_dates date[],
  shift_start_time time without time zone,
  shift_end_time time without time zone,
  target_headcount integer,
  target_armed_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_assignment_requires_armed boolean default false,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift',
  target_dispatch_overlap_acknowledged boolean default false,
  use_employee_time_zone boolean default false,
  expected_time_zone text default null,
  target_payroll_category text default 'regular'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
  result_item jsonb;
  shift_id uuid;
begin
  result := public.scheduler_create_coverage_plan_batch_v1(
    target_week_starts_on, target_post_id, event_name, event_location_name,
    event_site_id, event_time_zone, shift_operational_dates, shift_start_time,
    shift_end_time, target_headcount, target_armed_headcount,
    target_is_overtime, target_notes, target_work_type, publish_announcement,
    target_employee_id, target_assignment_requires_armed,
    target_availability_override_note, target_credential_override_note,
    target_overtime_override_note, target_dispatch_mode,
    target_dispatch_overlap_acknowledged, use_employee_time_zone,
    expected_time_zone
  );

  for result_item in
    select value from jsonb_array_elements(coalesce(result -> 'results', '[]'::jsonb)) item(value)
  loop
    for shift_id in
      select value::uuid
      from jsonb_array_elements_text(
        coalesce(result_item -> 'shift_ids', '[]'::jsonb)
      ) shift_item(value)
    loop
      perform private.set_shift_payroll_category(shift_id, target_payroll_category);
    end loop;
  end loop;

  return result;
end;
$$;

create function public.scheduler_update_typed_draft_shift_with_payroll_category_v1(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time without time zone,
  shift_end_time time without time zone,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_work_type text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_mode text default 'primary_shift',
  target_payroll_category text default 'regular'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := public.scheduler_update_typed_draft_shift_v3(
    target_shift_id, shift_operational_date, shift_start_time, shift_end_time,
    target_headcount, target_is_open, target_is_overtime, target_notes,
    target_work_type, target_employee_id, target_availability_override_note,
    target_credential_override_note, target_overtime_override_note,
    target_dispatch_mode
  );

  perform private.set_shift_payroll_category(target_shift_id, target_payroll_category);
  return result;
end;
$$;

create function public.replace_schedule_week_draft_with_payroll_categories_v1(
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
begin
  -- The patched core performs the category copy and verifies it in the same
  -- transaction as the DST-safe schedule replacement.
  return public.replace_schedule_week_draft_with_work_types(
    source_schedule_id,
    destination_week_starts_on,
    include_assignments,
    include_events
  );
end;
$$;

revoke all on function private.shift_location_supports_ep_truep_payroll(uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.shift_payroll_category_preservation_allowed(
  uuid, uuid, uuid, timestamptz, timestamptz, text, uuid
) from public, anon, authenticated;
revoke all on function private.enforce_shift_payroll_category()
  from public, anon, authenticated;
revoke all on function private.set_shift_payroll_category(uuid, text)
  from public, anon, authenticated;
revoke all on function private.set_time_event_payroll_category()
  from public, anon, authenticated;
revoke all on function private.effective_time_event_shift_id(uuid)
  from public, anon, authenticated;
revoke all on function private.get_effective_time_event_payroll_categories(uuid)
  from public, anon, authenticated;
revoke all on function private.effective_time_event_payroll_category(uuid)
  from public, anon, authenticated;
revoke all on function private.lock_payroll_category_occurrence(text)
  from public, anon, authenticated;
revoke all on function private.copy_schedule_shift_block(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.get_timekeeping_review_pre_payroll_category(date, date)
  from public, anon, authenticated;
revoke all on function private.validate_payroll_export_row_category()
  from public, anon, authenticated;
revoke all on function private.create_payroll_export_batch_pre_payroll_category(date, date, text)
  from public, anon, authenticated;

revoke all on function public.get_sites_payload() from public, anon;
revoke all on function public.upsert_site(
  uuid, text, text, text, text, text, text, text, boolean, boolean
) from public, anon;
revoke all on function public.get_schedule_builder_options() from public, anon;
revoke all on function public.get_shift_payroll_category_map(date) from public, anon;
revoke all on function public.get_time_payroll_category_map(date, date) from public, anon;
revoke all on function public.correct_time_event_payroll_category(uuid, text, text)
  from public, anon;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;
revoke all on function public.create_payroll_export_batch(date, date, text)
  from public, anon;
revoke all on function public.scheduler_create_typed_open_shift_with_payroll_category_v1(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, text, boolean, uuid, text, text, text
) from public, anon;
revoke all on function public.scheduler_create_coverage_plan_with_payroll_category_v1(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text,
  boolean, text, boolean
) from public, anon;
revoke all on function public.scheduler_create_coverage_plan_batch_with_payroll_category_v1(
  date, uuid, text, text, uuid, text, date[], time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text,
  boolean, boolean, text, text
) from public, anon;
revoke all on function public.scheduler_update_typed_draft_shift_with_payroll_category_v1(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid,
  text, text, text, text, text
) from public, anon;
revoke all on function public.replace_schedule_week_draft_with_payroll_categories_v1(
  uuid, date, boolean, boolean
) from public, anon;

grant execute on function public.get_sites_payload() to authenticated;
grant execute on function public.upsert_site(
  uuid, text, text, text, text, text, text, text, boolean, boolean
) to authenticated;
grant execute on function public.get_schedule_builder_options() to authenticated;
grant execute on function public.get_shift_payroll_category_map(date) to authenticated;
grant execute on function public.get_time_payroll_category_map(date, date) to authenticated;
grant execute on function public.correct_time_event_payroll_category(uuid, text, text)
  to authenticated;
grant execute on function public.get_timekeeping_review(date, date) to authenticated;
grant execute on function public.create_payroll_export_batch(date, date, text)
  to authenticated;
grant execute on function public.scheduler_create_typed_open_shift_with_payroll_category_v1(
  date, uuid, text, text, uuid, text, boolean, date, time, time, integer,
  boolean, text, text, boolean, uuid, text, text, text
) to authenticated;
grant execute on function public.scheduler_create_coverage_plan_with_payroll_category_v1(
  date, uuid, text, text, uuid, text, date, time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text,
  boolean, text, boolean
) to authenticated;
grant execute on function public.scheduler_create_coverage_plan_batch_with_payroll_category_v1(
  date, uuid, text, text, uuid, text, date[], time, time, integer, integer,
  boolean, text, text, boolean, uuid, boolean, text, text, text, text,
  boolean, boolean, text, text
) to authenticated;
grant execute on function public.scheduler_update_typed_draft_shift_with_payroll_category_v1(
  uuid, date, time, time, integer, boolean, boolean, text, text, uuid,
  text, text, text, text, text
) to authenticated;
grant execute on function public.replace_schedule_week_draft_with_payroll_categories_v1(
  uuid, date, boolean, boolean
) to authenticated;

comment on column public.sites.supports_ep_truep_payroll is
  'Enables schedulers to classify this site''s shifts as EP or TRUEP. It does not define rates.';
comment on column public.shifts.payroll_category is
  'Scheduled payroll reporting category: regular, ep, or truep. It is independent of overtime.';
comment on column public.time_events.payroll_category is
  'Immutable punch-time snapshot of the linked shift payroll category; audited corrections are separate.';
comment on table public.time_event_payroll_category_corrections is
  'Append-only payroll-category corrections for unlocked worked-time occurrences.';
comment on function public.get_time_payroll_category_map(date, date) is
  'Returns effective Regular, EP, or TRUEP classification by worked-time occurrence.';
comment on function public.create_payroll_export_batch(date, date, text) is
  'Locks authoritative worked-time rows only after payroll category and overtime reconciliations pass.';

commit;

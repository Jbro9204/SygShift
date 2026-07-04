begin;

do $$
declare
  target_from_date constant date := date '2026-06-28';
  target_through_date constant date := date '2026-08-15';
  v_import_run_id uuid;
  actor_id uuid;
  batch_id uuid := gen_random_uuid();
  source_candidate_count integer := 0;
  site_count integer := 0;
  post_count integer := 0;
  schedule_count integer := 0;
  shift_count integer := 0;
  assignment_count integer := 0;
  assignment_record record;
begin
  select import_run.id into v_import_run_id
  from private.import_runs import_run
  order by import_run.created_at desc
  limit 1;

  if v_import_run_id is null then
    raise notice 'No Bible import run exists. Skipping operational schedule promotion.';
    return;
  end if;

  if exists (
    select 1
    from private.import_promotion_batches batch
    where batch.import_run_id = v_import_run_id
      and batch.note = 'Operational Bible schedule promotion from staged source labels.'
  ) then
    raise notice 'Operational Bible schedule promotion has already been applied. Skipping.';
    return;
  end if;

  if exists (
    select 1
    from public.schedules schedule
    where schedule.week_starts_on between target_from_date and target_through_date
  ) then
    raise exception 'Operational schedules already exist for the current Bible scope.';
  end if;

  select employee.id into actor_id
  from public.employees employee
  where employee.role = 'admin' and employee.status = 'active'
  order by employee.created_at
  limit 1;

  if actor_id is null then
    raise exception 'No active admin employee exists to own the Bible schedule promotion.';
  end if;

  create temporary table bible_scope_schedules on commit drop as
  select candidate.*
  from private.import_candidates candidate
  where candidate.import_run_id = v_import_run_id
    and candidate.kind = 'weekly_schedule'
    and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date;

  create temporary table bible_scope_shifts on commit drop as
  select candidate.*
  from private.import_candidates candidate
  where candidate.import_run_id = v_import_run_id
    and candidate.kind = 'shift'
    and (candidate.payload ->> 'localDate')::date between target_from_date and target_through_date;

  if not exists (select 1 from bible_scope_shifts) then
    raise notice 'No current/future Bible shifts exist. Skipping operational schedule promotion.';
    return;
  end if;

  create temporary table bible_source_sites on commit drop as
  select
    site_candidate.id as candidate_id,
    site_candidate.payload ->> 'siteKeyCandidate' as site_key,
    coalesce(site_candidate.payload -> 'labelVariants' ->> 0, site_candidate.candidate_key) as site_name,
    case
      when site_candidate.payload ->> 'qualificationCandidate' = 'armed' then true
      else false
    end as requires_armed,
    site_candidate.payload ->> 'qualificationCandidate' as qualification_candidate
  from private.import_candidates site_candidate
  where site_candidate.import_run_id = v_import_run_id
    and site_candidate.kind = 'site'
    and exists (
      select 1
      from bible_scope_shifts shift
      where shift.payload ->> 'siteKeyCandidate' = site_candidate.payload ->> 'siteKeyCandidate'
    );

  create temporary table bible_created_sites (
    site_key text primary key,
    site_id uuid not null,
    post_id uuid not null,
    requires_armed boolean not null,
    qualification_candidate text
  ) on commit drop;

  insert into public.sites (name, time_zone, active)
  select source_site.site_name, 'America/Denver', true
  from bible_source_sites source_site
  order by source_site.site_name;

  get diagnostics site_count = row_count;

  insert into public.posts (site_id, name, requires_armed, active)
  select
    site.id,
    case
      when source_site.qualification_candidate = 'armed' then 'Armed coverage'
      when source_site.qualification_candidate = 'unarmed' then 'Unarmed coverage'
      else 'Coverage - needs review'
    end,
    source_site.requires_armed,
    true
  from bible_source_sites source_site
  join public.sites site
    on site.name = source_site.site_name
   and site.created_at >= now() - interval '10 minutes'
  order by source_site.site_name;

  get diagnostics post_count = row_count;

  insert into bible_created_sites (site_key, site_id, post_id, requires_armed, qualification_candidate)
  select
    source_site.site_key,
    site.id,
    post.id,
    post.requires_armed,
    source_site.qualification_candidate
  from bible_source_sites source_site
  join public.sites site
    on site.name = source_site.site_name
   and site.created_at >= now() - interval '10 minutes'
  join public.posts post
    on post.site_id = site.id;

  insert into private.import_entity_links (
    import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
  )
  select v_import_run_id, batch_id, source_site.candidate_id, 'sites', created.site_id, 'bible-source-site'
  from bible_source_sites source_site
  join bible_created_sites created on created.site_key = source_site.site_key;

  insert into private.import_entity_links (
    import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
  )
  select v_import_run_id, batch_id, source_site.candidate_id, 'posts', created.post_id, 'bible-source-post'
  from bible_source_sites source_site
  join bible_created_sites created on created.site_key = source_site.site_key;

  create temporary table bible_created_schedules (
    week_starts_on date primary key,
    source_candidate_id uuid not null,
    schedule_id uuid not null
  ) on commit drop;

  insert into public.schedules (
    week_starts_on,
    status,
    created_by
  )
  select
    (schedule.payload ->> 'weekStartsOn')::date,
    'draft',
    actor_id
  from bible_scope_schedules schedule
  order by (schedule.payload ->> 'weekStartsOn')::date;

  get diagnostics schedule_count = row_count;

  insert into bible_created_schedules (week_starts_on, source_candidate_id, schedule_id)
  select
    (schedule.payload ->> 'weekStartsOn')::date,
    schedule.id,
    created.id
  from bible_scope_schedules schedule
  join public.schedules created
    on created.week_starts_on = (schedule.payload ->> 'weekStartsOn')::date;

  insert into private.import_entity_links (
    import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
  )
  select v_import_run_id, batch_id, source_candidate_id, 'schedules', schedule_id, 'bible-source-schedule'
  from bible_created_schedules;

  create temporary table bible_safe_assignees on commit drop as
  with source_labels as (
    select distinct
      private.normalize_import_label(shift.payload ->> 'assigneeLabel') as normalized_label,
      shift.payload ->> 'assigneeLabel' as source_label
    from bible_scope_shifts shift
    where btrim(coalesce(shift.payload ->> 'assigneeLabel', '')) <> ''
      and private.normalize_import_label(shift.payload ->> 'assigneeLabel') not in ('na', 'n/a', 'none', 'open')
  ), proposal_matches as (
    select
      source_labels.normalized_label,
      source_labels.source_label,
      employee.id as employee_id
    from source_labels
    join private.import_employee_alias_proposals proposal
      on proposal.import_run_id = v_import_run_id
     and proposal.normalized_label = source_labels.normalized_label
    join private.current_import_mappings mapping
      on mapping.import_run_id = v_import_run_id
     and mapping.mapping_type = 'employee'
     and mapping.mapping_key = proposal.employee_mapping_key
    join private.import_entity_links link
      on link.mapping_decision_id = mapping.id
     and link.entity_table = 'employees'
    join public.employees employee
      on employee.id = link.entity_id
     and employee.status = 'active'
  ), exact_matches as (
    select
      source_labels.normalized_label,
      source_labels.source_label,
      employee.id as employee_id
    from source_labels
    join public.employees employee
      on employee.status = 'active'
     and (
       private.normalize_import_label(concat_ws(' ', employee.first_name, employee.last_name)) = source_labels.normalized_label
       or private.normalize_import_label(concat_ws(' ', employee.preferred_name, employee.last_name)) = source_labels.normalized_label
     )
  ), combined as (
    select * from proposal_matches
    union
    select * from exact_matches
  )
  select
    normalized_label,
    min(source_label) as source_label,
    min(employee_id::text)::uuid as employee_id
  from combined
  group by normalized_label
  having count(distinct employee_id) = 1;

  create temporary table bible_created_shifts (
    source_candidate_id uuid primary key,
    shift_id uuid not null,
    employee_id uuid
  ) on commit drop;

  insert into public.shifts (
    schedule_id,
    post_id,
    starts_at,
    ends_at,
    headcount_required,
    is_open,
    is_overtime,
    notes,
    created_by
  )
  select
    schedule.schedule_id,
    site.post_id,
    ((shift.payload ->> 'localDate')::date + (shift.payload ->> 'startTime')::time) at time zone 'America/Denver',
    (
      (shift.payload ->> 'localDate')::date
      + case when coalesce((shift.payload ->> 'crossesMidnight')::boolean, false) then 1 else 0 end
      + (shift.payload ->> 'endTime')::time
    ) at time zone 'America/Denver',
    1,
    safe.employee_id is null,
    false,
    concat_ws(
      E'\n',
      'Bible source assignee: ' || coalesce(nullif(shift.payload ->> 'assigneeLabel', ''), 'Open / blank'),
      'Bible source context: ' || coalesce(nullif(shift.payload ->> 'contextLabel', ''), 'Unknown'),
      'Source sheet: ' || coalesce(shift.payload #>> '{sourceSchedule,sheetName}', 'Unknown'),
      'Source time cell: ' || coalesce(shift.payload #>> '{sourceTime,address}', shift.candidate_key),
      'Qualification source: ' || coalesce(nullif(shift.payload ->> 'qualificationCandidate', ''), 'unknown'),
      case when safe.employee_id is null then 'Assignment status: needs supervisor review before payroll reliance.' else 'Assignment status: matched from reviewed/exact source label.' end
    ),
    actor_id
  from bible_scope_shifts shift
  join bible_created_schedules schedule
    on schedule.week_starts_on = (shift.payload #>> '{sourceSchedule,weekStartsOn}')::date
  join bible_created_sites site
    on site.site_key = shift.payload ->> 'siteKeyCandidate'
  left join bible_safe_assignees safe
    on safe.normalized_label = private.normalize_import_label(shift.payload ->> 'assigneeLabel')
   and (
     not site.requires_armed
     or public.has_valid_credential(safe.employee_id, 'armed_guard', (shift.payload ->> 'localDate')::date)
   )
  order by
    (shift.payload ->> 'localDate')::date,
    shift.payload ->> 'startTime',
    shift.id;

  get diagnostics shift_count = row_count;

  insert into bible_created_shifts (source_candidate_id, shift_id, employee_id)
  select
    shift.id,
    created.id,
    safe.employee_id
  from bible_scope_shifts shift
  join bible_created_schedules schedule
    on schedule.week_starts_on = (shift.payload #>> '{sourceSchedule,weekStartsOn}')::date
  join bible_created_sites site
    on site.site_key = shift.payload ->> 'siteKeyCandidate'
  join public.shifts created
    on created.schedule_id = schedule.schedule_id
   and created.post_id = site.post_id
   and created.starts_at = (((shift.payload ->> 'localDate')::date + (shift.payload ->> 'startTime')::time) at time zone 'America/Denver')
   and created.ends_at = (
      (shift.payload ->> 'localDate')::date
      + case when coalesce((shift.payload ->> 'crossesMidnight')::boolean, false) then 1 else 0 end
      + (shift.payload ->> 'endTime')::time
    ) at time zone 'America/Denver'
   and created.notes like '%' || coalesce(shift.payload #>> '{sourceTime,address}', shift.candidate_key) || '%'
  left join bible_safe_assignees safe
    on safe.normalized_label = private.normalize_import_label(shift.payload ->> 'assigneeLabel')
   and (
     not site.requires_armed
     or public.has_valid_credential(safe.employee_id, 'armed_guard', (shift.payload ->> 'localDate')::date)
   );

  insert into private.import_entity_links (
    import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
  )
  select v_import_run_id, batch_id, source_candidate_id, 'shifts', shift_id, 'bible-source-shift'
  from bible_created_shifts;

  for assignment_record in
    select
      created.source_candidate_id,
      created.shift_id,
      created.employee_id
    from bible_created_shifts created
    where created.employee_id is not null
    order by created.shift_id
  loop
    begin
      insert into public.shift_assignments (shift_id, employee_id, assigned_by)
      values (assignment_record.shift_id, assignment_record.employee_id, actor_id);
      assignment_count := assignment_count + 1;
    exception
      when others then
        update public.shifts shift
        set
          is_open = true,
          notes = concat_ws(
            E'\n',
            shift.notes,
            'Assignment import skipped by system guardrail: ' || sqlerrm
          )
        where shift.id = assignment_record.shift_id;
    end;
  end loop;

  update public.shifts shift
  set is_open = false
  where exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = shift.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  );

  insert into private.import_entity_links (
    import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
  )
  select
    v_import_run_id,
    batch_id,
    created.source_candidate_id,
    'shift_assignments',
    assignment.id,
    'bible-source-assignment'
  from bible_created_shifts created
  join public.shift_assignments assignment
    on assignment.shift_id = created.shift_id
   and assignment.employee_id = created.employee_id;

  update public.schedules schedule
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id
  where exists (
    select 1
    from bible_created_schedules created
    where created.schedule_id = schedule.id
  );

  select count(*) into source_candidate_count
  from private.import_candidates candidate
  where candidate.import_run_id = v_import_run_id
    and (
      (candidate.kind = 'weekly_schedule' and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date)
      or (candidate.kind = 'shift' and (candidate.payload ->> 'localDate')::date between target_from_date and target_through_date)
    );

  insert into private.import_promotion_batches (
    id,
    import_run_id,
    from_date,
    through_date,
    published,
    employee_count,
    site_count,
    post_count,
    schedule_count,
    shift_count,
    assignment_count,
    excluded_shift_count,
    source_candidate_count,
    note,
    promoted_by
  ) values (
    batch_id,
    v_import_run_id,
    target_from_date,
    target_through_date,
    true,
    0,
    site_count,
    post_count,
    schedule_count,
    shift_count,
    assignment_count,
    0,
    source_candidate_count,
    'Operational Bible schedule promotion from staged source labels.',
    actor_id
  );

  raise notice 'Operational Bible schedule promoted: % sites, % posts, % schedules, % shifts, % assignments.',
    site_count, post_count, schedule_count, shift_count, assignment_count;
end
$$;

commit;

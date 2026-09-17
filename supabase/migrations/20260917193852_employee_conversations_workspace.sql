begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temporary table employee_conversations_release_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from private.employee_supervisor_assignments) as supervisor_assignment_count,
  (select count(*) from private.hr_corrective_actions) as corrective_action_count,
  (select count(*) from public.attendance_accountability_events) as accountability_event_count,
  (select count(*) from public.time_events) as time_event_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count;

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values
  (
    'hr.conversations.view',
    'Human Resources',
    'View employee conversations',
    'View factual conversation, coaching, training, recognition, reminder, and follow-up records for employees within the authorized supervisory scope.',
    'sensitive',
    true,
    false,
    true
  ),
  (
    'hr.conversations.manage',
    'Human Resources',
    'Record employee conversations',
    'Create factual employee conversation records and append follow-up or completion evidence within the authorized supervisory scope.',
    'sensitive',
    true,
    false,
    true
  ),
  (
    'hr.conversations.review',
    'Human Resources',
    'Review all employee conversations',
    'Review companywide employee conversation records and void an incorrect record with a permanent reason. This does not grant access to other confidential HR files.',
    'sensitive',
    true,
    false,
    true
  )
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = true,
    updated_at = clock_timestamp();

with approved_roles(role_code, can_review) as (
  values
    ('system_supervisor'::text, false),
    ('operations_manager'::text, true),
    ('human_resources'::text, true),
    ('human_resources_employee'::text, true),
    ('system_admin'::text, true)
), approved_permissions(permission_code, review_only) as (
  values
    ('hr.conversations.view'::text, false),
    ('hr.conversations.manage'::text, false),
    ('hr.conversations.review'::text, true)
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, permission.permission_code, true
from approved_roles approved
join public.access_roles role
  on role.code = approved.role_code
 and role.active
cross join approved_permissions permission
where not permission.review_only or approved.can_review
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

create table private.hr_employee_conversations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  conversation_type text not null,
  occurred_on date not null,
  subject text not null,
  factual_summary text not null,
  expectations text,
  employee_present boolean not null default true,
  follow_up_on date,
  status text not null default 'open',
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null references public.employees(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  completed_by uuid references public.employees(id) on delete restrict,
  completed_at timestamptz,
  voided_by uuid references public.employees(id) on delete restrict,
  voided_at timestamptz,
  void_reason text,
  constraint hr_employee_conversations_type_check check (
    conversation_type in (
      'employee_conversation',
      'coaching',
      'training',
      'policy_reminder',
      'performance_follow_up',
      'recognition',
      'other'
    )
  ),
  constraint hr_employee_conversations_subject_check check (char_length(btrim(subject)) between 3 and 180),
  constraint hr_employee_conversations_summary_check check (char_length(btrim(factual_summary)) between 8 and 10000),
  constraint hr_employee_conversations_expectations_check check (
    expectations is null or char_length(btrim(expectations)) between 3 and 6000
  ),
  constraint hr_employee_conversations_dates_check check (follow_up_on is null or follow_up_on >= occurred_on),
  constraint hr_employee_conversations_status_check check (status in ('open', 'completed', 'voided')),
  constraint hr_employee_conversations_completion_check check (
    (status <> 'completed' and completed_by is null and completed_at is null)
    or (status = 'completed' and completed_by is not null and completed_at is not null)
  ),
  constraint hr_employee_conversations_void_check check (
    (status <> 'voided' and voided_by is null and voided_at is null and void_reason is null)
    or (
      status = 'voided'
      and voided_by is not null
      and voided_at is not null
      and char_length(btrim(coalesce(void_reason, ''))) between 8 and 2000
    )
  )
);

create index hr_employee_conversations_employee_timeline_idx
  on private.hr_employee_conversations(employee_id, occurred_on desc, created_at desc, id desc);

create index hr_employee_conversations_open_follow_up_idx
  on private.hr_employee_conversations(follow_up_on, employee_id)
  where status = 'open' and follow_up_on is not null;

create index hr_employee_conversations_created_by_idx
  on private.hr_employee_conversations(created_by, created_at desc);

create table private.hr_employee_conversation_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references private.hr_employee_conversations(id) on delete restrict,
  event_type text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  note text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_employee_conversation_events_type_check check (
    event_type in ('created', 'follow_up', 'completed', 'reopened', 'voided')
  ),
  constraint hr_employee_conversation_events_note_check check (char_length(btrim(note)) between 3 and 10000),
  constraint hr_employee_conversation_events_details_check check (jsonb_typeof(details) = 'object')
);

create index hr_employee_conversation_events_timeline_idx
  on private.hr_employee_conversation_events(conversation_id, occurred_at, id);

alter table private.hr_employee_conversations enable row level security;
alter table private.hr_employee_conversations force row level security;
alter table private.hr_employee_conversation_events enable row level security;
alter table private.hr_employee_conversation_events force row level security;

revoke all on table private.hr_employee_conversations from public, anon, authenticated;
revoke all on table private.hr_employee_conversation_events from public, anon, authenticated;
grant select, insert, update on table private.hr_employee_conversations to service_role;
grant select, insert on table private.hr_employee_conversation_events to service_role;

create trigger hr_employee_conversation_events_append_only
before update or delete on private.hr_employee_conversation_events
for each row execute function private.prevent_append_only_change();

create function private.can_access_employee_conversation_scope(
  target_actor_id uuid,
  target_employee_id uuid,
  target_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    target_actor_id is not null
    and target_employee_id is not null
    and public.has_effective_permission(target_permission)
    and (
      public.has_effective_permission('hr.conversations.review')
      or exists (
        select 1
        from private.employee_supervisor_assignments assignment
        where assignment.supervisor_employee_id = target_actor_id
          and assignment.employee_id = target_employee_id
      )
    )
$$;

revoke all on function private.can_access_employee_conversation_scope(uuid, uuid, text) from public, anon, authenticated;

create function public.get_employee_conversations_workspace(
  target_employee_id uuid default null,
  target_type text default 'all',
  target_status text default 'active',
  target_page_size integer default 10,
  target_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  page_size integer := least(greatest(coalesce(target_page_size, 10), 5), 20);
  row_offset integer := greatest(coalesce(target_offset, 0), 0);
  can_review_all boolean := false;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'Identity verification is required to open employee conversations.';
  end if;

  if not public.has_effective_permission('hr.conversations.view') then
    raise insufficient_privilege using message = 'Employee Conversations access is required.';
  end if;

  if target_type not in ('all', 'employee_conversation', 'coaching', 'training', 'policy_reminder', 'performance_follow_up', 'recognition', 'other') then
    raise check_violation using message = 'Choose a valid conversation type.';
  end if;

  if target_status not in ('active', 'open', 'completed', 'voided', 'all') then
    raise check_violation using message = 'Choose a valid record status.';
  end if;

  can_review_all := public.has_effective_permission('hr.conversations.review');

  if target_employee_id is not null
    and not private.can_access_employee_conversation_scope(actor_id, target_employee_id, 'hr.conversations.view') then
    raise insufficient_privilege using message = 'This employee is outside your authorized supervisory scope.';
  end if;

  return jsonb_build_object(
    'viewerEmployeeId', actor_id,
    'canCreate', public.has_effective_permission('hr.conversations.manage'),
    'canReviewAll', can_review_all,
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
        'employeeNumber', employee.employee_number,
        'jobTitle', employee.job_title,
        'status', employee.status,
        'supervisorName', case
          when supervisor.id is null then null
          else concat_ws(' ', supervisor.first_name, nullif(supervisor.middle_name, ''), supervisor.last_name)
        end
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      left join private.employee_supervisor_assignments assignment on assignment.employee_id = employee.id
      left join public.employees supervisor on supervisor.id = assignment.supervisor_employee_id
      where (
        (can_review_all and employee.status in ('onboarding', 'active', 'leave', 'inactive', 'separated'))
        or (
          not can_review_all
          and assignment.supervisor_employee_id = actor_id
          and employee.status in ('onboarding', 'active', 'leave')
        )
      )
    ), '[]'::jsonb),
    'selectedEmployee', case when target_employee_id is null then null else (
      select jsonb_build_object(
        'id', employee.id,
        'name', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
        'employeeNumber', employee.employee_number,
        'jobTitle', employee.job_title,
        'status', employee.status,
        'supervisorName', case
          when supervisor.id is null then null
          else concat_ws(' ', supervisor.first_name, nullif(supervisor.middle_name, ''), supervisor.last_name)
        end
      )
      from public.employees employee
      left join private.employee_supervisor_assignments assignment on assignment.employee_id = employee.id
      left join public.employees supervisor on supervisor.id = assignment.supervisor_employee_id
      where employee.id = target_employee_id
    ) end,
    'summary', jsonb_build_object(
      'total', case when target_employee_id is null then 0 else (
        select count(*) from private.hr_employee_conversations conversation
        where conversation.employee_id = target_employee_id and conversation.status <> 'voided'
      ) end,
      'open', case when target_employee_id is null then 0 else (
        select count(*) from private.hr_employee_conversations conversation
        where conversation.employee_id = target_employee_id and conversation.status = 'open'
      ) end,
      'training', case when target_employee_id is null then 0 else (
        select count(*) from private.hr_employee_conversations conversation
        where conversation.employee_id = target_employee_id and conversation.conversation_type = 'training' and conversation.status <> 'voided'
      ) end,
      'followUpDue', case when target_employee_id is null then 0 else (
        select count(*) from private.hr_employee_conversations conversation
        where conversation.employee_id = target_employee_id
          and conversation.status = 'open'
          and conversation.follow_up_on is not null
          and conversation.follow_up_on <= (clock_timestamp() at time zone 'America/Denver')::date
      ) end
    ),
    'pageSize', page_size,
    'offset', row_offset,
    'total', case when target_employee_id is null then 0 else (
      select count(*)
      from private.hr_employee_conversations conversation
      where conversation.employee_id = target_employee_id
        and (target_type = 'all' or conversation.conversation_type = target_type)
        and (
          target_status = 'all'
          or (target_status = 'active' and conversation.status <> 'voided')
          or conversation.status = target_status
        )
    ) end,
    'items', case when target_employee_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(row_item.payload order by row_item.occurred_on desc, row_item.created_at desc, row_item.id desc)
      from (
        select
          conversation.id,
          conversation.occurred_on,
          conversation.created_at,
          jsonb_build_object(
            'id', conversation.id,
            'employeeId', conversation.employee_id,
            'conversationType', conversation.conversation_type,
            'occurredOn', conversation.occurred_on,
            'subject', conversation.subject,
            'factualSummary', conversation.factual_summary,
            'expectations', conversation.expectations,
            'employeePresent', conversation.employee_present,
            'followUpOn', conversation.follow_up_on,
            'status', conversation.status,
            'createdById', conversation.created_by,
            'createdByName', concat_ws(' ', creator.first_name, nullif(creator.middle_name, ''), creator.last_name),
            'createdAt', conversation.created_at,
            'updatedAt', conversation.updated_at,
            'canManage', private.can_access_employee_conversation_scope(actor_id, conversation.employee_id, 'hr.conversations.manage') and conversation.status <> 'voided',
            'canVoid', can_review_all and conversation.status <> 'voided',
            'events', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', event.id,
                'eventType', event.event_type,
                'actorName', concat_ws(' ', event_actor.first_name, nullif(event_actor.middle_name, ''), event_actor.last_name),
                'note', event.note,
                'details', event.details,
                'occurredAt', event.occurred_at
              ) order by event.occurred_at, event.id)
              from private.hr_employee_conversation_events event
              join public.employees event_actor on event_actor.id = event.actor_id
              where event.conversation_id = conversation.id
            ), '[]'::jsonb)
          ) as payload
        from private.hr_employee_conversations conversation
        join public.employees creator on creator.id = conversation.created_by
        where conversation.employee_id = target_employee_id
          and (target_type = 'all' or conversation.conversation_type = target_type)
          and (
            target_status = 'all'
            or (target_status = 'active' and conversation.status <> 'voided')
            or conversation.status = target_status
          )
        order by conversation.occurred_on desc, conversation.created_at desc, conversation.id desc
        limit page_size offset row_offset
      ) row_item
    ), '[]'::jsonb) end
  );
end
$$;

create function public.create_employee_conversation(
  target_employee_id uuid,
  target_conversation_type text,
  target_occurred_on date,
  target_subject text,
  target_factual_summary text,
  target_expectations text default null,
  target_employee_present boolean default true,
  target_follow_up_on date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  created_id uuid;
  clean_subject text := btrim(coalesce(target_subject, ''));
  clean_summary text := btrim(coalesce(target_factual_summary, ''));
  clean_expectations text := nullif(btrim(coalesce(target_expectations, '')), '');
  created_at_value timestamptz := clock_timestamp();
begin
  if actor_id is null or not public.has_mfa() then
    raise insufficient_privilege using message = 'Identity verification is required to record an employee conversation.';
  end if;

  if not private.can_access_employee_conversation_scope(actor_id, target_employee_id, 'hr.conversations.manage') then
    raise insufficient_privilege using message = 'You can record conversations only for employees within your authorized supervisory scope.';
  end if;

  if not exists (
    select 1 from public.employees employee
    where employee.id = target_employee_id
      and employee.status in ('onboarding', 'active', 'leave')
  ) then
    raise check_violation using message = 'Choose an active, onboarding, or leave employee.';
  end if;

  if target_conversation_type not in ('employee_conversation', 'coaching', 'training', 'policy_reminder', 'performance_follow_up', 'recognition', 'other') then
    raise check_violation using message = 'Choose a valid conversation type.';
  end if;

  if target_occurred_on is null or target_occurred_on > (clock_timestamp() at time zone 'America/Denver')::date then
    raise check_violation using message = 'Conversation date cannot be in the future.';
  end if;

  if char_length(clean_subject) < 3 or char_length(clean_subject) > 180 then
    raise check_violation using message = 'Enter a subject between 3 and 180 characters.';
  end if;

  if char_length(clean_summary) < 8 or char_length(clean_summary) > 10000 then
    raise check_violation using message = 'Enter a factual summary between 8 and 10,000 characters.';
  end if;

  if clean_expectations is not null and (char_length(clean_expectations) < 3 or char_length(clean_expectations) > 6000) then
    raise check_violation using message = 'Next steps must be between 3 and 6,000 characters when provided.';
  end if;

  if target_follow_up_on is not null and target_follow_up_on < target_occurred_on then
    raise check_violation using message = 'Follow-up date cannot be before the conversation date.';
  end if;

  insert into private.hr_employee_conversations (
    employee_id,
    conversation_type,
    occurred_on,
    subject,
    factual_summary,
    expectations,
    employee_present,
    follow_up_on,
    status,
    created_by,
    created_at,
    updated_by,
    updated_at,
    completed_by,
    completed_at
  ) values (
    target_employee_id,
    target_conversation_type,
    target_occurred_on,
    clean_subject,
    clean_summary,
    clean_expectations,
    coalesce(target_employee_present, true),
    target_follow_up_on,
    case when target_follow_up_on is null then 'completed' else 'open' end,
    actor_id,
    created_at_value,
    actor_id,
    created_at_value,
    case when target_follow_up_on is null then actor_id else null end,
    case when target_follow_up_on is null then created_at_value else null end
  ) returning id into created_id;

  insert into private.hr_employee_conversation_events (
    conversation_id,
    event_type,
    actor_id,
    note,
    details,
    occurred_at
  ) values (
    created_id,
    'created',
    actor_id,
    'Employee conversation record created after final review.',
    jsonb_build_object(
      'conversationType', target_conversation_type,
      'occurredOn', target_occurred_on,
      'employeePresent', coalesce(target_employee_present, true),
      'followUpOn', target_follow_up_on,
      'internalOnly', true,
      'disciplineCreated', false,
      'attendancePointsCreated', false
    ),
    created_at_value
  );

  if target_follow_up_on is null then
    insert into private.hr_employee_conversation_events (
      conversation_id,
      event_type,
      actor_id,
      note,
      details,
      occurred_at
    ) values (
      created_id,
      'completed',
      actor_id,
      'Saved complete because no further follow-up was scheduled.',
      jsonb_build_object('automaticCompletion', true),
      created_at_value
    );
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'private',
    'hr_employee_conversations',
    'CREATE_EMPLOYEE_CONVERSATION',
    created_id::text,
    jsonb_build_object(
      'employeeId', target_employee_id,
      'conversationType', target_conversation_type,
      'occurredOn', target_occurred_on,
      'followUpOn', target_follow_up_on
    )
  );

  return created_id;
end
$$;

create function public.record_employee_conversation_action(
  target_conversation_id uuid,
  target_action text,
  target_note text,
  target_follow_up_on date default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  record private.hr_employee_conversations%rowtype;
  clean_note text := btrim(coalesce(target_note, ''));
  action_at timestamptz := clock_timestamp();
  event_type_value text;
begin
  if actor_id is null or not public.has_mfa() then
    raise insufficient_privilege using message = 'Identity verification is required to update an employee conversation.';
  end if;

  select conversation.* into record
  from private.hr_employee_conversations conversation
  where conversation.id = target_conversation_id
  for update;

  if record.id is null then
    raise no_data_found using message = 'Employee conversation record not found.';
  end if;

  if target_action = 'void' then
    if not public.has_effective_permission('hr.conversations.review') then
      raise insufficient_privilege using message = 'HR review access is required to void this record.';
    end if;
  elsif not private.can_access_employee_conversation_scope(actor_id, record.employee_id, 'hr.conversations.manage') then
    raise insufficient_privilege using message = 'This employee is outside your authorized supervisory scope.';
  end if;

  if target_action = 'void' and (char_length(clean_note) < 8 or char_length(clean_note) > 2000) then
    raise check_violation using message = 'Enter a void reason between 8 and 2,000 characters.';
  elsif target_action <> 'void' and (char_length(clean_note) < 3 or char_length(clean_note) > 10000) then
    raise check_violation using message = 'Enter a clear note between 3 and 10,000 characters.';
  end if;

  if target_action not in ('follow_up', 'complete', 'reopen', 'void') then
    raise check_violation using message = 'Choose a valid conversation action.';
  end if;

  if record.status = 'voided' then
    raise check_violation using message = 'A voided record cannot be changed.';
  end if;

  if target_follow_up_on is not null and target_follow_up_on < record.occurred_on then
    raise check_violation using message = 'Follow-up date cannot be before the original conversation date.';
  end if;

  if target_action = 'follow_up' then
    if record.status <> 'open' then
      raise check_violation using message = 'Reopen this record before adding another follow-up.';
    end if;
    update private.hr_employee_conversations
    set follow_up_on = target_follow_up_on,
        updated_by = actor_id,
        updated_at = action_at
    where id = record.id;
    event_type_value := 'follow_up';
  elsif target_action = 'complete' then
    if record.status <> 'open' then
      raise check_violation using message = 'Only an open record can be completed.';
    end if;
    update private.hr_employee_conversations
    set status = 'completed',
        follow_up_on = null,
        completed_by = actor_id,
        completed_at = action_at,
        updated_by = actor_id,
        updated_at = action_at
    where id = record.id;
    event_type_value := 'completed';
  elsif target_action = 'reopen' then
    if record.status <> 'completed' then
      raise check_violation using message = 'Only a completed record can be reopened.';
    end if;
    update private.hr_employee_conversations
    set status = 'open',
        follow_up_on = target_follow_up_on,
        completed_by = null,
        completed_at = null,
        updated_by = actor_id,
        updated_at = action_at
    where id = record.id;
    event_type_value := 'reopened';
  else
    update private.hr_employee_conversations
    set status = 'voided',
        follow_up_on = null,
        completed_by = null,
        completed_at = null,
        voided_by = actor_id,
        voided_at = action_at,
        void_reason = clean_note,
        updated_by = actor_id,
        updated_at = action_at
    where id = record.id;
    event_type_value := 'voided';
  end if;

  insert into private.hr_employee_conversation_events (
    conversation_id,
    event_type,
    actor_id,
    note,
    details,
    occurred_at
  ) values (
    record.id,
    event_type_value,
    actor_id,
    clean_note,
    jsonb_build_object('followUpOn', target_follow_up_on),
    action_at
  );

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'private',
    'hr_employee_conversations',
    'EMPLOYEE_CONVERSATION_' || upper(event_type_value),
    record.id::text,
    jsonb_build_object('status', record.status, 'followUpOn', record.follow_up_on),
    jsonb_build_object('action', event_type_value, 'followUpOn', target_follow_up_on)
  );

  return true;
end
$$;

revoke all on function public.get_employee_conversations_workspace(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.create_employee_conversation(uuid, text, date, text, text, text, boolean, date) from public, anon, authenticated;
revoke all on function public.record_employee_conversation_action(uuid, text, text, date) from public, anon, authenticated;

grant execute on function public.get_employee_conversations_workspace(uuid, text, text, integer, integer) to authenticated;
grant execute on function public.create_employee_conversation(uuid, text, date, text, text, text, boolean, date) to authenticated;
grant execute on function public.record_employee_conversation_action(uuid, text, text, date) to authenticated;

comment on table private.hr_employee_conversations is
  'Purpose-built, internal supervisor and HR employee conversation records. These records do not create discipline, attendance points, payroll changes, or employee-facing acknowledgments.';
comment on table private.hr_employee_conversation_events is
  'Append-only history for employee conversation creation, follow-up, completion, reopening, and reasoned voiding.';
comment on function public.get_employee_conversations_workspace(uuid, text, text, integer, integer) is
  'Returns only the employee identities and conversation records within the current viewer''s purpose-built supervisory or HR scope.';

do $$
declare
  baseline employee_conversations_release_baseline%rowtype;
begin
  select * into strict baseline from employee_conversations_release_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.supervisor_assignment_count <> (select count(*) from private.employee_supervisor_assignments)
    or baseline.corrective_action_count <> (select count(*) from private.hr_corrective_actions)
    or baseline.accountability_event_count <> (select count(*) from public.attendance_accountability_events)
    or baseline.time_event_count <> (select count(*) from public.time_events)
    or baseline.permission_override_count <> (select count(*) from public.employee_permission_overrides)
  then
    raise exception 'Employee Conversations installation changed protected employee, supervision, corrective-action, accountability, timekeeping, or individual-access data.';
  end if;

  if exists (select 1 from private.hr_employee_conversations)
    or exists (select 1 from private.hr_employee_conversation_events)
  then
    raise exception 'Employee Conversations installation must not create business records.';
  end if;

  if exists (
    select required.code
    from unnest(array['hr.conversations.view', 'hr.conversations.manage', 'hr.conversations.review']::text[]) required(code)
    left join public.permission_catalog catalog on catalog.code = required.code and catalog.active
    where catalog.code is null
  ) then
    raise exception 'Employee Conversations permission catalog is incomplete.';
  end if;

  if exists (
    select required.role_code, required.permission_code
    from (
      values
        ('system_supervisor'::text, 'hr.conversations.view'::text),
        ('system_supervisor', 'hr.conversations.manage'),
        ('operations_manager', 'hr.conversations.view'),
        ('operations_manager', 'hr.conversations.manage'),
        ('operations_manager', 'hr.conversations.review'),
        ('human_resources', 'hr.conversations.view'),
        ('human_resources', 'hr.conversations.manage'),
        ('human_resources', 'hr.conversations.review'),
        ('human_resources_employee', 'hr.conversations.view'),
        ('human_resources_employee', 'hr.conversations.manage'),
        ('human_resources_employee', 'hr.conversations.review'),
        ('system_admin', 'hr.conversations.view'),
        ('system_admin', 'hr.conversations.manage'),
        ('system_admin', 'hr.conversations.review')
    ) required(role_code, permission_code)
    left join public.access_roles role on role.code = required.role_code and role.active
    left join public.access_role_permissions permission
      on permission.role_id = role.id
     and permission.permission_code = required.permission_code
     and permission.enabled
    where permission.permission_code is null
  ) then
    raise exception 'Employee Conversations approved role permissions are incomplete.';
  end if;
end
$$;

commit;

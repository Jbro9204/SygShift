begin;
set local lock_timeout = '5s';

create table private.sygilant_technology_ticket_action_receipts (
  actor_id uuid not null references public.employees(id) on delete restrict,
  request_id uuid not null,
  ticket_id uuid not null references public.support_tickets(id) on delete restrict,
  request_hash bytea not null check (octet_length(request_hash) = 32),
  operation text not null check (operation in ('reply', 'note', 'update', 'transfer')),
  message_id bigint references public.support_ticket_messages(id) on delete restrict,
  source_category text,
  destination_category text,
  destination_view text,
  assignment_cleared boolean,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_id, request_id),
  check ((operation in ('reply', 'note')) = (message_id is not null)),
  check ((operation = 'transfer' and num_nonnulls(source_category, destination_category, destination_view, assignment_cleared) = 4)
    or (operation <> 'transfer' and num_nonnulls(source_category, destination_category, destination_view, assignment_cleared) = 0))
);
alter table private.sygilant_technology_ticket_action_receipts enable row level security;
alter table private.sygilant_technology_ticket_action_receipts force row level security;
revoke all on table private.sygilant_technology_ticket_action_receipts from public, anon, authenticated, service_role;
comment on table private.sygilant_technology_ticket_action_receipts is
  'One transactionally retained receipt per authenticated actor and request; stores a digest, not duplicate message content.';

create function private.sygilant_technology_ticket_staff_allowed_v1(target_view text, actor_grants text[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(actor_grants @> array['apps.sygilant.access','apps.sygshift.access','support.tickets.view']::text[]
    and actor_grants && case target_view
    when 'it' then array['sygcurit.workspace.view']
    when 'cybersecurity' then array['sygcurit.workspace.view']
    when 'finance' then array['time.export_payroll']
    when 'scheduling' then array['schedule.manage']
    when 'timekeeping' then array['time.manage']
    when 'operations' then array['sites.manage','hr.assets.manage','hr.safety.manage','clients.manage']
    when 'hr' then array['hr.people.manage','hr.leave.manage','hr.learning.manage']
    when 'admin' then array['admin.users.view','admin.users.manage','admin.roles.view','admin.roles.manage',
      'security.access.emergency_revoke','security.access.restore']
    else '{}'::text[]
    end, false)
$$;
revoke all on function private.sygilant_technology_ticket_staff_allowed_v1(text,text[])
  from public, anon, authenticated, service_role;

create function private.sygilant_technology_ticket_categories_v1(target_view text)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  actor_grants text[] := coalesce(public.get_effective_permissions(), '{}'::text[]);
begin
  if target_view is null or target_view not in ('it', 'cybersecurity', 'finance', 'hr', 'scheduling', 'timekeeping', 'operations', 'admin', 'mine') then
    raise invalid_parameter_value using message = 'invalid_ticket_query';
  end if;

  if private.current_employee_id() is null
    or not (actor_grants @> array['apps.sygilant.access','apps.sygshift.access']::text[]) then
    raise insufficient_privilege using message = 'ticket_workspace_unavailable';
  end if;

  if target_view <> 'mine' and (
    public.has_mfa() is not true or not private.sygilant_technology_ticket_staff_allowed_v1(target_view,actor_grants)
  ) then
    raise insufficient_privilege using message = 'ticket_workspace_unavailable';
  end if;

  return case target_view
    when 'it' then array['technical']::text[]
    when 'cybersecurity' then array['account_access']::text[]
    when 'finance' then array['payroll']::text[]
    when 'scheduling' then array['schedule']::text[]
    when 'timekeeping' then array['timekeeping']::text[]
    when 'operations' then array['site_post','equipment','safety','client_request']::text[]
    when 'hr' then array['human_resources','benefits_leave','training_compliance']::text[]
    when 'admin' then array['technical','account_access','other']::text[]
    else array['schedule','timekeeping','payroll','human_resources','benefits_leave','training_compliance',
      'site_post','equipment','safety','account_access','technical','client_request','other']::text[]
  end;
end
$$;
revoke all on function private.sygilant_technology_ticket_categories_v1(text) from public, anon, authenticated, service_role;

create function private.sygilant_technology_ticket_matches_view_v1(
  ticket public.support_tickets, target_view text, categories text[], actor_id uuid, actor_grants text[]
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(case
    when target_view = 'mine' then ticket.submitted_by = actor_id and ticket.category = any(categories)
    when target_view = 'hr' then
      (ticket.confidential or ticket.category = any(categories))
      and ticket.route_permission = private.support_route_permission(ticket.category,ticket.confidential)
      and ticket.route_permission = any(actor_grants)
    else not ticket.confidential and ticket.category = any(categories)
      and ticket.route_permission = private.support_route_permission(ticket.category,false)
      and (target_view in ('it','cybersecurity','admin') or ticket.route_permission = any(actor_grants))
  end, false)
$$;
revoke all on function private.sygilant_technology_ticket_matches_view_v1(public.support_tickets,text,text[],uuid,text[])
  from public, anon, authenticated, service_role;

create function private.sygilant_technology_ticket_destination_v1(target_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case target_category
    when 'technical' then 'it'
    when 'account_access' then 'cybersecurity'
    when 'payroll' then 'finance'
    when 'schedule' then 'scheduling'
    when 'timekeeping' then 'timekeeping'
    when 'site_post' then 'operations'
    when 'equipment' then 'operations'
    when 'safety' then 'operations'
    when 'client_request' then 'operations'
    when 'other' then 'admin'
    else null end
$$;
revoke all on function private.sygilant_technology_ticket_destination_v1(text) from public, anon, authenticated, service_role;

create function private.sygilant_technology_ticket_handler_v1(target_employee_id uuid, target_permission text, target_view text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    private.support_employee_can_handle(target_employee_id,target_permission)
    and grant_list.permissions @> array[target_permission,'support.tickets.manage']::text[]
    and private.sygilant_technology_ticket_staff_allowed_v1(target_view,grant_list.permissions), false)
  from (select private.employee_effective_permissions(target_employee_id) as permissions) grant_list
$$;
revoke all on function private.sygilant_technology_ticket_handler_v1(uuid,text,text)
  from public, anon, authenticated, service_role;

create function private.sygilant_technology_ticket_can_transfer_v1(ticket public.support_tickets)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not ticket.confidential
    and ticket.status not in ('resolved','closed')
    and private.sygilant_technology_ticket_destination_v1(ticket.category) is not null
    and not exists (
      select 1 from public.support_ticket_messages message
      where message.ticket_id = ticket.id and message.visibility = 'internal'
    )
    and not exists (
      select 1 from public.support_ticket_events event
      where event.ticket_id = ticket.id
        and (event.event_type = 'internal_note_added' or event.detail -> 'confidential' = 'true'::jsonb)
    )
$$;
revoke all on function private.sygilant_technology_ticket_can_transfer_v1(public.support_tickets)
  from public, anon, authenticated, service_role;

create function public.get_sygilant_technology_ticket_workspace_v1(target_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_grants text[] := coalesce(public.get_effective_permissions(), '{}'::text[]);
  view_name text := target_input ->> 'view';
  view_categories text[];
  view_routes text[];
  clean_page integer;
  clean_size integer;
  clean_status text := coalesce(target_input ->> 'status', 'open');
  clean_search text := lower(btrim(coalesce(target_input ->> 'search', '')));
  clean_order text := coalesce(target_input ->> 'order', 'source');
begin
  if jsonb_typeof(target_input) is distinct from 'object'
    or target_input - array['view', 'page', 'pageSize', 'status', 'search', 'order']::text[] <> '{}'::jsonb
    or coalesce(target_input ->> 'page', '1') !~ '^[1-9][0-9]{0,5}$'
    or coalesce(target_input ->> 'pageSize', '10') not in ('5', '10', '20')
    or clean_status not in ('open', 'all', 'resolved', 'closed', 'new', 'assigned', 'in_progress', 'waiting_on_employee', 'reopened')
    or clean_order not in ('source', 'priority', 'oldest')
    or (target_input ? 'search' and jsonb_typeof(target_input -> 'search') is distinct from 'string')
    or length(clean_search) > 120 then
    raise invalid_parameter_value using message = 'invalid_ticket_query';
  end if;

  view_categories := private.sygilant_technology_ticket_categories_v1(view_name);
  if view_name <> 'mine' then
    select array_agg(distinct private.support_route_permission(category,false)) into view_routes
    from unnest(view_categories) as requested(category);
  end if;
  clean_page := least(coalesce((target_input ->> 'page')::integer, 1), 100000);
  clean_size := coalesce((target_input ->> 'pageSize')::integer, 10);
  if clean_status = 'closed' then clean_status := 'resolved'; end if;

  return (
    with scoped as materialized (
      select
        ticket.id, ticket.ticket_number, ticket.subject, ticket.category, ticket.subcategory,
        case when ticket.status = 'closed' then 'resolved' else ticket.status end as status,
        ticket.priority, ticket.confidential, ticket.route_permission, ticket.submitted_by, ticket.assigned_to,
        ticket.created_at, ticket.updated_at,
        case ticket.priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end as priority_rank
      from public.support_tickets ticket
      -- Keep the category restriction explicit for the planner while isolating
      -- the same record predicate across list, detail and mutation endpoints.
      where (ticket.category = any(view_categories) or (view_name = 'hr' and ticket.confidential))
        and (view_name <> 'mine' or ticket.submitted_by = actor_id)
        and (view_name = 'mine' or ticket.route_permission = any(view_routes))
        and private.sygilant_technology_ticket_matches_view_v1(ticket,view_name,view_categories,actor_id,actor_grants)
        and (clean_status = 'all'
          or (clean_status = 'open' and ticket.status not in ('resolved', 'closed'))
          or (clean_status = 'resolved' and ticket.status in ('resolved', 'closed'))
          or ticket.status = clean_status)
        and (clean_search = '' or strpos(lower(ticket.subject), clean_search) > 0
          or strpos(lower(concat('TKT-', lpad(ticket.ticket_number::text, 6, '0'))), clean_search) > 0)
        and private.support_can_view(ticket)
    ), page_items as (
      select candidate.*,
        case when clean_order = 'oldest' then candidate.updated_at end as oldest_first,
        case when clean_order <> 'oldest' then candidate.priority_rank end as rank_first
      from scoped candidate
      order by oldest_first asc nulls last, rank_first asc nulls last, candidate.updated_at desc, candidate.id
      limit clean_size offset (clean_page - 1) * clean_size
    ), totals as (select count(*) as total from scoped)
    select jsonb_build_object(
      'tickets', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', item.id, 'ticketNumber', concat('TKT-', lpad(item.ticket_number::text, 6, '0')),
          'subject', item.subject, 'category', item.category, 'subcategory', item.subcategory,
          'status', item.status, 'priority', item.priority, 'confidential', item.confidential, 'routePermission', item.route_permission,
          'submittedBy', jsonb_build_object('id', submitter.id, 'name', concat(coalesce(nullif(submitter.preferred_name, ''), submitter.first_name), ' ', submitter.last_name)),
          'assignedTo', case when assignee.id is null then null else jsonb_build_object('id', assignee.id, 'name', concat(coalesce(nullif(assignee.preferred_name, ''), assignee.first_name), ' ', assignee.last_name)) end,
          'createdAt', item.created_at, 'updatedAt', item.updated_at
        ) order by item.oldest_first asc nulls last, item.rank_first asc nulls last, item.updated_at desc, item.id)
        from page_items item
        join public.employees submitter on submitter.id = item.submitted_by
        left join public.employees assignee on assignee.id = item.assigned_to
      ), '[]'::jsonb),
      'page', jsonb_build_object(
        'number', clean_page, 'size', clean_size, 'total', totals.total,
        'totalPages', greatest(1, ceil(totals.total::numeric / clean_size)::integer)
      ),
      'permissions', jsonb_build_object(
        'staffAccess', view_name <> 'mine',
        'canManage', view_name <> 'mine' and 'support.tickets.manage' = any(actor_grants),
        'isAdmin', view_name <> 'mine' and public.current_app_role() = 'admin'
      )
    )
    from totals
  );
end
$$;
revoke all on function public.get_sygilant_technology_ticket_workspace_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.get_sygilant_technology_ticket_workspace_v1(jsonb) to authenticated;
comment on function public.get_sygilant_technology_ticket_workspace_v1(jsonb) is
  'Retains canonical support authorization while applying desk category, owner, search and sort before total and pagination.';

create function public.read_sygilant_technology_ticket_v1(target_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_actor_id uuid := private.current_employee_id();
  actor_grants text[] := coalesce(public.get_effective_permissions(), '{}'::text[]);
  view_name text := target_input ->> 'view';
  view_categories text[];
  ticket public.support_tickets%rowtype;
  details jsonb;
  eligible_transfers text[] := '{}'::text[];
  can_manage boolean;
begin
  if jsonb_typeof(target_input) is distinct from 'object'
    or target_input - array['view','ticketId','assignees']::text[] <> '{}'::jsonb
    or not coalesce((target_input ->> 'ticketId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', false)
    or (target_input ? 'assignees' and jsonb_typeof(target_input -> 'assignees') is distinct from 'boolean') then
    raise invalid_parameter_value using message = 'invalid_ticket_query';
  end if;

  view_categories := private.sygilant_technology_ticket_categories_v1(view_name);
  select candidate.* into ticket
  from public.support_tickets candidate
  where candidate.id = (target_input ->> 'ticketId')::uuid
    and private.sygilant_technology_ticket_matches_view_v1(candidate,view_name,view_categories,current_actor_id,actor_grants)
    and private.support_can_view(candidate);
  if not found then
    raise insufficient_privilege using message = 'ticket_not_available';
  end if;

  can_manage := view_name <> 'mine' and 'support.tickets.manage' = any(actor_grants) and private.support_can_manage(ticket);
  if (target_input -> 'assignees') = 'true'::jsonb then
    if not can_manage then
      raise insufficient_privilege using message = 'ticket_not_available';
    end if;
    return coalesce((
      select jsonb_agg(candidate.handler order by candidate.ordinality)
      from jsonb_array_elements(public.get_support_ticket_assignees(ticket.id))
        with ordinality as candidate(handler,ordinality)
      where private.sygilant_technology_ticket_handler_v1((candidate.handler ->> 'id')::uuid,ticket.route_permission,view_name)
    ),'[]'::jsonb);
  end if;

  details := public.read_support_ticket(ticket.id);
  if details ->> 'id' is distinct from ticket.id::text
    or details ->> 'category' is distinct from ticket.category
    or details ->> 'routePermission' is distinct from ticket.route_permission
    or details -> 'confidential' is distinct from to_jsonb(ticket.confidential)
    or details #>> '{submittedBy,id}' is distinct from ticket.submitted_by::text then
    raise insufficient_privilege using message = 'ticket_not_available';
  end if;

  if can_manage and ticket.route_permission = any(actor_grants)
    and private.sygilant_technology_ticket_can_transfer_v1(ticket) then
    select coalesce(array_agg(candidate.category order by candidate.category), '{}'::text[]) into eligible_transfers
    from unnest(array['schedule','timekeeping','payroll','site_post','equipment','safety','account_access','technical','client_request','other']::text[]) candidate(category)
    where candidate.category <> ticket.category
      and private.support_route_permission(candidate.category,false) = any(actor_grants)
      and private.sygilant_technology_ticket_staff_allowed_v1(
        private.sygilant_technology_ticket_destination_v1(candidate.category),actor_grants);
  end if;

  if not can_manage then
    details := details || jsonb_build_object('events','[]'::jsonb,'messages',coalesce((
      select jsonb_agg(item.message order by item.ordinality)
      from jsonb_array_elements(details -> 'messages') with ordinality as item(message,ordinality)
      where item.message ->> 'visibility' = 'public'
    ),'[]'::jsonb));
  end if;
  return details || jsonb_build_object('canManage',can_manage,'transferCategories',eligible_transfers);
end
$$;
revoke all on function public.read_sygilant_technology_ticket_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.read_sygilant_technology_ticket_v1(jsonb) to authenticated;
comment on function public.read_sygilant_technology_ticket_v1(jsonb) is
  'Checks the exact Requests desk first, then delegates ticket detail or eligible-handler lookup to the canonical support routines.';

create function public.apply_sygilant_technology_ticket_action_v1(target_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_actor_id uuid := private.current_employee_id();
  actor_grants text[] := coalesce(public.get_effective_permissions(), '{}'::text[]);
  view_name text := target_input ->> 'view';
  view_categories text[];
  action_name text := target_input ->> 'operation';
  clean_body text := btrim(target_input ->> 'body');
  patch jsonb := target_input -> 'changes';
  action_ticket_id uuid;
  action_request_id uuid;
  expected_at timestamptz;
  action_hash bytea;
  ticket public.support_tickets%rowtype;
  recorded private.sygilant_technology_ticket_action_receipts%rowtype;
  action_message bigint;
  original_category text;
  destination_category text;
  destination_permission text;
  destination_view text;
  transfer_reason text;
  clear_assignment boolean;
  previous_ticket jsonb;
  replayed boolean := false;
begin
  if jsonb_typeof(target_input) is distinct from 'object'
    or target_input - array['view', 'ticketId', 'requestId', 'expectedUpdatedAt', 'operation', 'body', 'changes']::text[] <> '{}'::jsonb
    or action_name is null or action_name not in ('reply', 'note', 'update', 'transfer')
    or not coalesce((target_input ->> 'ticketId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', false)
    or not coalesce((target_input ->> 'requestId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', false) then
    raise invalid_parameter_value using message = 'invalid_ticket_action';
  end if;

  view_categories := private.sygilant_technology_ticket_categories_v1(view_name);
  if (view_name = 'mine' and action_name <> 'reply')
    or (view_name <> 'mine' and not ('support.tickets.manage' = any(actor_grants))) then
    raise insufficient_privilege using message = 'ticket_not_available';
  end if;

  action_ticket_id := (target_input ->> 'ticketId')::uuid;
  action_request_id := (target_input ->> 'requestId')::uuid;

  if action_name in ('update','transfer') then
    if target_input ? 'body'
      or not coalesce((target_input ->> 'expectedUpdatedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$', false)
      or jsonb_typeof(patch) is distinct from 'object'
      or patch = '{}'::jsonb then
      raise invalid_parameter_value using message = 'invalid_ticket_action';
    end if;
    if action_name = 'update' and (patch - array['status','priority','assignedTo']::text[] <> '{}'::jsonb
      or (patch ? 'status' and not coalesce((patch ->> 'status') in ('new', 'assigned', 'in_progress', 'waiting_on_employee', 'resolved', 'reopened'), false))
      or (patch ? 'priority' and not coalesce((patch ->> 'priority') in ('low', 'normal', 'high', 'urgent'), false))
      or (patch ? 'assignedTo' and patch -> 'assignedTo' <> 'null'::jsonb and not coalesce((patch ->> 'assignedTo') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', false))) then
      raise invalid_parameter_value using message = 'invalid_ticket_action';
    end if;
    if action_name = 'transfer' then
      destination_category := patch ->> 'category';
      destination_view := private.sygilant_technology_ticket_destination_v1(destination_category);
      transfer_reason := btrim(patch ->> 'reason');
      if patch - array['category','reason']::text[] <> '{}'::jsonb
        or destination_view is null or jsonb_typeof(patch -> 'reason') is distinct from 'string'
        or coalesce(length(transfer_reason),0) not between 8 and 500 then
        raise invalid_parameter_value using message = 'invalid_ticket_action';
      end if;
      destination_permission := private.support_route_permission(destination_category,false);
      if not (destination_permission = any(actor_grants))
        or not private.sygilant_technology_ticket_staff_allowed_v1(destination_view,actor_grants) then
        raise insufficient_privilege using message = 'ticket_not_available';
      end if;
    end if;
    begin
      expected_at := (target_input ->> 'expectedUpdatedAt')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise invalid_parameter_value using message = 'invalid_ticket_action';
    end;
  elsif jsonb_typeof(target_input -> 'body') is distinct from 'string'
    or coalesce(length(clean_body), 0) not between 1 and 5000
    or target_input ? 'changes'
    or target_input ->> 'expectedUpdatedAt' is not null then
    raise invalid_parameter_value using message = 'invalid_ticket_action';
  end if;

  -- Serialize the actor's receipt identity across tickets, then lock only
  -- the admissible target row. Canonical writers reuse this same row lock.
  if not pg_try_advisory_xact_lock(hashtextextended(concat('sygilant-technology-ticket-action:', current_actor_id, ':', action_request_id), 0)) then
    raise sqlstate 'PT409' using message = 'ticket_request_busy';
  end if;

  action_hash := sha256(convert_to(jsonb_build_object(
    'ticketId', action_ticket_id, 'view', view_name, 'operation', action_name,
    'body', clean_body, 'changes', patch,
    'expectedUnixTime', extract(epoch from expected_at)
  )::text, 'UTF8'));
  select receipt.* into recorded
  from private.sygilant_technology_ticket_action_receipts receipt
  where receipt.actor_id = current_actor_id and receipt.request_id = action_request_id;
  replayed := found;
  if replayed and recorded.request_hash <> action_hash then
    raise sqlstate 'PT409' using message = 'ticket_request_conflict';
  end if;

  begin
    select candidate.* into ticket
    from public.support_tickets candidate
    where candidate.id = action_ticket_id
      and private.support_can_view(candidate)
      and (view_name = 'mine' or private.support_can_manage(candidate))
      and (
        private.sygilant_technology_ticket_matches_view_v1(candidate,view_name,view_categories,current_actor_id,actor_grants)
        or (replayed and action_name = 'transfer' and recorded.operation = 'transfer'
          and candidate.category = recorded.destination_category
          and candidate.route_permission = destination_permission and not candidate.confidential
          and recorded.source_category = any(view_categories)
          and private.support_route_permission(recorded.source_category,false) = any(actor_grants))
      )
    for update nowait;
  exception when lock_not_available then
    raise sqlstate 'PT409' using message = 'ticket_request_busy';
  end;
  if not found then
    raise insufficient_privilege using message = 'ticket_not_available';
  end if;

  if replayed then
    if action_name = 'transfer' then
      if ticket.confidential or ticket.category is distinct from recorded.destination_category
        or ticket.route_permission is distinct from destination_permission
        or not (private.support_route_permission(recorded.source_category,false) = any(actor_grants)) then
        raise insufficient_privilege using message = 'ticket_not_available';
      end if;
      clear_assignment := recorded.assignment_cleared;
    end if;
    action_message := recorded.message_id;
  else
    if action_name in ('update','transfer') then
      if ticket.updated_at is distinct from expected_at then
        raise sqlstate 'PT409' using message = 'ticket_changed';
      end if;
    end if;

    if action_name = 'update' then
      if patch ->> 'assignedTo' is not null and not private.sygilant_technology_ticket_handler_v1(
        (patch ->> 'assignedTo')::uuid,ticket.route_permission,view_name) then
        raise insufficient_privilege using message = 'ticket_not_available';
      end if;
      perform public.update_support_ticket(ticket.id, patch);
    elsif action_name = 'transfer' then
      if not (ticket.route_permission = any(actor_grants)) then
        raise insufficient_privilege using message = 'ticket_not_available';
      end if;
      if ticket.category = destination_category
        or not private.sygilant_technology_ticket_can_transfer_v1(ticket) then
        raise sqlstate 'PT409' using message = 'ticket_transfer_blocked';
      end if;

      -- Do not carry an assignee into a queue they cannot handle. Canonical
      -- readers, realtime signals and delivery claims use the new route.
      original_category := ticket.category;
      previous_ticket := to_jsonb(ticket);
      clear_assignment := ticket.assigned_to is not null
        and not private.sygilant_technology_ticket_handler_v1(ticket.assigned_to,destination_permission,destination_view);
      update public.support_tickets candidate set
        category = destination_category,
        route_permission = destination_permission,
        assigned_to = case when clear_assignment then null else candidate.assigned_to end,
        status = case when clear_assignment and candidate.status = 'assigned' then 'new' else candidate.status end,
        updated_at = clock_timestamp()
      where candidate.id = ticket.id
      returning candidate.* into ticket;
      insert into public.support_ticket_events(ticket_id,actor_id,event_type,detail) values (
        ticket.id,current_actor_id,'ticket_transferred',
        jsonb_build_object('previousCategory',original_category,'category',destination_category,
          'status',ticket.status,'assignmentCleared',clear_assignment)
      );
      insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,old_record,new_record) values (
        (select auth.uid()),current_actor_id,'public','support_tickets','TRANSFER',ticket.id::text,
        previous_ticket,to_jsonb(ticket) || jsonb_build_object('transferReason',transfer_reason)
      );
    else
      action_message := public.add_support_ticket_message(ticket.id, clean_body, action_name = 'note');
    end if;
    insert into private.sygilant_technology_ticket_action_receipts (
      actor_id, request_id, ticket_id, request_hash, operation, message_id,
      source_category,destination_category,destination_view,assignment_cleared
    ) values (
      current_actor_id, action_request_id, ticket.id, action_hash, action_name, action_message,
      original_category,destination_category,destination_view,clear_assignment
    );
  end if;

  return jsonb_strip_nulls(jsonb_build_object('ticketId', ticket.id, 'operation', action_name, 'messageId', action_message,
    'destinationCategory',destination_category,'destinationView',destination_view,'assignmentCleared',clear_assignment));
end
$$;
revoke all on function public.apply_sygilant_technology_ticket_action_v1(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_sygilant_technology_ticket_action_v1(jsonb) to authenticated;
comment on function public.apply_sygilant_technology_ticket_action_v1(jsonb) is
  'Scoped idempotent action wrapper. Canonical SygShift mutations and delivery remain authoritative; safe transfers are audited atomically.';

notify pgrst, 'reload schema';
commit;

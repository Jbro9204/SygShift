begin;

set local lock_timeout = '5s';

-- Client communications are a distinct, MFA-protected Client Files capability.
-- They link existing internal SygSphere conversations without copying messages,
-- attachments, receipts, revisions, or membership into the Client Files domain.
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
    'clients.communications.view',
    'Client Files',
    'View client communications',
    'View client-linked internal SygSphere conversations only when the employee is also a current conversation participant.',
    'sensitive',
    true,
    true,
    true
  ),
  (
    'clients.communications.manage',
    'Client Files',
    'Manage client communications',
    'Link or unlink a client and an internal SygSphere conversation when the employee is a current participant.',
    'critical',
    true,
    true,
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

-- Preserve the existing Client Files authorization cohorts. A role receives
-- communications view only if it already had clients.view; management follows
-- clients.manage. No SygSphere membership is created or broadened here.
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role_permission.role_id, 'clients.communications.view', true
from public.access_role_permissions role_permission
where role_permission.permission_code = 'clients.view'
  and role_permission.enabled
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role_permission.role_id, 'clients.communications.manage', true
from public.access_role_permissions role_permission
where role_permission.permission_code = 'clients.manage'
  and role_permission.enabled
  and exists (
    select 1
    from public.access_role_permissions view_permission
    where view_permission.role_id = role_permission.role_id
      and view_permission.permission_code = 'clients.view'
      and view_permission.enabled
  )
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

-- Keep role bundles closed over the Client Communications dependencies. This
-- also repairs a partially applied prior run before the save RPC is replaced.
update public.access_role_permissions communication_permission
set enabled = false,
    updated_at = clock_timestamp()
where communication_permission.enabled
  and communication_permission.permission_code in (
    'clients.communications.view',
    'clients.communications.manage'
  )
  and (
    not exists (
      select 1
      from public.access_role_permissions client_view
      where client_view.role_id = communication_permission.role_id
        and client_view.permission_code = 'clients.view'
        and client_view.enabled
    )
    or (
      communication_permission.permission_code = 'clients.communications.manage'
      and (
        not exists (
          select 1
          from public.access_role_permissions client_manage
          where client_manage.role_id = communication_permission.role_id
            and client_manage.permission_code = 'clients.manage'
            and client_manage.enabled
        )
        or not exists (
          select 1
          from public.access_role_permissions communication_view
          where communication_view.role_id = communication_permission.role_id
            and communication_view.permission_code = 'clients.communications.view'
            and communication_view.enabled
        )
      )
    )
  );

-- Preserve deliberate person-specific Client Files grants without weakening
-- an existing person-specific Communications denial. Management also receives
-- Communications view so the dependent pair remains internally complete;
-- the live clients.view/clients.manage checks below still decide usability.
lock table public.employee_permission_overrides in share row exclusive mode;

with mapped_sources as (
  select
    source_override.id as source_override_id,
    source_override.employee_id,
    source_override.permission_code as source_permission_code,
    'clients.communications.view'::text as target_permission_code,
    source_override.created_by,
    source_override.created_at
  from public.employee_permission_overrides source_override
  where source_override.active
    and source_override.effect = 'grant'
    and source_override.permission_code in ('clients.view', 'clients.manage')

  union all

  select
    source_override.id,
    source_override.employee_id,
    source_override.permission_code,
    'clients.communications.manage'::text,
    source_override.created_by,
    source_override.created_at
  from public.employee_permission_overrides source_override
  where source_override.active
    and source_override.effect = 'grant'
    and source_override.permission_code = 'clients.manage'
),
selected_sources as (
  select distinct on (
    mapped_source.employee_id,
    mapped_source.target_permission_code
  )
    mapped_source.*
  from mapped_sources mapped_source
  order by
    mapped_source.employee_id,
    mapped_source.target_permission_code,
    (mapped_source.source_permission_code = 'clients.view') desc,
    mapped_source.created_at,
    mapped_source.source_override_id
),
inserted_overrides as (
  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    active,
    created_by
  )
  select
    selected_source.employee_id,
    selected_source.target_permission_code,
    'grant',
    concat(
      'Client Communications rollout inherited this grant from active ',
      selected_source.source_permission_code,
      ' override ',
      selected_source.source_override_id,
      '.'
    ),
    true,
    selected_source.created_by
  from selected_sources selected_source
  where not exists (
    select 1
    from public.employee_permission_overrides existing_override
    where existing_override.employee_id = selected_source.employee_id
      and existing_override.permission_code = selected_source.target_permission_code
      and existing_override.active
  )
    and (
      selected_source.target_permission_code <> 'clients.communications.manage'
      or not exists (
        select 1
        from public.employee_permission_overrides communication_view_denial
        where communication_view_denial.employee_id = selected_source.employee_id
          and communication_view_denial.permission_code = 'clients.communications.view'
          and communication_view_denial.active
          and communication_view_denial.effect = 'deny'
      )
    )
  on conflict (employee_id, permission_code) where active do nothing
  returning
    id,
    employee_id,
    permission_code,
    effect,
    reason,
    created_by
)
insert into private.audit_events (
  auth_user_id,
  employee_id,
  schema_name,
  table_name,
  operation,
  row_id,
  new_record
)
select
  null,
  null,
  'public',
  'employee_permission_overrides',
  'CLIENT_COMMUNICATIONS_PERMISSION_BACKFILLED',
  inserted_override.id::text,
  jsonb_build_object(
    'employeeId', inserted_override.employee_id,
    'permissionCode', inserted_override.permission_code,
    'effect', inserted_override.effect,
    'reason', inserted_override.reason,
    'createdBy', inserted_override.created_by,
    'sourcePermissionCode', selected_source.source_permission_code,
    'sourceOverrideId', selected_source.source_override_id
  )
from inserted_overrides inserted_override
join selected_sources selected_source
  on selected_source.employee_id = inserted_override.employee_id
 and selected_source.target_permission_code = inserted_override.permission_code;

create or replace function private.normalize_access_role_permission_dependencies(
  target_permission_codes text[]
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  with requested as (
    select distinct btrim(permission_code) as permission_code
    from unnest(
      coalesce(target_permission_codes, array[]::text[])
    ) requested_permission(permission_code)
    where nullif(btrim(permission_code), '') is not null
  ),
  expanded as (
    select requested_permission.permission_code
    from requested requested_permission

    union

    select 'clients.view'
    where exists (
      select 1
      from requested requested_permission
      where requested_permission.permission_code in (
        'clients.communications.view',
        'clients.communications.manage'
      )
    )

    union

    select 'clients.manage'
    where exists (
      select 1
      from requested requested_permission
      where requested_permission.permission_code = 'clients.communications.manage'
    )

    union

    select 'clients.communications.view'
    where exists (
      select 1
      from requested requested_permission
      where requested_permission.permission_code = 'clients.communications.manage'
    )
  ),
  normalized as (
    select expanded_permission.permission_code
    from expanded expanded_permission
    where expanded_permission.permission_code not in (
        'clients.communications.view',
        'clients.communications.manage'
      )
      or (
        expanded_permission.permission_code = 'clients.communications.view'
        and exists (
          select 1
          from expanded dependency
          where dependency.permission_code = 'clients.view'
        )
      )
      or (
        expanded_permission.permission_code = 'clients.communications.manage'
        and exists (
          select 1
          from expanded dependency
          where dependency.permission_code = 'clients.view'
        )
        and exists (
          select 1
          from expanded dependency
          where dependency.permission_code = 'clients.manage'
        )
        and exists (
          select 1
          from expanded dependency
          where dependency.permission_code = 'clients.communications.view'
        )
      )
  )
  select coalesce(
    array_agg(normalized_permission.permission_code order by normalized_permission.permission_code),
    array[]::text[]
  )
  from normalized normalized_permission
$$;

-- Role saves use the same dependency closure as the Access Control UI. A
-- stale or partial client-communications selection can never persist without
-- its live Client Files base permissions.
create or replace function public.set_access_role_permissions(
  target_role_id uuid,
  target_permission_codes text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_access_control_admin();
  target_role public.access_roles%rowtype;
  baseline_permissions constant text[] := array[
    'sygsphere.comms.use',
    'sygsphere.comms.ptt.listen',
    'sygsphere.comms.ptt.transmit',
    'sygsphere.comms.call.start',
    'sygsphere.comms.call.receive'
  ]::text[];
  clean_permissions text[];
  old_permissions text[];
begin
  select * into target_role
  from public.access_roles
  where id = target_role_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected role no longer exists.';
  end if;

  if target_role.code = 'system_admin' and not public.is_admin() then
    raise insufficient_privilege using message = 'A primary Admin account is required to edit the protected Admin role.';
  end if;

  if exists (
    select 1
    from unnest(coalesce(target_permission_codes, array[]::text[])) requested_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = requested_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'One or more selected permissions are not available.';
  end if;

  clean_permissions := private.normalize_access_role_permission_dependencies(
    coalesce(target_permission_codes, array[]::text[])
    || case when target_role.active then baseline_permissions else array[]::text[] end
  );

  if exists (
    select 1
    from unnest(clean_permissions) normalized_permission(code)
    left join public.permission_catalog catalog
      on catalog.code = normalized_permission.code
     and catalog.active
    where catalog.code is null
  ) then
    raise check_violation using message = 'A required permission dependency is not available.';
  end if;

  if target_role.protected
    and target_role.code = 'system_admin'
    and exists (
      select 1
      from public.permission_catalog catalog
      where catalog.active
        and not (catalog.code = any(clean_permissions))
    )
  then
    raise insufficient_privilege using message = 'The protected Admin role must retain every active permission.';
  end if;

  if target_role.protected
    and target_role.code = 'system_dispatcher'
    and not (
      array[
        'operations.view',
        'scheduler.view',
        'reports.view',
        'time.reports.view'
      ]::text[] <@ clean_permissions
    )
  then
    raise insufficient_privilege
      using message = 'The protected Dispatcher role must retain Home, Scheduler, Reports, and Timekeeping Reports access.';
  end if;

  select coalesce(array_agg(role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into old_permissions
  from public.access_role_permissions role_permission
  where role_permission.role_id = target_role_id
    and role_permission.enabled;

  update public.access_role_permissions
  set enabled = false,
      updated_at = clock_timestamp()
  where role_id = target_role_id;

  insert into public.access_role_permissions (role_id, permission_code, enabled)
  select target_role_id, normalized_permission.code, true
  from unnest(clean_permissions) normalized_permission(code)
  on conflict (role_id, permission_code) do update
  set enabled = true,
      updated_at = clock_timestamp();

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
    'public',
    'access_role_permissions',
    'UPDATE',
    target_role_id::text,
    jsonb_build_object('permissionCodes', old_permissions),
    jsonb_build_object('permissionCodes', clean_permissions)
  );

  return public.get_access_control_center();
end
$$;

revoke all on function private.normalize_access_role_permission_dependencies(text[])
  from public, anon, authenticated;
revoke all on function public.set_access_role_permissions(uuid, text[])
  from public, anon;
grant execute on function public.set_access_role_permissions(uuid, text[])
  to authenticated;

comment on function private.normalize_access_role_permission_dependencies(text[]) is
  'Closes an access-role permission selection over Client Communications dependencies and removes any dependent code whose base requirement remains absent.';
comment on function public.set_access_role_permissions(uuid, text[]) is
  'Replaces an access-role permission bundle with an audited save, normalizes Client Communications dependencies, protects system roles, and preserves the locked SygSphere baseline for active roles.';

create table private.client_sygsphere_conversation_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  conversation_id uuid not null references private.sygsphere_conversations(id) on delete restrict,
  purpose text not null default 'General operations',
  linked_by uuid not null references public.employees(id) on delete restrict,
  linked_at timestamptz not null default clock_timestamp(),
  unlinked_by uuid references public.employees(id) on delete restrict,
  unlinked_at timestamptz,
  unlink_reason text,
  constraint client_sygsphere_link_purpose_present
    check (char_length(btrim(purpose)) between 2 and 160),
  constraint client_sygsphere_link_unlink_complete
    check (
      (
        unlinked_at is null
        and unlinked_by is null
        and unlink_reason is null
      )
      or
      (
        unlinked_at is not null
        and unlinked_by is not null
        and char_length(btrim(coalesce(unlink_reason, ''))) between 5 and 500
      )
    )
);

-- Durable idempotency receipts keep delayed browser retries from applying to a
-- later link generation. The request UUID is supplied by the caller and may be
-- used for exactly one actor, operation, and normalized payload.
create table private.client_sygsphere_conversation_requests (
  request_id uuid primary key,
  operation text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  conversation_id uuid not null references private.sygsphere_conversations(id) on delete restrict,
  link_id uuid not null references private.client_sygsphere_conversation_links(id) on delete restrict,
  purpose text,
  reason text,
  outcome text not null,
  completed_at timestamptz not null default clock_timestamp(),
  constraint client_sygsphere_request_operation_valid
    check (operation in ('link', 'unlink')),
  constraint client_sygsphere_request_payload_complete
    check (
      (
        operation = 'link'
        and char_length(btrim(coalesce(purpose, ''))) between 2 and 160
        and reason is null
        and outcome in ('created', 'already_linked')
      )
      or
      (
        operation = 'unlink'
        and purpose is null
        and char_length(btrim(coalesce(reason, ''))) between 5 and 500
        and outcome = 'unlinked'
      )
    )
);

-- A conversation has one authoritative Client File while actively linked.
-- Historical rows remain immutable evidence after an unlink and may coexist.
create unique index client_sygsphere_links_active_conversation_uidx
  on private.client_sygsphere_conversation_links (conversation_id)
  where unlinked_at is null;

create index client_sygsphere_links_client_history_idx
  on private.client_sygsphere_conversation_links (client_id, linked_at desc);

create index client_sygsphere_links_conversation_history_idx
  on private.client_sygsphere_conversation_links (conversation_id, linked_at desc);

create index client_sygsphere_links_linked_by_idx
  on private.client_sygsphere_conversation_links (linked_by, linked_at desc);

create index client_sygsphere_links_unlinked_by_idx
  on private.client_sygsphere_conversation_links (unlinked_by, unlinked_at desc)
  where unlinked_by is not null;

create index client_sygsphere_requests_actor_history_idx
  on private.client_sygsphere_conversation_requests (actor_id, completed_at desc);

create index client_sygsphere_requests_client_history_idx
  on private.client_sygsphere_conversation_requests (client_id, completed_at desc);

create index client_sygsphere_requests_conversation_history_idx
  on private.client_sygsphere_conversation_requests (conversation_id, completed_at desc);

create index client_sygsphere_requests_link_idx
  on private.client_sygsphere_conversation_requests (link_id);

alter table private.client_sygsphere_conversation_links enable row level security;
alter table private.client_sygsphere_conversation_links force row level security;
revoke all on table private.client_sygsphere_conversation_links
  from public, anon, authenticated;

alter table private.client_sygsphere_conversation_requests enable row level security;
alter table private.client_sygsphere_conversation_requests force row level security;
revoke all on table private.client_sygsphere_conversation_requests
  from public, anon, authenticated;

create or replace function private.client_communications_has_permission(
  target_employee_id uuid,
  required_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select required_permission in (
      'clients.communications.view',
      'clients.communications.manage'
    )
    and exists (
      select 1
      from public.permission_catalog catalog
      where catalog.code = required_permission
        and catalog.active
    )
    and required_permission = any(
      coalesce(
        private.employee_effective_permissions(target_employee_id),
        array[]::text[]
      )
    )
$$;

create or replace function private.require_client_communications_actor(
  required_permission text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  actor_permissions text[];
begin
  if required_permission not in (
    'clients.communications.view',
    'clients.communications.manage'
  ) then
    raise check_violation using message = 'The requested Client Communications permission is invalid.';
  end if;

  select employee.id
  into actor_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.auth_user_id = (select auth.uid())
    and account.activated_at is not null
    and account.disabled_at is null
    and employee.status = 'active'
  limit 1;

  if actor_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required.';
  end if;

  if not exists (
    select 1
    from private.sygsphere_gate gate
    where gate.enabled
  ) then
    raise object_not_in_prerequisite_state using
      message = 'SygSphere is temporarily unavailable. Other SygShift features remain available.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA verification is required for Client Communications.';
  end if;

  actor_permissions := coalesce(
    private.employee_effective_permissions(actor_id),
    array[]::text[]
  );

  if not private.client_communications_has_permission(actor_id, required_permission) then
    raise insufficient_privilege using message = 'Client Communications permission is required.';
  end if;

  if required_permission = 'clients.communications.manage'
    and not private.client_communications_has_permission(
      actor_id,
      'clients.communications.view'
    ) then
    raise insufficient_privilege using message = 'Client Communications view permission is also required.';
  end if;

  if not ('clients.view' = any(actor_permissions)) then
    raise insufficient_privilege using message = 'Client File access is required.';
  end if;

  if required_permission = 'clients.communications.manage'
    and not ('clients.manage' = any(actor_permissions)) then
    raise insufficient_privilege using message = 'Client management permission is required.';
  end if;

  if not (
    'sygsphere.comms.use' = any(actor_permissions)
  ) then
    raise insufficient_privilege using message = 'SygSphere communications access is required.';
  end if;

  return actor_id;
end
$$;

create or replace function private.client_sygsphere_conversation_display_name(
  target_conversation_id uuid,
  target_actor_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when conversation.kind = 'direct' then coalesce(
      (
        select btrim(concat_ws(
          ' ',
          coalesce(nullif(other_employee.preferred_name, ''), other_employee.first_name),
          other_employee.last_name
        ))
        from private.sygsphere_members other_membership
        join public.employees other_employee
          on other_employee.id = other_membership.employee_id
        where other_membership.conversation_id = conversation.id
          and other_membership.employee_id <> target_actor_id
          and other_membership.removed_at is null
        order by other_membership.owner desc,
                 other_membership.joined_at,
                 other_membership.employee_id
        limit 1
      ),
      'Direct conversation'
    )
    else coalesce(
      nullif(btrim(conversation.name), ''),
      initcap(conversation.kind) || ' conversation'
    )
  end
  from private.sygsphere_conversations conversation
  where conversation.id = target_conversation_id
$$;

create or replace function private.client_communication_rows(
  target_actor_id uuid,
  target_client_id uuid default null,
  target_conversation_id uuid default null,
  target_search text default null,
  target_limit integer default null,
  target_offset integer default 0
)
returns table (
  link_id uuid,
  updated_at timestamptz,
  client_name text,
  conversation_id uuid,
  payload jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    link.id as link_id,
    greatest(conversation.updated_at, link.linked_at) as updated_at,
    client.display_name as client_name,
    conversation.id as conversation_id,
    jsonb_build_object(
      'linkId', link.id,
      'clientId', client.id,
      'clientName', client.display_name,
      'clientNumber', client.client_number,
      'conversationId', conversation.id,
      'conversationName', conversation_label.name,
      'kind', conversation.kind,
      'archived', conversation.archived,
      'unread', (
        select count(*)
        from private.sygsphere_messages message
        where message.conversation_id = conversation.id
          and message.author_id <> target_actor_id
          and message.deleted_at is null
          and not exists (
            select 1
            from private.sygsphere_reads receipt
            where receipt.message_id = message.id
              and receipt.employee_id = target_actor_id
          )
      ),
      'updatedAt', greatest(conversation.updated_at, link.linked_at),
      'latestBody', latest_message.body,
      'latestCreatedAt', latest_message.created_at,
      'purpose', link.purpose,
      'linkedAt', link.linked_at,
      'linkedBy', link.linked_by,
      'owner', membership.owner
    ) as payload
  from private.client_sygsphere_conversation_links link
  join public.clients client
    on client.id = link.client_id
   and client.archived_at is null
  join private.sygsphere_conversations conversation
    on conversation.id = link.conversation_id
  join private.sygsphere_members membership
    on membership.conversation_id = conversation.id
   and membership.employee_id = target_actor_id
   and membership.removed_at is null
  cross join lateral (
    select private.client_sygsphere_conversation_display_name(
      conversation.id,
      target_actor_id
    ) as name
  ) conversation_label
  left join lateral (
    select
      case
        when message.deleted_at is null then left(message.body, 240)
        else 'Message deleted'
      end as body,
      message.created_at
    from private.sygsphere_messages message
    where message.conversation_id = conversation.id
    order by message.sequence desc
    limit 1
  ) latest_message on true
  where link.unlinked_at is null
    and (target_client_id is null or link.client_id = target_client_id)
    and (
      target_conversation_id is null
      or link.conversation_id = target_conversation_id
    )
    and (
      btrim(coalesce(target_search, '')) = ''
      or strpos(lower(concat_ws(
        ' ',
        client.client_number,
        client.legal_name,
        client.display_name,
        link.purpose,
        conversation_label.name,
        conversation.kind
      )), lower(left(btrim(target_search), 100))) > 0
    )
  order by greatest(conversation.updated_at, link.linked_at) desc,
           client.display_name,
           conversation.id,
           link.id
  limit target_limit
  offset greatest(coalesce(target_offset, 0), 0)
$$;

create or replace function public.list_client_communications(
  target_client_id uuid default null,
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_client_communications_actor(
    'clients.communications.view'
  );
  actor_can_manage boolean;
  clean_search text := left(btrim(coalesce(target_search, '')), 100);
  clean_page integer := least(greatest(coalesce(target_page, 1), 1), 10000);
  clean_page_size integer := case
    when target_page_size in (10, 20, 50) then target_page_size
    else 20
  end;
  total_count integer := 0;
  linked_rows jsonb := '[]'::jsonb;
begin
  actor_can_manage := private.client_communications_has_permission(
    actor_id,
    'clients.communications.manage'
  ) and 'clients.manage' = any(
    coalesce(
      private.employee_effective_permissions(actor_id),
      array[]::text[]
    )
  );

  if target_client_id is not null
    and not exists (
      select 1
      from public.clients client
      where client.id = target_client_id
        and client.archived_at is null
    ) then
    raise no_data_found using message = 'The selected Client File is unavailable.';
  end if;

  select count(*)::integer
  into total_count
  from private.client_sygsphere_conversation_links link
  join public.clients client
    on client.id = link.client_id
   and client.archived_at is null
  join private.sygsphere_conversations conversation
    on conversation.id = link.conversation_id
  join private.sygsphere_members membership
    on membership.conversation_id = conversation.id
   and membership.employee_id = actor_id
   and membership.removed_at is null
  cross join lateral (
    select private.client_sygsphere_conversation_display_name(
      conversation.id,
      actor_id
    ) as name
  ) conversation_label
  where link.unlinked_at is null
    and (target_client_id is null or link.client_id = target_client_id)
    and (
      clean_search = ''
      or strpos(lower(concat_ws(
        ' ',
        client.client_number,
        client.legal_name,
        client.display_name,
        link.purpose,
        conversation_label.name,
        conversation.kind
      )), lower(clean_search)) > 0
    );

  clean_page := least(
    clean_page,
    greatest(ceil(total_count::numeric / clean_page_size)::integer, 1)
  );

  select coalesce(
    jsonb_agg(
      page_row.payload
      order by page_row.updated_at desc,
               page_row.client_name,
               page_row.conversation_id,
               page_row.link_id
    ),
    '[]'::jsonb
  )
  into linked_rows
  from (
    select communication.*
    from private.client_communication_rows(
      actor_id,
      target_client_id,
      null,
      clean_search,
      clean_page_size,
      (clean_page - 1) * clean_page_size
    ) communication
    order by communication.updated_at desc,
             communication.client_name,
             communication.conversation_id,
             communication.link_id
  ) page_row;

  return jsonb_build_object(
    'actor', jsonb_build_object(
      'employeeId', actor_id,
      'canView', true,
      'canManage', actor_can_manage
    ),
    'clientId', target_client_id,
    'rows', linked_rows,
    'pagination', jsonb_build_object(
      'page', clean_page,
      'pageSize', clean_page_size,
      'totalCount', total_count,
      'totalPages', case
        when total_count = 0 then 0
        else ceil(total_count::numeric / clean_page_size)::integer
      end
    )
  );
end
$$;

create or replace function public.list_client_communication_candidates(
  target_client_id uuid,
  target_search text default null,
  target_page integer default 1,
  target_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_client_communications_actor(
    'clients.communications.manage'
  );
  clean_search text := left(btrim(coalesce(target_search, '')), 100);
  clean_page integer := least(greatest(coalesce(target_page, 1), 1), 10000);
  clean_page_size integer := case
    when target_page_size in (10, 20, 50) then target_page_size
    else 20
  end;
  total_count integer := 0;
  candidate_rows jsonb := '[]'::jsonb;
begin
  if target_client_id is null
    or not exists (
      select 1
      from public.clients client
      where client.id = target_client_id
        and client.archived_at is null
    ) then
    raise no_data_found using message = 'The selected Client File is unavailable.';
  end if;

  with candidates as (
    select
      conversation.id as conversation_id,
      conversation.updated_at,
      conversation.kind,
      conversation.archived,
      membership.owner,
      private.client_sygsphere_conversation_display_name(
        conversation.id,
        actor_id
      ) as conversation_name
    from private.sygsphere_members membership
    join private.sygsphere_conversations conversation
      on conversation.id = membership.conversation_id
    where membership.employee_id = actor_id
      and membership.removed_at is null
      and not conversation.archived
      and not exists (
        select 1
        from private.client_sygsphere_conversation_links active_link
        where active_link.conversation_id = conversation.id
          and active_link.unlinked_at is null
      )
  )
  select count(*)::integer
  into total_count
  from candidates candidate
  where clean_search = ''
    or strpos(lower(concat_ws(
      ' ',
      candidate.conversation_name,
      candidate.kind
    )), lower(clean_search)) > 0;

  clean_page := least(
    clean_page,
    greatest(ceil(total_count::numeric / clean_page_size)::integer, 1)
  );

  with candidates as (
    select
      conversation.id as conversation_id,
      conversation.updated_at,
      conversation.kind,
      conversation.archived,
      membership.owner,
      private.client_sygsphere_conversation_display_name(
        conversation.id,
        actor_id
      ) as conversation_name
    from private.sygsphere_members membership
    join private.sygsphere_conversations conversation
      on conversation.id = membership.conversation_id
    where membership.employee_id = actor_id
      and membership.removed_at is null
      and not conversation.archived
      and not exists (
        select 1
        from private.client_sygsphere_conversation_links active_link
        where active_link.conversation_id = conversation.id
          and active_link.unlinked_at is null
      )
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'conversationId', page_row.conversation_id,
        'conversationName', page_row.conversation_name,
        'kind', page_row.kind,
        'archived', page_row.archived,
        'updatedAt', page_row.updated_at,
        'owner', page_row.owner
      )
      order by page_row.updated_at desc,
               page_row.conversation_name,
               page_row.conversation_id
    ),
    '[]'::jsonb
  )
  into candidate_rows
  from (
    select candidate.*
    from candidates candidate
    where clean_search = ''
      or strpos(lower(concat_ws(
        ' ',
        candidate.conversation_name,
        candidate.kind
      )), lower(clean_search)) > 0
    order by candidate.updated_at desc,
             candidate.conversation_name,
             candidate.conversation_id
    limit clean_page_size
    offset (clean_page - 1) * clean_page_size
  ) page_row;

  return jsonb_build_object(
    'actor', jsonb_build_object(
      'employeeId', actor_id,
      'canManage', true
    ),
    'clientId', target_client_id,
    'rows', candidate_rows,
    'pagination', jsonb_build_object(
      'page', clean_page,
      'pageSize', clean_page_size,
      'totalCount', total_count,
      'totalPages', case
        when total_count = 0 then 0
        else ceil(total_count::numeric / clean_page_size)::integer
      end
    )
  );
end
$$;

create or replace function public.get_client_communication_for_conversation(
  target_conversation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_client_communications_actor(
    'clients.communications.view'
  );
  actor_can_manage boolean;
  communication jsonb;
begin
  if target_conversation_id is null then
    raise check_violation using message = 'Choose a SygSphere conversation.';
  end if;

  actor_can_manage := private.client_communications_has_permission(
    actor_id,
    'clients.communications.manage'
  ) and 'clients.manage' = any(
    coalesce(
      private.employee_effective_permissions(actor_id),
      array[]::text[]
    )
  );

  select communication_row.payload
  into communication
  from private.client_communication_rows(
    actor_id,
    null,
    target_conversation_id,
    null,
    1,
    0
  ) communication_row
  limit 1;

  return jsonb_build_object(
    'actor', jsonb_build_object(
      'employeeId', actor_id,
      'canView', true,
      'canManage', actor_can_manage
    ),
    'communication', communication
  );
end
$$;

create or replace function public.link_client_sygsphere_conversation(
  target_request_id uuid,
  target_client_id uuid,
  target_conversation_id uuid,
  target_purpose text default 'General operations'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_client_communications_actor(
    'clients.communications.manage'
  );
  clean_purpose text := btrim(coalesce(target_purpose, ''));
  existing_link private.client_sygsphere_conversation_links%rowtype;
  prior_request private.client_sygsphere_conversation_requests%rowtype;
  new_link_id uuid;
begin
  if not private.client_communications_has_permission(
    actor_id,
    'clients.communications.view'
  ) then
    raise insufficient_privilege using message = 'Client Communications view permission is also required.';
  end if;

  if target_request_id is null then
    raise check_violation using message = 'A request ID is required to link a conversation.';
  end if;

  if target_client_id is null or target_conversation_id is null then
    raise check_violation using message = 'Choose a Client File and a SygSphere conversation.';
  end if;

  if char_length(clean_purpose) not between 2 and 160 then
    raise check_violation using message = 'Enter a communication purpose between 2 and 160 characters.';
  end if;

  perform 1
  from public.clients client
  where client.id = target_client_id
    and client.archived_at is null
  for key share;
  if not found then
    raise no_data_found using message = 'The selected active Client File is unavailable.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'client-sygsphere-request:' || target_request_id::text,
      0
    )
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'client-sygsphere-conversation:' || target_conversation_id::text,
      0
    )
  );

  if not exists (
    select 1
    from private.sygsphere_conversations conversation
    join private.sygsphere_members membership
      on membership.conversation_id = conversation.id
    where conversation.id = target_conversation_id
      and not conversation.archived
      and membership.employee_id = actor_id
      and membership.removed_at is null
  ) then
    raise insufficient_privilege using message = 'Only a current conversation participant can link this conversation.';
  end if;

  select request.*
  into prior_request
  from private.client_sygsphere_conversation_requests request
  where request.request_id = target_request_id;

  if found then
    if prior_request.operation is distinct from 'link'
      or prior_request.actor_id is distinct from actor_id
      or prior_request.client_id is distinct from target_client_id
      or prior_request.conversation_id is distinct from target_conversation_id
      or prior_request.purpose is distinct from clean_purpose
    then
      raise unique_violation using message = 'This request ID has already been used for another Client Communications operation.';
    end if;

    return public.list_client_communications(target_client_id);
  end if;

  select link.*
  into existing_link
  from private.client_sygsphere_conversation_links link
  where link.conversation_id = target_conversation_id
    and link.unlinked_at is null
  for update;

  if found then
    if existing_link.client_id <> target_client_id then
      raise unique_violation using message = 'This conversation is already linked to another Client File.';
    end if;

    insert into private.client_sygsphere_conversation_requests (
      request_id,
      operation,
      actor_id,
      client_id,
      conversation_id,
      link_id,
      purpose,
      outcome
    )
    values (
      target_request_id,
      'link',
      actor_id,
      target_client_id,
      target_conversation_id,
      existing_link.id,
      clean_purpose,
      'already_linked'
    );

    return public.list_client_communications(target_client_id);
  end if;

  insert into private.client_sygsphere_conversation_links (
    client_id,
    conversation_id,
    purpose,
    linked_by
  )
  values (
    target_client_id,
    target_conversation_id,
    clean_purpose,
    actor_id
  )
  returning id into new_link_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  )
  values (
    (select auth.uid()),
    actor_id,
    'private',
    'client_sygsphere_conversation_links',
    'CLIENT_SYGSPHERE_CONVERSATION_LINKED',
    new_link_id::text,
    jsonb_build_object(
      'clientId', target_client_id,
      'conversationId', target_conversation_id,
      'purpose', clean_purpose,
      'requestId', target_request_id
    )
  );

  insert into private.client_sygsphere_conversation_requests (
    request_id,
    operation,
    actor_id,
    client_id,
    conversation_id,
    link_id,
    purpose,
    outcome
  )
  values (
    target_request_id,
    'link',
    actor_id,
    target_client_id,
    target_conversation_id,
    new_link_id,
    clean_purpose,
    'created'
  );

  return public.list_client_communications(target_client_id);
end
$$;

create or replace function public.unlink_client_sygsphere_conversation(
  target_request_id uuid,
  target_link_id uuid,
  target_client_id uuid,
  target_conversation_id uuid,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_client_communications_actor(
    'clients.communications.manage'
  );
  clean_reason text := btrim(coalesce(target_reason, ''));
  active_link private.client_sygsphere_conversation_links%rowtype;
  prior_request private.client_sygsphere_conversation_requests%rowtype;
begin
  if not private.client_communications_has_permission(
    actor_id,
    'clients.communications.view'
  ) then
    raise insufficient_privilege using message = 'Client Communications view permission is also required.';
  end if;

  if target_request_id is null then
    raise check_violation using message = 'A request ID is required to unlink a conversation.';
  end if;

  if target_link_id is null or target_client_id is null or target_conversation_id is null then
    raise check_violation using message = 'Choose a Client File and a SygSphere conversation.';
  end if;

  if char_length(clean_reason) not between 5 and 500 then
    raise check_violation using message = 'Enter an unlink reason between 5 and 500 characters.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'client-sygsphere-request:' || target_request_id::text,
      0
    )
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      'client-sygsphere-conversation:' || target_conversation_id::text,
      0
    )
  );

  if not exists (
    select 1
    from private.sygsphere_members membership
    where membership.conversation_id = target_conversation_id
      and membership.employee_id = actor_id
      and membership.removed_at is null
  ) then
    raise insufficient_privilege using message = 'Only a current conversation participant can unlink this conversation.';
  end if;

  select request.*
  into prior_request
  from private.client_sygsphere_conversation_requests request
  where request.request_id = target_request_id;

  if found then
    if prior_request.operation is distinct from 'unlink'
      or prior_request.actor_id is distinct from actor_id
      or prior_request.client_id is distinct from target_client_id
      or prior_request.conversation_id is distinct from target_conversation_id
      or prior_request.link_id is distinct from target_link_id
      or prior_request.reason is distinct from clean_reason
    then
      raise unique_violation using message = 'This request ID has already been used for another Client Communications operation.';
    end if;

    return public.list_client_communications(target_client_id);
  end if;

  select link.*
  into active_link
  from private.client_sygsphere_conversation_links link
  where link.id = target_link_id
    and link.client_id = target_client_id
    and link.conversation_id = target_conversation_id
  for update;

  if not found or active_link.unlinked_at is not null then
    raise no_data_found using message = 'The requested active Client Communications link generation is unavailable.';
  end if;

  update private.client_sygsphere_conversation_links
  set unlinked_by = actor_id,
      unlinked_at = clock_timestamp(),
      unlink_reason = clean_reason
  where id = active_link.id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  )
  values (
    (select auth.uid()),
    actor_id,
    'private',
    'client_sygsphere_conversation_links',
    'CLIENT_SYGSPHERE_CONVERSATION_UNLINKED',
    active_link.id::text,
    jsonb_build_object(
      'clientId', active_link.client_id,
      'conversationId', active_link.conversation_id,
      'purpose', active_link.purpose,
      'linkedAt', active_link.linked_at
    ),
    jsonb_build_object(
      'clientId', active_link.client_id,
      'conversationId', active_link.conversation_id,
      'linkId', active_link.id,
      'reason', clean_reason,
      'requestId', target_request_id
    )
  );

  insert into private.client_sygsphere_conversation_requests (
    request_id,
    operation,
    actor_id,
    client_id,
    conversation_id,
    link_id,
    reason,
    outcome
  )
  values (
    target_request_id,
    'unlink',
    actor_id,
    target_client_id,
    target_conversation_id,
    active_link.id,
    clean_reason,
    'unlinked'
  );

  return public.list_client_communications(target_client_id);
end
$$;

revoke all on function private.client_communications_has_permission(uuid, text)
  from public, anon, authenticated;
revoke all on function private.require_client_communications_actor(text)
  from public, anon, authenticated;
revoke all on function private.client_sygsphere_conversation_display_name(uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.client_communication_rows(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.list_client_communications(uuid, text, integer, integer)
  from public, anon;
revoke all on function public.list_client_communication_candidates(uuid, text, integer, integer)
  from public, anon;
revoke all on function public.get_client_communication_for_conversation(uuid)
  from public, anon;
revoke all on function public.link_client_sygsphere_conversation(uuid, uuid, uuid, text)
  from public, anon;
revoke all on function public.unlink_client_sygsphere_conversation(uuid, uuid, uuid, uuid, text)
  from public, anon;

grant execute on function public.list_client_communications(uuid, text, integer, integer)
  to authenticated;
grant execute on function public.list_client_communication_candidates(uuid, text, integer, integer)
  to authenticated;
grant execute on function public.get_client_communication_for_conversation(uuid)
  to authenticated;
grant execute on function public.link_client_sygsphere_conversation(uuid, uuid, uuid, text)
  to authenticated;
grant execute on function public.unlink_client_sygsphere_conversation(uuid, uuid, uuid, uuid, text)
  to authenticated;

comment on table private.client_sygsphere_conversation_links is
  'Audit-preserving association between one Client File and an existing internal SygSphere conversation. Message content and membership remain authoritative in SygSphere.';
comment on table private.client_sygsphere_conversation_requests is
  'Private immutable idempotency receipts for accepted Client Communications link, already-linked no-op, and exact-generation unlink requests.';
comment on function public.list_client_communications(uuid, text, integer, integer) is
  'Returns a bounded, searchable page of current-actor-accessible Client Communications rows. Requires the live Client Files and Client Communications view permissions, MFA, the SygSphere gate, and current conversation membership.';
comment on function public.list_client_communication_candidates(uuid, text, integer, integer) is
  'Returns a bounded, searchable page of active, unlinked SygSphere conversations in which the current Client Communications manager is a participant.';
comment on function public.get_client_communication_for_conversation(uuid) is
  'Returns at most one active Client Communications association for the specified SygSphere conversation after rechecking Client Files access, Client Communications access, MFA, the SygSphere gate, and current membership.';
comment on function public.link_client_sygsphere_conversation(uuid, uuid, uuid, text) is
  'Idempotently links one active Client File to one current, unarchived internal SygSphere conversation using a caller-supplied request UUID. Requires live Client Files and Client Communications management permissions plus current conversation membership.';
comment on function public.unlink_client_sygsphere_conversation(uuid, uuid, uuid, uuid, text) is
  'Idempotently retires the exact requested Client Communications link generation using a caller-supplied request UUID, without deleting history or SygSphere content. Requires live Client Files and Client Communications management permissions plus current conversation membership.';

notify pgrst, 'reload schema';

commit;

begin;

set local statement_timeout = '60s';
set local plpgsql.check_asserts = on;

do $client_communications_contract$
begin
  assert exists (
    select 1
    from public.permission_catalog permission
    where permission.code = 'clients.communications.view'
      and permission.active
      and permission.requires_mfa
      and permission.locked
  ), 'Client Communications view is an active, locked, MFA-protected permission.';

  assert exists (
    select 1
    from public.permission_catalog permission
    where permission.code = 'clients.communications.manage'
      and permission.active
      and permission.requires_mfa
      and permission.locked
  ), 'Client Communications management is an active, locked, MFA-protected permission.';

  assert not exists (
    select 1
    from public.access_role_permissions communication_permission
    where communication_permission.permission_code = 'clients.communications.view'
      and communication_permission.enabled
      and not exists (
        select 1
        from public.access_role_permissions client_permission
        where client_permission.role_id = communication_permission.role_id
          and client_permission.permission_code = 'clients.view'
          and client_permission.enabled
      )
  ), 'Communications view does not broaden the existing Client Files role cohort.';

  assert not exists (
    select 1
    from public.access_role_permissions communication_permission
    where communication_permission.permission_code = 'clients.communications.manage'
      and communication_permission.enabled
      and (
        not exists (
          select 1
          from public.access_role_permissions client_permission
          where client_permission.role_id = communication_permission.role_id
            and client_permission.permission_code = 'clients.manage'
            and client_permission.enabled
        )
        or not exists (
          select 1
          from public.access_role_permissions client_permission
          where client_permission.role_id = communication_permission.role_id
            and client_permission.permission_code = 'clients.view'
            and client_permission.enabled
        )
        or not exists (
          select 1
          from public.access_role_permissions view_permission
          where view_permission.role_id = communication_permission.role_id
            and view_permission.permission_code = 'clients.communications.view'
            and view_permission.enabled
        )
      )
  ), 'Communications management retains its view, Client Files view, and Client Files management dependencies.';

  assert private.normalize_access_role_permission_dependencies(
    array['clients.communications.view']::text[]
  ) = array[
    'clients.communications.view',
    'clients.view'
  ]::text[], 'Communications view normalization includes the Client Files view dependency.';

  assert private.normalize_access_role_permission_dependencies(
    array['clients.communications.manage']::text[]
  ) = array[
    'clients.communications.manage',
    'clients.communications.view',
    'clients.manage',
    'clients.view'
  ]::text[], 'Communications management normalization closes over every required dependency.';

  assert not exists (
    select 1
    from (
      select
        source_override.employee_id,
        'clients.communications.view'::text as target_permission_code
      from public.employee_permission_overrides source_override
      where source_override.active
        and source_override.effect = 'grant'
        and source_override.permission_code in ('clients.view', 'clients.manage')

      union

      select
        source_override.employee_id,
        'clients.communications.manage'::text
      from public.employee_permission_overrides source_override
      where source_override.active
        and source_override.effect = 'grant'
        and source_override.permission_code = 'clients.manage'
    ) expected_override
    where not (
      expected_override.target_permission_code = 'clients.communications.manage'
      and exists (
        select 1
        from public.employee_permission_overrides communication_view_denial
        where communication_view_denial.employee_id = expected_override.employee_id
          and communication_view_denial.permission_code = 'clients.communications.view'
          and communication_view_denial.active
          and communication_view_denial.effect = 'deny'
      )
    )
      and not exists (
      select 1
      from public.employee_permission_overrides communication_override
      where communication_override.employee_id = expected_override.employee_id
        and communication_override.permission_code = expected_override.target_permission_code
        and communication_override.active
        and communication_override.effect in ('grant', 'deny')
    )
  ), 'Active individual Client Files grants retain a corresponding Communications grant unless a deliberate Communications denial already occupies that boundary.';

  assert not exists (
    select 1
    from public.employee_permission_overrides communication_override
    where communication_override.active
      and communication_override.effect = 'grant'
      and communication_override.permission_code in (
        'clients.communications.view',
        'clients.communications.manage'
      )
      and communication_override.reason like 'Client Communications rollout inherited this grant from active %'
      and not exists (
        select 1
        from private.audit_events audit
        where audit.table_name = 'employee_permission_overrides'
          and audit.row_id = communication_override.id::text
          and audit.operation = 'CLIENT_COMMUNICATIONS_PERMISSION_BACKFILLED'
      )
  ), 'Every individual Communications grant created by the rollout has an explicit audit event.';

  assert not exists (
    select 1
    from public.employee_permission_overrides communication_manage
    where communication_manage.active
      and communication_manage.effect = 'grant'
      and communication_manage.permission_code = 'clients.communications.manage'
      and communication_manage.reason like 'Client Communications rollout inherited this grant from active %'
      and exists (
        select 1
        from public.employee_permission_overrides communication_view_denial
        where communication_view_denial.employee_id = communication_manage.employee_id
          and communication_view_denial.permission_code = 'clients.communications.view'
          and communication_view_denial.active
          and communication_view_denial.effect = 'deny'
      )
  ), 'The rollout never backfills Communications management across an active Communications view denial.';

  assert not exists (
    select 1
    from public.employee_permission_overrides communication_override
    join private.audit_events audit
      on audit.table_name = 'employee_permission_overrides'
     and audit.row_id = communication_override.id::text
     and audit.operation = 'CLIENT_COMMUNICATIONS_PERMISSION_BACKFILLED'
    left join public.employee_permission_overrides source_override
      on source_override.id::text = audit.new_record ->> 'sourceOverrideId'
    where communication_override.reason like 'Client Communications rollout inherited this grant from active %'
      and (
        source_override.id is null
        or communication_override.created_by is distinct from source_override.created_by
        or audit.new_record ->> 'sourcePermissionCode' is distinct from source_override.permission_code
        or not (
          (
            communication_override.permission_code = 'clients.communications.view'
            and source_override.permission_code in ('clients.view', 'clients.manage')
          )
          or (
            communication_override.permission_code = 'clients.communications.manage'
            and source_override.permission_code = 'clients.manage'
          )
        )
      )
  ), 'Rollout audit provenance maps every generated Communications grant to its source override and creator.';

  assert position(
    'normalize_access_role_permission_dependencies'
    in pg_get_functiondef(
      'public.set_access_role_permissions(uuid,text[])'::regprocedure
    )
  ) > 0, 'Role saves normalize Client Communications dependencies before persistence.';

  assert not has_function_privilege(
    'authenticated',
    'private.normalize_access_role_permission_dependencies(text[])',
    'EXECUTE'
  ), 'Browser sessions cannot invoke the private role-permission normalizer directly.';

  assert (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_class relation
    where relation.oid = 'private.client_sygsphere_conversation_links'::regclass
  ), 'The private Client Communications association enforces RLS.';

  assert not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_links',
    'SELECT'
  ) and not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_links',
    'INSERT'
  ) and not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_links',
    'UPDATE'
  ) and not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_links',
    'DELETE'
  ), 'Authenticated browser sessions cannot access the private link ledger directly.';

  assert (
    select relation.relrowsecurity and relation.relforcerowsecurity
    from pg_class relation
    where relation.oid = 'private.client_sygsphere_conversation_requests'::regclass
  ), 'The private Client Communications request ledger enforces RLS.';

  assert not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_requests',
    'SELECT'
  ) and not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_requests',
    'INSERT'
  ) and not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_requests',
    'UPDATE'
  ) and not has_table_privilege(
    'authenticated',
    'private.client_sygsphere_conversation_requests',
    'DELETE'
  ), 'Authenticated browser sessions cannot access the private request ledger directly.';

  assert not exists (
    select 1
    from information_schema.columns column_record
    where column_record.table_schema = 'private'
      and column_record.table_name = 'client_sygsphere_conversation_links'
      and column_record.column_name in (
        'body',
        'message_id',
        'attachment_id',
        'read_at',
        'revision_id'
      )
  ), 'The Client Files association does not copy SygSphere content or receipts.';

  assert position(
    'sygsphere.comms.use'
    in pg_get_functiondef(
      'private.require_client_communications_actor(text)'::regprocedure
    )
  ) > 0, 'Client Communications also honors the current SygSphere communications permission.';

  assert position(
    'clients.view'
    in pg_get_functiondef(
      'private.require_client_communications_actor(text)'::regprocedure
    )
  ) > 0 and position(
    'clients.manage'
    in pg_get_functiondef(
      'private.require_client_communications_actor(text)'::regprocedure
    )
  ) > 0, 'Client Communications honors live Client Files view and management permissions.';

  assert position(
    'sygsphere_gate'
    in pg_get_functiondef(
      'private.require_client_communications_actor(text)'::regprocedure
    )
  ) > 0, 'Client Communications honors the SygSphere release and isolation gate.';

  assert has_function_privilege(
    'authenticated',
    'public.list_client_communications(uuid,text,integer,integer)',
    'EXECUTE'
  ) and has_function_privilege(
    'authenticated',
    'public.list_client_communication_candidates(uuid,text,integer,integer)',
    'EXECUTE'
  ) and has_function_privilege(
    'authenticated',
    'public.get_client_communication_for_conversation(uuid)',
    'EXECUTE'
  ) and has_function_privilege(
    'authenticated',
    'public.link_client_sygsphere_conversation(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) and has_function_privilege(
    'authenticated',
    'public.unlink_client_sygsphere_conversation(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ), 'Authenticated sessions can call the protected Client Communications RPCs.';

  assert not has_function_privilege(
    'anon',
    'public.list_client_communications(uuid,text,integer,integer)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.list_client_communication_candidates(uuid,text,integer,integer)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.get_client_communication_for_conversation(uuid)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.link_client_sygsphere_conversation(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'anon',
    'public.unlink_client_sygsphere_conversation(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ), 'Anonymous sessions cannot call Client Communications RPCs.';

  assert (
    select procedure_record.prosecdef
      and coalesce(array_to_string(procedure_record.proconfig, ','), '') like '%search_path=%'
    from pg_proc procedure_record
    where procedure_record.oid =
      'public.list_client_communications(uuid,text,integer,integer)'::regprocedure
  ),
    'The list RPC is a search-path-pinned security definer.';

  assert (
    select procedure_record.prosecdef
      and coalesce(array_to_string(procedure_record.proconfig, ','), '') like '%search_path=%'
    from pg_proc procedure_record
    where procedure_record.oid =
      'public.list_client_communication_candidates(uuid,text,integer,integer)'::regprocedure
  ),
    'The candidate RPC is a search-path-pinned security definer.';

  assert (
    select procedure_record.prosecdef
      and coalesce(array_to_string(procedure_record.proconfig, ','), '') like '%search_path=%'
    from pg_proc procedure_record
    where procedure_record.oid =
      'public.get_client_communication_for_conversation(uuid)'::regprocedure
  ),
    'The conversation lookup RPC is a search-path-pinned security definer.';

  assert not has_function_privilege(
    'authenticated',
    'private.client_communication_rows(uuid,uuid,uuid,text,integer,integer)',
    'EXECUTE'
  ), 'Browser sessions cannot invoke the private row projector directly.';

  assert position(
    'limit target_limit'
    in lower(pg_get_functiondef(
      'private.client_communication_rows(uuid,uuid,uuid,text,integer,integer)'::regprocedure
    ))
  ) > 0, 'The private row projector applies the server-side page bound before returning response rows.';

  assert (
    select procedure_record.prosecdef
      and coalesce(array_to_string(procedure_record.proconfig, ','), '') like '%search_path=%'
    from pg_proc procedure_record
    where procedure_record.oid =
      'public.link_client_sygsphere_conversation(uuid,uuid,uuid,text)'::regprocedure
  ),
    'The link RPC is a search-path-pinned security definer.';

  assert (
    select procedure_record.prosecdef
      and coalesce(array_to_string(procedure_record.proconfig, ','), '') like '%search_path=%'
    from pg_proc procedure_record
    where procedure_record.oid =
      'public.unlink_client_sygsphere_conversation(uuid,uuid,uuid,uuid,text)'::regprocedure
  ),
    'The unlink RPC is a search-path-pinned security definer.';
end
$client_communications_contract$;

do $client_communications_behavior$
declare
  manager_employee constant uuid := 'c8100000-0000-4000-8000-000000000001';
  manager_auth constant uuid := 'c8110000-0000-4000-8000-000000000001';
  reviewer_employee constant uuid := 'c8100000-0000-4000-8000-000000000004';
  reviewer_auth constant uuid := 'c8110000-0000-4000-8000-000000000004';
  participant_employee constant uuid := 'c8100000-0000-4000-8000-000000000002';
  participant_auth constant uuid := 'c8110000-0000-4000-8000-000000000002';
  outsider_employee constant uuid := 'c8100000-0000-4000-8000-000000000003';
  outsider_auth constant uuid := 'c8110000-0000-4000-8000-000000000003';
  client_one constant uuid := 'c8120000-0000-4000-8000-000000000001';
  client_two constant uuid := 'c8120000-0000-4000-8000-000000000002';
  direct_conversation constant uuid := 'c8130000-0000-4000-8000-000000000001';
  nonowner_conversation constant uuid := 'c8130000-0000-4000-8000-000000000002';
  hidden_conversation constant uuid := 'c8130000-0000-4000-8000-000000000003';
  direct_message constant uuid := 'c8140000-0000-4000-8000-000000000001';
  direct_message_send_id constant uuid := 'c8150000-0000-4000-8000-000000000001';
  direct_link_request constant uuid := 'c8160000-0000-4000-8000-000000000001';
  conflicting_link_request constant uuid := 'c8160000-0000-4000-8000-000000000002';
  nonowner_link_request constant uuid := 'c8160000-0000-4000-8000-000000000003';
  nonowner_unlink_request constant uuid := 'c8160000-0000-4000-8000-000000000004';
  same_client_noop_request constant uuid := 'c8160000-0000-4000-8000-000000000005';
  short_unlink_request constant uuid := 'c8160000-0000-4000-8000-000000000006';
  direct_unlink_request constant uuid := 'c8160000-0000-4000-8000-000000000007';
  replacement_link_request constant uuid := 'c8160000-0000-4000-8000-000000000008';
  replacement_unlink_request constant uuid := 'c8160000-0000-4000-8000-000000000009';
  reassignment_link_request constant uuid := 'c8160000-0000-4000-8000-000000000010';
  stale_unlink_request constant uuid := 'c8160000-0000-4000-8000-000000000011';
  denied_link_request constant uuid := 'c8160000-0000-4000-8000-000000000012';
  admin_role_id uuid;
  guard_role_id uuid;
  workspace jsonb;
  communication jsonb;
  denied boolean;
  original_link_id uuid;
  nonowner_link_id uuid;
  replacement_link_id uuid;
begin
  insert into public.employees (
    id,
    employee_number,
    username,
    first_name,
    last_name,
    role,
    employment_type,
    status,
    time_zone
  )
  values
    (
      manager_employee,
      'SYG-98101',
      'clientcommsmanager',
      'Client',
      'Manager',
      'admin',
      'salary',
      'active',
      'America/New_York'
    ),
    (
      participant_employee,
      'SYG-98102',
      'clientcommsparticipant',
      'Client',
      'Participant',
      'guard',
      'hourly',
      'active',
      'America/New_York'
    ),
    (
      outsider_employee,
      'SYG-98103',
      'clientcommsoutsider',
      'Client',
      'Outsider',
      'guard',
      'hourly',
      'active',
      'America/New_York'
    ),
    (
      reviewer_employee,
      'SYG-98104',
      'clientcommsreviewer',
      'Client',
      'Reviewer',
      'admin',
      'salary',
      'active',
      'America/New_York'
    );

  insert into auth.users (id, email)
  values
    (manager_auth, 'client-comms-manager@example.invalid'),
    (participant_auth, 'client-comms-participant@example.invalid'),
    (outsider_auth, 'client-comms-outsider@example.invalid'),
    (reviewer_auth, 'client-comms-reviewer@example.invalid');

  insert into private.employee_accounts (
    employee_id,
    auth_user_id,
    activated_at
  )
  values
    (manager_employee, manager_auth, clock_timestamp()),
    (participant_employee, participant_auth, clock_timestamp()),
    (outsider_employee, outsider_auth, clock_timestamp()),
    (reviewer_employee, reviewer_auth, clock_timestamp());

  select access_role.id into admin_role_id
  from public.access_roles access_role
  where access_role.code = 'system_admin';
  select access_role.id into guard_role_id
  from public.access_roles access_role
  where access_role.code = 'system_guard';

  assert admin_role_id is not null and guard_role_id is not null,
    'The regression requires canonical Admin and Guard access roles.';

  insert into public.employee_access_roles (employee_id, role_id, assigned_by)
  values
    (manager_employee, admin_role_id, manager_employee),
    (participant_employee, guard_role_id, manager_employee),
    (outsider_employee, guard_role_id, manager_employee),
    (reviewer_employee, admin_role_id, manager_employee);

  insert into public.clients (
    id,
    client_number,
    legal_name,
    display_name,
    status,
    created_by,
    updated_by
  )
  values
    (
      client_one,
      'CLI-98101',
      'Client Communications One LLC',
      'Client Communications One',
      'active',
      manager_employee,
      manager_employee
    ),
    (
      client_two,
      'CLI-98102',
      'Client Communications Two LLC',
      'Client Communications Two',
      'active',
      manager_employee,
      manager_employee
    );

  insert into private.sygsphere_conversations (
    id,
    kind,
    name,
    direct_key,
    created_by
  )
  values
    (
      direct_conversation,
      'direct',
      '',
      'client-comms-manager:client-comms-participant',
      manager_employee
    ),
    (
      nonowner_conversation,
      'group',
      'Participant-owned operations',
      null,
      participant_employee
    ),
    (
      hidden_conversation,
      'group',
      'Outsider-only operations',
      null,
      outsider_employee
    );

  insert into private.sygsphere_members (
    conversation_id,
    employee_id,
    owner
  )
  values
    (direct_conversation, manager_employee, true),
    (direct_conversation, participant_employee, false),
    (nonowner_conversation, participant_employee, true),
    (nonowner_conversation, manager_employee, false),
    (hidden_conversation, outsider_employee, true);

  insert into private.sygsphere_messages (
    id,
    conversation_id,
    author_id,
    client_id,
    body
  )
  values (
    direct_message,
    direct_conversation,
    participant_employee,
    direct_message_send_id,
    'The client requested a dispatch follow-up.'
  );

  update private.sygsphere_gate
  set enabled = true
  where singleton;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', participant_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', participant_auth::text, true);

  denied := false;
  begin
    perform public.list_client_communications(client_one);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied,
    'Current conversation membership alone does not grant Client Communications access.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal1'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  denied := false;
  begin
    perform public.list_client_communications(client_one);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'AAL1 cannot open Client Communications.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  update private.sygsphere_gate
  set enabled = false
  where singleton;

  denied := false;
  begin
    perform public.list_client_communications(client_one);
  exception when object_not_in_prerequisite_state then
    denied := true;
  end;
  assert denied,
    'The SygSphere isolation gate also disables Client Communications previews.';

  update private.sygsphere_gate
  set enabled = true
  where singleton;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', reviewer_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', reviewer_auth::text, true);

  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    active,
    created_by
  )
  values (
    manager_employee,
    'clients.communications.view',
    'deny',
    'Rollback-only Communications view denial proof.',
    true,
    reviewer_employee
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  denied := false;
  begin
    perform public.list_client_communication_candidates(client_one, null, 1, 10);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied,
    'An exact Communications view denial also blocks the management candidate RPC.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', reviewer_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', reviewer_auth::text, true);

  update public.employee_permission_overrides
  set active = false
  where employee_id = manager_employee
    and permission_code = 'clients.communications.view'
    and active;

  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    active,
    created_by
  )
  values (
    manager_employee,
    'clients.view',
    'deny',
    'Rollback-only Client Files demotion proof.',
    true,
    reviewer_employee
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  denied := false;
  begin
    perform public.list_client_communications(client_one);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied,
    'A live Client Files view denial also removes direct Client Communications RPC access.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', reviewer_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', reviewer_auth::text, true);

  update public.employee_permission_overrides
  set active = false
  where employee_id = manager_employee
    and permission_code = 'clients.view'
    and active;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  workspace := public.list_client_communications(client_one);
  assert coalesce((workspace #>> '{actor,canView}')::boolean, false)
    and coalesce((workspace #>> '{actor,canManage}')::boolean, false)
    and workspace #>> '{actor,employeeId}' = manager_employee::text,
    'The list response describes the exact authorized actor.';
  assert jsonb_array_length(workspace -> 'rows') = 0,
    'An unlinked Client File starts with no communication rows.';
  assert (workspace #>> '{pagination,page}')::integer = 1
    and (workspace #>> '{pagination,pageSize}')::integer = 20
    and (workspace #>> '{pagination,totalCount}')::integer = 0,
    'The communication list returns bounded server pagination metadata.';

  workspace := public.list_client_communication_candidates(client_one, null, 1, 10);
  assert jsonb_array_length(workspace -> 'rows') = 2
    and (workspace #>> '{pagination,totalCount}')::integer = 2
    and exists (
      select 1
      from jsonb_array_elements(workspace -> 'rows') candidate
      where candidate ->> 'conversationId' = direct_conversation::text
    )
    and exists (
      select 1
      from jsonb_array_elements(workspace -> 'rows') candidate
      where candidate ->> 'conversationId' = nonowner_conversation::text
    ),
    'Every active, unlinked conversation in which the manager currently participates is a candidate.';

  workspace := public.list_client_communication_candidates(
    client_one,
    'Client Participant',
    1,
    10
  );
  assert jsonb_array_length(workspace -> 'rows') = 1
    and workspace #>> '{rows,0,conversationId}' = direct_conversation::text,
    'Candidate search is performed by the bounded server RPC.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', reviewer_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', reviewer_auth::text, true);

  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    active,
    created_by
  )
  values (
    manager_employee,
    'clients.manage',
    'deny',
    'Rollback-only Client Files management demotion proof.',
    true,
    reviewer_employee
  );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  workspace := public.list_client_communications(client_one);
  assert not coalesce((workspace #>> '{actor,canManage}')::boolean, true),
    'A live Client Files management denial immediately removes Client Communications management.';

  denied := false;
  begin
    perform public.link_client_sygsphere_conversation(
      denied_link_request,
      client_one,
      direct_conversation,
      'Denied after management demotion'
    );
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied,
    'A live Client Files management denial blocks direct link RPC access.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', reviewer_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', reviewer_auth::text, true);

  update public.employee_permission_overrides
  set active = false
  where employee_id = manager_employee
    and permission_code = 'clients.manage'
    and active;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  workspace := public.link_client_sygsphere_conversation(
    direct_link_request,
    client_one,
    direct_conversation,
    'Dispatch and site operations'
  );

  assert jsonb_array_length(workspace -> 'rows') = 1,
    'Linking produces one Client Communications row.';

  communication := workspace -> 'rows' -> 0;
  original_link_id := (communication ->> 'linkId')::uuid;

  assert (communication ->> 'clientId')::uuid = client_one
    and communication ->> 'clientName' = 'Client Communications One'
    and communication ->> 'clientNumber' = 'CLI-98101'
    and (communication ->> 'conversationId')::uuid = direct_conversation
    and communication ->> 'conversationName' = 'Client Participant'
    and communication ->> 'kind' = 'direct'
    and coalesce((communication ->> 'owner')::boolean, false)
    and (communication ->> 'unread')::integer = 1
    and communication ->> 'latestBody' = 'The client requested a dispatch follow-up.'
    and communication ->> 'purpose' = 'Dispatch and site operations',
    'The linked row has client identity, counterpart naming, membership, unread, preview, and purpose.';

  workspace := public.link_client_sygsphere_conversation(
    direct_link_request,
    client_one,
    direct_conversation,
    'Dispatch and site operations'
  );
  assert workspace #>> '{rows,0,linkId}' = original_link_id::text and (
    select count(*)
    from private.client_sygsphere_conversation_requests request
    where request.request_id = direct_link_request
      and request.link_id = original_link_id
      and request.outcome = 'created'
  ) = 1, 'An immediate link retry returns the original generation and leaves one durable request receipt.';

  denied := false;
  begin
    perform public.unlink_client_sygsphere_conversation(
      direct_link_request,
      original_link_id,
      client_one,
      direct_conversation,
      'A link request UUID cannot be reused for unlinking.'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied and exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.id = original_link_id
      and link.unlinked_at is null
  ), 'A link request UUID cannot cross into an unlink operation or mutate its generation.';

  denied := false;
  begin
    perform public.link_client_sygsphere_conversation(
      direct_link_request,
      client_two,
      direct_conversation,
      'Dispatch and site operations'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied,
    'A link request UUID remains bound to its original Client File.';

  denied := false;
  begin
    perform public.link_client_sygsphere_conversation(
      direct_link_request,
      client_one,
      nonowner_conversation,
      'Dispatch and site operations'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied,
    'A link request UUID remains bound to its original conversation.';

  workspace := public.list_client_communications(null);
  assert jsonb_array_length(workspace -> 'rows') = 1
    and workspace #>> '{rows,0,conversationId}' = direct_conversation::text,
    'The global inbox is bounded to links for conversations in which the actor is a current member.';

  workspace := public.list_client_communications(null, 'Communications One', 1, 10);
  assert jsonb_array_length(workspace -> 'rows') = 1
    and (workspace #>> '{pagination,totalCount}')::integer = 1,
    'The global inbox search is performed by the bounded server RPC.';

  workspace := public.get_client_communication_for_conversation(direct_conversation);
  assert workspace #>> '{communication,conversationId}' = direct_conversation::text
    and workspace #>> '{communication,clientId}' = client_one::text,
    'A conversation-specific lookup returns only its active authorized association.';

  denied := false;
  begin
    perform public.link_client_sygsphere_conversation(
      conflicting_link_request,
      client_two,
      direct_conversation,
      'Second client should be rejected'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied,
    'One conversation cannot have two active authoritative Client File links.';

  workspace := public.link_client_sygsphere_conversation(
    nonowner_link_request,
    client_one,
    nonowner_conversation,
    'Current participant authority proof'
  );
  assert exists (
    select 1
    from jsonb_array_elements(workspace -> 'rows') communication_row
    where communication_row ->> 'conversationId' = nonowner_conversation::text
  ), 'Current membership plus exact management permission can create a link without immutable ownership.';

  select (communication_row ->> 'linkId')::uuid
  into nonowner_link_id
  from jsonb_array_elements(workspace -> 'rows') communication_row
  where communication_row ->> 'conversationId' = nonowner_conversation::text;

  workspace := public.unlink_client_sygsphere_conversation(
    nonowner_unlink_request,
    nonowner_link_id,
    client_one,
    nonowner_conversation,
    'Rollback-only current participant authority proof.'
  );
  assert not exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.conversation_id = nonowner_conversation
      and link.unlinked_at is null
  ), 'A current non-owner participant with exact management permission can retire the link.';

  workspace := public.link_client_sygsphere_conversation(
    same_client_noop_request,
    client_one,
    direct_conversation,
    'A replay does not rewrite the first purpose'
  );
  assert workspace #>> '{rows,0,linkId}' = original_link_id::text
    and workspace #>> '{rows,0,purpose}' = 'Dispatch and site operations',
    'A separately keyed same-client no-op does not rewrite the original link history.';

  workspace := public.link_client_sygsphere_conversation(
    same_client_noop_request,
    client_one,
    direct_conversation,
    'A replay does not rewrite the first purpose'
  );
  assert workspace #>> '{rows,0,linkId}' = original_link_id::text and exists (
    select 1
    from private.client_sygsphere_conversation_requests request
    where request.request_id = same_client_noop_request
      and request.link_id = original_link_id
      and request.outcome = 'already_linked'
  ), 'An accepted no-op retry is remembered without creating another link generation.';

  insert into public.employee_permission_overrides (
    employee_id,
    permission_code,
    effect,
    reason,
    active,
    created_by
  )
  values
    (
      participant_employee,
      'clients.view',
      'grant',
      'Rollback-only Client Files access proof.',
      true,
      manager_employee
    ),
    (
      participant_employee,
      'clients.communications.view',
      'grant',
      'Rollback-only membership intersection proof.',
      true,
      manager_employee
    ),
    (
      outsider_employee,
      'clients.view',
      'grant',
      'Rollback-only Client Files access proof.',
      true,
      manager_employee
    ),
    (
      outsider_employee,
      'clients.communications.view',
      'grant',
      'Rollback-only nonmember isolation proof.',
      true,
      manager_employee
    );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', participant_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', participant_auth::text, true);
  workspace := public.list_client_communications(null);
  assert jsonb_array_length(workspace -> 'rows') = 1
    and workspace #>> '{rows,0,conversationName}' = 'Client Manager'
    and not coalesce((workspace #>> '{actor,canManage}')::boolean, false)
    and not coalesce((workspace #>> '{rows,0,owner}')::boolean, true),
    'A view-only participant sees the linked conversation with the opposite direct name but cannot manage it.';

  workspace := public.get_client_communication_for_conversation(direct_conversation);
  assert workspace #>> '{communication,conversationId}' = direct_conversation::text,
    'A view-authorized current participant can resolve the association for the open conversation.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', outsider_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', outsider_auth::text, true);
  workspace := public.list_client_communications(null);
  assert jsonb_array_length(workspace -> 'rows') = 0,
    'Exact view permission does not reveal a linked conversation to a nonmember.';

  workspace := public.get_client_communication_for_conversation(direct_conversation);
  assert workspace -> 'communication' = 'null'::jsonb,
    'The conversation-specific lookup does not reveal an association to a nonmember.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  denied := false;
  begin
    perform public.unlink_client_sygsphere_conversation(
      short_unlink_request,
      original_link_id,
      client_one,
      direct_conversation,
      'no'
    );
  exception when check_violation then
    denied := true;
  end;
  assert denied, 'An unlink requires a meaningful audit reason.';

  workspace := public.unlink_client_sygsphere_conversation(
    direct_unlink_request,
    original_link_id,
    client_one,
    direct_conversation,
    'The conversation was linked to the wrong Client File.'
  );
  assert jsonb_array_length(workspace -> 'rows') = 0,
    'Unlink retires the active association from the Client Communications list.';

  workspace := public.unlink_client_sygsphere_conversation(
    direct_unlink_request,
    original_link_id,
    client_one,
    direct_conversation,
    'The conversation was linked to the wrong Client File.'
  );
  assert jsonb_array_length(workspace -> 'rows') = 0 and (
    select count(*)
    from private.client_sygsphere_conversation_requests request
    where request.request_id = direct_unlink_request
      and request.link_id = original_link_id
      and request.outcome = 'unlinked'
  ) = 1, 'An immediate unlink retry is a successful no-op with one durable request receipt.';

  denied := false;
  begin
    perform public.unlink_client_sygsphere_conversation(
      direct_unlink_request,
      original_link_id,
      client_one,
      direct_conversation,
      'A reused unlink request cannot change its audit reason.'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied and (
    select link.unlink_reason
    from private.client_sygsphere_conversation_links link
    where link.id = original_link_id
  ) = 'The conversation was linked to the wrong Client File.',
    'An unlink request UUID remains bound to its original normalized reason.';

  workspace := public.list_client_communication_candidates(
    client_one,
    'Client Participant',
    1,
    10
  );
  assert jsonb_array_length(workspace -> 'rows') = 1
    and workspace #>> '{rows,0,conversationId}' = direct_conversation::text,
    'The retired conversation is independently available from the bounded candidate RPC.';

  assert exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.id = original_link_id
      and link.unlinked_by = manager_employee
      and link.unlinked_at is not null
      and link.unlink_reason = 'The conversation was linked to the wrong Client File.'
  ), 'The retired link preserves actor, time, and reason.';

  workspace := public.link_client_sygsphere_conversation(
    direct_link_request,
    client_one,
    direct_conversation,
    'Dispatch and site operations'
  );
  assert jsonb_array_length(workspace -> 'rows') = 0 and not exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.conversation_id = direct_conversation
      and link.unlinked_at is null
  ) and (
    select count(*)
    from private.client_sygsphere_conversation_links link
    where link.conversation_id = direct_conversation
  ) = 1, 'A delayed replay of the original link request cannot resurrect a retired generation.';

  workspace := public.link_client_sygsphere_conversation(
    replacement_link_request,
    client_one,
    direct_conversation,
    'Replacement client operations'
  );
  replacement_link_id := (workspace #>> '{rows,0,linkId}')::uuid;
  assert replacement_link_id <> original_link_id
    and workspace #>> '{rows,0,clientId}' = client_one::text,
    'A new request ID creates a distinct replacement link generation.';

  denied := false;
  begin
    perform public.unlink_client_sygsphere_conversation(
      direct_unlink_request,
      replacement_link_id,
      client_one,
      direct_conversation,
      'The conversation was linked to the wrong Client File.'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied and exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.id = replacement_link_id
      and link.unlinked_at is null
  ), 'An unlink request UUID remains bound to the exact original link generation.';

  workspace := public.unlink_client_sygsphere_conversation(
    direct_unlink_request,
    original_link_id,
    client_one,
    direct_conversation,
    'The conversation was linked to the wrong Client File.'
  );
  assert workspace #>> '{rows,0,linkId}' = replacement_link_id::text and exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.id = replacement_link_id
      and link.unlinked_at is null
  ), 'A delayed replay of the original unlink request cannot retire a later link generation.';

  denied := false;
  begin
    perform public.link_client_sygsphere_conversation(
      direct_link_request,
      client_one,
      direct_conversation,
      'A reused request ID cannot change payloads'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied,
    'A request UUID cannot be reused by a different normalized payload.';

  denied := false;
  begin
    perform public.unlink_client_sygsphere_conversation(
      stale_unlink_request,
      original_link_id,
      client_one,
      direct_conversation,
      'A stale generation must not affect its replacement.'
    );
  exception when no_data_found then
    denied := true;
  end;
  assert denied and exists (
    select 1
    from private.client_sygsphere_conversation_links link
    where link.id = replacement_link_id
      and link.unlinked_at is null
  ), 'A new unlink request aimed at a retired generation cannot retire the active replacement.';

  workspace := public.unlink_client_sygsphere_conversation(
    replacement_unlink_request,
    replacement_link_id,
    client_one,
    direct_conversation,
    'The replacement link is being reassigned to another Client File.'
  );
  assert jsonb_array_length(workspace -> 'rows') = 0,
    'The exact replacement generation can be retired by a new unlink request.';

  workspace := public.link_client_sygsphere_conversation(
    reassignment_link_request,
    client_two,
    direct_conversation,
    'Reassigned client operations'
  );
  assert jsonb_array_length(workspace -> 'rows') = 1
    and workspace #>> '{rows,0,clientId}' = client_two::text,
    'A conversation may be linked to a different client only after the prior link is audit-safely retired.';

  assert (
    select count(*)
    from private.client_sygsphere_conversation_links link
    where link.conversation_id = direct_conversation
  ) = 3 and (
    select count(*)
    from private.client_sygsphere_conversation_links link
    where link.conversation_id = direct_conversation
      and link.unlinked_at is null
  ) = 1, 'All link generations are preserved while exactly one active relationship remains.';

  assert (
    select count(*)
    from private.audit_events audit
    where audit.table_name = 'client_sygsphere_conversation_links'
      and audit.row_id in (
        select link.id::text
        from private.client_sygsphere_conversation_links link
        where link.conversation_id = direct_conversation
      )
      and audit.operation in (
        'CLIENT_SYGSPHERE_CONVERSATION_LINKED',
        'CLIENT_SYGSPHERE_CONVERSATION_UNLINKED'
      )
  ) = 5, 'Each state-changing link, unlink, relink, retirement, and reassignment leaves an explicit audit event.';

  assert (
    select count(*)
    from private.client_sygsphere_conversation_requests request
    where request.conversation_id = direct_conversation
  ) = 6 and not exists (
    select 1
    from private.client_sygsphere_conversation_requests request
    where request.request_id in (
      conflicting_link_request,
      short_unlink_request,
      stale_unlink_request
    )
  ), 'Every accepted direct-conversation request is remembered once while rejected requests leave no receipt.';

  perform public.set_access_role_permissions(
    guard_role_id,
    array['clients.communications.manage']::text[]
  );
  assert array[
    'clients.communications.manage',
    'clients.communications.view',
    'clients.manage',
    'clients.view'
  ]::text[] <@ (
    select coalesce(
      array_agg(role_permission.permission_code order by role_permission.permission_code),
      array[]::text[]
    )
    from public.access_role_permissions role_permission
    where role_permission.role_id = guard_role_id
      and role_permission.enabled
  ), 'A role save expands Client Communications management to every required dependency.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', participant_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', participant_auth::text, true);

  denied := false;
  begin
    perform public.link_client_sygsphere_conversation(
      direct_link_request,
      client_one,
      direct_conversation,
      'Dispatch and site operations'
    );
  exception when unique_violation then
    denied := true;
  end;
  assert denied and (
    select count(*)
    from private.client_sygsphere_conversation_requests request
    where request.request_id = direct_link_request
      and request.actor_id = manager_employee
  ) = 1, 'A request UUID remains bound to the employee who first completed it.';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', manager_auth,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );
  perform set_config('request.jwt.claim.sub', manager_auth::text, true);

  perform public.set_access_role_permissions(
    guard_role_id,
    array['clients.communications.view']::text[]
  );
  assert array[
    'clients.communications.view',
    'clients.view'
  ]::text[] <@ (
    select coalesce(
      array_agg(role_permission.permission_code order by role_permission.permission_code),
      array[]::text[]
    )
    from public.access_role_permissions role_permission
    where role_permission.role_id = guard_role_id
      and role_permission.enabled
  ) and not exists (
    select 1
    from public.access_role_permissions role_permission
    where role_permission.role_id = guard_role_id
      and role_permission.permission_code in (
        'clients.communications.manage',
        'clients.manage'
      )
      and role_permission.enabled
  ), 'A role save retains view dependencies without stale management permissions.';

  perform public.set_access_role_permissions(
    guard_role_id,
    array[]::text[]
  );
  assert not exists (
    select 1
    from public.access_role_permissions role_permission
    where role_permission.role_id = guard_role_id
      and role_permission.permission_code in (
        'clients.communications.view',
        'clients.communications.manage'
      )
      and role_permission.enabled
  ), 'Removing the base selection cannot leave stale Client Communications permissions persisted.';

  update private.employee_accounts
  set disabled_at = clock_timestamp()
  where employee_id = manager_employee;

  denied := false;
  begin
    perform public.list_client_communications(null);
  exception when insufficient_privilege then
    denied := true;
  end;
  assert denied, 'A disabled account cannot use Client Communications.';
end
$client_communications_behavior$;

rollback;

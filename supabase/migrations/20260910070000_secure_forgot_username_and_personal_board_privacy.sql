begin;

-- Signed-out username recovery stores only one-way request hashes. The raw email
-- is used only inside this service-role transaction and is never persisted.
create table if not exists private.employee_self_service_username_requests (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null,
  request_fingerprint_hash text not null,
  employee_id uuid references public.employees(id) on delete restrict,
  matched_account_count integer not null default 0,
  outcome text not null,
  request_id text,
  requested_at timestamptz not null default clock_timestamp(),
  constraint employee_self_service_username_email_hash_check
    check (email_hash ~ '^[a-f0-9]{64}$'),
  constraint employee_self_service_username_fingerprint_hash_check
    check (request_fingerprint_hash ~ '^[a-f0-9]{64}$'),
  constraint employee_self_service_username_account_count_check
    check (matched_account_count between 0 and 20),
  constraint employee_self_service_username_outcome_check
    check (outcome in ('claimed', 'not_eligible', 'rate_limited'))
);

create index if not exists employee_self_service_username_email_rate_idx
  on private.employee_self_service_username_requests (email_hash, requested_at desc);

create index if not exists employee_self_service_username_fingerprint_rate_idx
  on private.employee_self_service_username_requests (request_fingerprint_hash, requested_at desc);

alter table private.employee_self_service_username_requests enable row level security;
alter table private.employee_self_service_username_requests force row level security;

drop trigger if exists employee_self_service_username_requests_audit
  on private.employee_self_service_username_requests;
create trigger employee_self_service_username_requests_audit
after insert on private.employee_self_service_username_requests
for each row execute function private.write_audit_event();

drop trigger if exists employee_self_service_username_requests_append_only
  on private.employee_self_service_username_requests;
create trigger employee_self_service_username_requests_append_only
before update or delete on private.employee_self_service_username_requests
for each row execute function private.prevent_append_only_change();

create or replace function public.service_claim_self_service_username(
  target_email text,
  target_email_hash text,
  target_request_fingerprint_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(coalesce(target_email, '')));
  email_attempt_count integer;
  fingerprint_attempt_count integer;
  matching_employee_ids uuid[] := '{}'::uuid[];
  matching_usernames text[] := '{}'::text[];
  matching_display_names text[] := '{}'::text[];
  request_outcome text := 'not_eligible';
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if target_email_hash !~ '^[a-f0-9]{64}$'
    or target_request_fingerprint_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Valid request hashes are required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('username-recovery-email:' || target_email_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('username-recovery-fingerprint:' || target_request_fingerprint_hash, 0));

  select count(*)::integer
  into email_attempt_count
  from private.employee_self_service_username_requests request
  where request.email_hash = target_email_hash
    and request.requested_at >= clock_timestamp() - interval '1 hour';

  select count(*)::integer
  into fingerprint_attempt_count
  from private.employee_self_service_username_requests request
  where request.request_fingerprint_hash = target_request_fingerprint_hash
    and request.requested_at >= clock_timestamp() - interval '15 minutes';

  if email_attempt_count >= 3 or fingerprint_attempt_count >= 10 then
    request_outcome := 'rate_limited';
  elsif length(normalized_email) between 3 and 254
    and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    select
      coalesce(array_agg(match.employee_id order by match.username), '{}'::uuid[]),
      coalesce(array_agg(match.username order by match.username), '{}'::text[]),
      coalesce(array_agg(match.display_name order by match.username), '{}'::text[])
    into matching_employee_ids, matching_usernames, matching_display_names
    from (
      select
        employee.id as employee_id,
        employee.username,
        btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) as display_name
      from public.employees employee
      join private.employee_accounts account
        on account.employee_id = employee.id
       and account.disabled_at is null
       and account.auth_user_id is not null
      join private.employee_contacts contact on contact.employee_id = employee.id
      where employee.status = 'active'
        and employee.username ~ '^[a-z][a-z0-9]{1,62}$'
        and lower(private.preferred_delivery_email(contact.personal_email, contact.company_email)) = normalized_email
      order by employee.username
      limit 20
    ) match;

    if cardinality(matching_usernames) > 0 then
      request_outcome := 'claimed';
    end if;
  end if;

  insert into private.employee_self_service_username_requests (
    email_hash,
    request_fingerprint_hash,
    employee_id,
    matched_account_count,
    outcome,
    request_id
  ) values (
    target_email_hash,
    target_request_fingerprint_hash,
    case when request_outcome = 'claimed' then matching_employee_ids[1] else null end,
    case when request_outcome = 'claimed' then cardinality(matching_usernames) else 0 end,
    request_outcome,
    nullif(btrim(target_request_id), '')
  );

  if request_outcome <> 'claimed' then
    return jsonb_build_object('eligible', false);
  end if;

  return jsonb_build_object(
    'eligible', true,
    'employeeId', matching_employee_ids[1],
    'contactEmail', normalized_email,
    'displayName', case when cardinality(matching_display_names) = 1 then matching_display_names[1] else 'SygShift user' end,
    'usernames', to_jsonb(matching_usernames)
  );
end
$$;

comment on function public.service_claim_self_service_username(text, text, text, text) is
  'Service-only, rate-limited, enumeration-safe recovery of active SygShift usernames by approved employee email. Raw emails and request fingerprints are never persisted.';

revoke all on table private.employee_self_service_username_requests from public, anon, authenticated;
revoke all on function public.service_claim_self_service_username(text, text, text, text) from public, anon, authenticated;
grant execute on function public.service_claim_self_service_username(text, text, text, text) to service_role;

-- A personal board belongs only to its owner. Even companywide task managers
-- cannot discover or open another employee's personal board or its tasks.
create or replace function private.sygtasks_can_view_board(
  target_employee_id uuid,
  target_board_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from private.sygtasks_boards board
    where board.id = target_board_id
      and (
        board.owner_employee_id = target_employee_id
        or (
          board.scope <> 'personal'
          and (
            private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
            or (
              board.scope = 'company'
              and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
            )
            or (
              board.scope = 'team'
              and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
              and (
                exists (
                  select 1
                  from private.sygtasks_board_memberships membership
                  where membership.board_id = board.id
                    and membership.employee_id = target_employee_id
                    and membership.removed_at is null
                )
                or exists (
                  select 1
                  from private.sygtasks_tasks task
                  join private.sygtasks_task_assignees assignee
                    on assignee.task_id = task.id
                   and assignee.employee_id = target_employee_id
                   and assignee.removed_at is null
                  where task.board_id = board.id
                    and task.archived_at is null
                )
                or exists (
                  select 1
                  from private.sygtasks_tasks task
                  join private.sygtasks_task_watchers watcher
                    on watcher.task_id = task.id
                   and watcher.employee_id = target_employee_id
                   and watcher.removed_at is null
                  where task.board_id = board.id
                    and task.archived_at is null
                )
              )
            )
          )
        )
      )
  ), false)
$$;

create or replace function private.sygtasks_can_view_task(
  target_employee_id uuid,
  target_task_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from private.sygtasks_tasks task
    join private.sygtasks_boards board on board.id = task.board_id
    where task.id = target_task_id
      and (
        board.owner_employee_id = target_employee_id
        or (
          board.scope <> 'personal'
          and (
            private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
            or (
              board.scope = 'company'
              and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
            )
            or (
              board.scope = 'team'
              and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
              and (
                exists (
                  select 1
                  from private.sygtasks_board_memberships membership
                  where membership.board_id = board.id
                    and membership.employee_id = target_employee_id
                    and membership.removed_at is null
                )
                or exists (
                  select 1
                  from private.sygtasks_task_assignees assignee
                  where assignee.task_id = task.id
                    and assignee.employee_id = target_employee_id
                    and assignee.removed_at is null
                )
                or exists (
                  select 1
                  from private.sygtasks_task_watchers watcher
                  where watcher.task_id = task.id
                    and watcher.employee_id = target_employee_id
                    and watcher.removed_at is null
                )
              )
            )
          )
        )
      )
  ), false)
$$;

create or replace function private.sygtasks_can_edit_board_tasks(
  target_employee_id uuid,
  target_board_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from private.sygtasks_boards board
    where board.id = target_board_id
      and (
        (board.scope = 'personal' and board.owner_employee_id = target_employee_id)
        or (
          board.scope <> 'personal'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.manage')
        )
        or (
          board.scope = 'team'
          and private.sygtasks_has_permission(target_employee_id, 'tasks.view')
          and exists (
            select 1
            from private.sygtasks_board_memberships membership
            where membership.board_id = board.id
              and membership.employee_id = target_employee_id
              and membership.member_role in ('owner', 'editor', 'member')
              and membership.removed_at is null
          )
        )
      )
  ), false)
$$;

create or replace function private.sygtasks_can_update_task_status(
  target_employee_id uuid,
  target_task_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.sygtasks_can_view_task(target_employee_id, target_task_id)
    and (
      private.sygtasks_can_edit_board_tasks(
        target_employee_id,
        (select task.board_id from private.sygtasks_tasks task where task.id = target_task_id)
      )
      or exists (
        select 1
        from private.sygtasks_task_assignees assignee
        where assignee.task_id = target_task_id
          and assignee.employee_id = target_employee_id
          and assignee.removed_at is null
      )
    ),
    false
  )
$$;

create or replace function private.sygtasks_signal_scope(
  target_board_id uuid,
  target_task_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare recipient record;
begin
  for recipient in
    with board_record as (
      select board.id, board.scope, board.owner_employee_id
      from private.sygtasks_boards board
      where board.id = target_board_id
    ),
    recipients as (
      select board.owner_employee_id as employee_id from board_record board
      union
      select membership.employee_id
      from private.sygtasks_board_memberships membership
      where membership.board_id = target_board_id
        and membership.removed_at is null
      union
      select assignee.employee_id
      from private.sygtasks_task_assignees assignee
      join private.sygtasks_tasks task on task.id = assignee.task_id
      where task.board_id = target_board_id
        and (target_task_id is null or task.id = target_task_id)
        and assignee.removed_at is null
      union
      select watcher.employee_id
      from private.sygtasks_task_watchers watcher
      join private.sygtasks_tasks task on task.id = watcher.task_id
      where task.board_id = target_board_id
        and (target_task_id is null or task.id = target_task_id)
        and watcher.removed_at is null
      union
      select employee.id
      from board_record board
      join public.employees employee on employee.status = 'active'
      where board.scope <> 'personal'
        and private.sygtasks_has_permission(employee.id, 'tasks.manage')
      union
      select employee.id
      from board_record board
      join public.employees employee on employee.status = 'active'
      where board.scope = 'company'
        and (
          private.sygtasks_has_permission(employee.id, 'tasks.view')
          or private.sygtasks_has_permission(employee.id, 'tasks.manage')
        )
    )
    select distinct employee.id
    from recipients recipient_scope
    join public.employees employee on employee.id = recipient_scope.employee_id
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and account.disabled_at is null
      and case
        when target_task_id is null then private.sygtasks_can_view_board(employee.id, target_board_id)
        else private.sygtasks_can_view_task(employee.id, target_task_id)
      end
  loop
    perform private.signal_employee_update(
      recipient.id,
      jsonb_build_object(
        'kind', 'sygtasks',
        'boardId', target_board_id,
        'taskId', target_task_id
      )
    );
  end loop;
end
$$;

create or replace function private.sygtasks_notify(
  target_recipient_employee_id uuid,
  target_actor_employee_id uuid,
  target_client_request_id uuid,
  target_board_id uuid,
  target_task_id uuid,
  target_title text,
  target_body text,
  target_priority text default 'routine'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare created_notification_id uuid;
begin
  if target_recipient_employee_id is null
     or target_recipient_employee_id = target_actor_employee_id
     or case
       when target_task_id is null then not private.sygtasks_can_view_board(target_recipient_employee_id, target_board_id)
       else not private.sygtasks_can_view_task(target_recipient_employee_id, target_task_id)
     end
     or not exists (
       select 1
       from public.employees employee
       join private.employee_accounts account on account.employee_id = employee.id
       where employee.id = target_recipient_employee_id
         and employee.status = 'active'
         and account.disabled_at is null
     )
  then
    return null;
  end if;

  created_notification_id := private.create_employee_notification(
    target_recipient_employee_id,
    'sygtasks',
    coalesce(target_task_id, target_board_id),
    concat('sygtasks:', target_actor_employee_id, ':', target_client_request_id, ':', target_recipient_employee_id),
    left(btrim(target_title), 200),
    left(btrim(target_body), 5000),
    case when target_priority in ('routine', 'important', 'urgent') then target_priority else 'routine' end,
    false,
    concat(
      '/tasks?board=', target_board_id,
      case when target_task_id is null then '' else concat('&task=', target_task_id) end
    ),
    case when target_task_id is null then 'Open board' else 'Open task' end,
    target_actor_employee_id
  );

  return created_notification_id;
end
$$;

create or replace function private.enforce_sygtasks_personal_board_owner_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id();
begin
  if old.scope = 'personal'
     and (select auth.role()) <> 'service_role'
     and actor_id is distinct from old.owner_employee_id
  then
    raise insufficient_privilege using message = 'Only the owner can change a personal SygTasks board.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

drop trigger if exists sygtasks_personal_board_owner_write on private.sygtasks_boards;
create trigger sygtasks_personal_board_owner_write
before update or delete on private.sygtasks_boards
for each row execute function private.enforce_sygtasks_personal_board_owner_write();

create or replace function private.enforce_sygtasks_personal_relationship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  relationship_record record;
  relationship_board_id uuid;
  personal_owner_id uuid;
  actor_id uuid := private.current_employee_id();
begin
  if tg_op = 'DELETE' then
    relationship_record := old;
  else
    relationship_record := new;
  end if;

  if tg_table_name = 'sygtasks_board_memberships' then
    relationship_board_id := relationship_record.board_id;
  else
    select task.board_id into relationship_board_id
    from private.sygtasks_tasks task
    where task.id = relationship_record.task_id;
  end if;

  select board.owner_employee_id into personal_owner_id
  from private.sygtasks_boards board
  where board.id = relationship_board_id
    and board.scope = 'personal';

  if personal_owner_id is not null
     and (select auth.role()) <> 'service_role'
     and (
       actor_id is distinct from personal_owner_id
       or relationship_record.employee_id is distinct from personal_owner_id
     )
  then
    raise insufficient_privilege using message = 'A personal SygTasks board is limited to its owner.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

drop trigger if exists sygtasks_personal_membership_owner_only on private.sygtasks_board_memberships;
create trigger sygtasks_personal_membership_owner_only
before insert or update or delete on private.sygtasks_board_memberships
for each row execute function private.enforce_sygtasks_personal_relationship();

drop trigger if exists sygtasks_personal_assignee_owner_only on private.sygtasks_task_assignees;
create trigger sygtasks_personal_assignee_owner_only
before insert or update or delete on private.sygtasks_task_assignees
for each row execute function private.enforce_sygtasks_personal_relationship();

drop trigger if exists sygtasks_personal_watcher_owner_only on private.sygtasks_task_watchers;
create trigger sygtasks_personal_watcher_owner_only
before insert or update or delete on private.sygtasks_task_watchers
for each row execute function private.enforce_sygtasks_personal_relationship();

revoke all on function private.sygtasks_can_view_board(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_can_view_task(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_can_edit_board_tasks(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_can_update_task_status(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_signal_scope(uuid, uuid) from public, anon, authenticated;
revoke all on function private.sygtasks_notify(uuid, uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.enforce_sygtasks_personal_board_owner_write() from public, anon, authenticated;
revoke all on function private.enforce_sygtasks_personal_relationship() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

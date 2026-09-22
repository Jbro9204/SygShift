begin;

-- Reconciliation snapshots are intentionally expensive because they rebuild
-- schedule, punch, gap, and coverage evidence. The list workspace previously
-- rebuilt that evidence for every occurrence before rendering a single row,
-- which could exceed the authenticated API statement timeout. Keep the list
-- complete, but load one reconciliation only when its review is opened.
do $lightweight_accountability_workspace$
declare
  function_definition text;
  expensive_call constant text := 'private.get_accountability_reconciliation_group_snapshot(coalesce(native_event.shift_id, legacy_call_off.shift_id))';
begin
  select pg_get_functiondef('public.get_accountability_workspace(date,date)'::regprocedure)
  into function_definition;

  if function_definition is null or position(expensive_call in function_definition) = 0 then
    raise exception 'The Accountability workspace reconciliation contract was not found.';
  end if;

  execute replace(function_definition, expensive_call, 'null::jsonb');
end
$lightweight_accountability_workspace$;

create or replace function public.get_accountability_event_reconciliation(target_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift_id uuid;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
     or not public.has_any_effective_permission(array['accountability.view', 'accountability.manage']) then
    raise insufficient_privilege using message = 'Accountability workspace permission with MFA is required.';
  end if;

  select event.shift_id
  into target_shift_id
  from public.attendance_accountability_events event
  where event.id = target_event_id;

  if not found then
    select call_off.shift_id
    into target_shift_id
    from public.call_off_reports call_off
    where call_off.id = target_event_id;
  end if;

  if target_shift_id is null then
    return null;
  end if;

  return private.get_accountability_reconciliation_group_snapshot(target_shift_id);
end
$$;

revoke all on function public.get_accountability_event_reconciliation(uuid) from public, anon;
grant execute on function public.get_accountability_event_reconciliation(uuid) to authenticated;

comment on function public.get_accountability_event_reconciliation(uuid) is
  'Loads one protected schedule-versus-time reconciliation when an authorized reviewer opens an Accountability occurrence.';

commit;

begin;

-- Restore the effective-permission contract reviewed on 08/21/2026.
-- Only this function's authorization condition and denial message may change.
-- No employee, permission, punch, correction, schedule or payroll row is edited.
do $time_correction_permission_repair$
declare
  target_oid oid := to_regprocedure(
    'public.supervisor_correct_time_event_details(uuid,timestamptz,public.time_event_kind,boolean,text)'
  );
  before_definition text;
  after_definition text;
  before_metadata jsonb;
  after_metadata jsonb;
  old_guard constant text := $old_guard$  if not public.is_supervisor_or_admin() or not public.has_mfa() then$old_guard$;
  new_guard constant text := $new_guard$  if public.has_mfa() is not true
    or public.has_any_effective_permission(array['time.manage', 'time.manual_entry.edit']) is not true
  then$new_guard$;
  old_message constant text := 'Operations access with MFA is required to maintain employee time.';
  new_message constant text := 'Time correction permission with MFA is required to maintain employee time.';
begin
  if target_oid is null
    or to_regprocedure('public.has_any_effective_permission(text[])') is null
  then
    raise exception 'Time-correction permission repair dependencies are missing.';
  end if;

  select pg_get_functiondef(procedure.oid), to_jsonb(procedure) - 'prosrc'
    into before_definition, before_metadata
    from pg_proc procedure where procedure.oid = target_oid;

  if md5(before_definition) = '314077c4569f01d5fd2a76769d9c5d9d' then
    return;
  end if;
  if md5(before_definition) is distinct from 'f02c97cb8c2623ccbdc31b0d29646b22' then
    raise exception 'Time-correction definition changed after review; repair refused.';
  end if;
  if (length(before_definition) - length(replace(before_definition, old_guard, ''))) / length(old_guard) <> 1
    or (length(before_definition) - length(replace(before_definition, old_message, ''))) / length(old_message) <> 1
  then
    raise exception 'Time-correction authorization fragment differs from the reviewed function.';
  end if;

  after_definition := replace(replace(before_definition, old_guard, new_guard), old_message, new_message);
  if md5(after_definition) is distinct from '314077c4569f01d5fd2a76769d9c5d9d' then
    raise exception 'Time-correction repair would change an unreviewed function fragment.';
  end if;
  execute after_definition;

  select pg_get_functiondef(procedure.oid), to_jsonb(procedure) - 'prosrc'
    into after_definition, after_metadata
    from pg_proc procedure where procedure.oid = target_oid;
  if md5(after_definition) is distinct from '314077c4569f01d5fd2a76769d9c5d9d'
    or after_metadata is distinct from before_metadata
  then
    raise exception 'Time-correction permission repair failed its definition or security-metadata postcondition.';
  end if;
end
$time_correction_permission_repair$;

commit;

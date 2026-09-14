begin;

-- Keep the Request Center's client capability aligned with the same effective
-- permission used by the preserved request payload. A role name alone must
-- not expose manager controls to an account whose permission was removed.
create or replace function public.get_request_center_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  payload := private.get_request_center_payload_pre_absence_completion();

  return payload || jsonb_build_object(
    'permissions', jsonb_build_object(
      'canManage', public.has_effective_permission('requests.manage')
    )
  );
end
$$;

revoke all on function public.get_request_center_payload() from public, anon;
grant execute on function public.get_request_center_payload() to authenticated;

-- Preserve the audited reclassification implementation, but do not return an
-- old linked call-off as a new coverage handoff when the corrected type is no
-- longer an absence. The historical link remains for audit integrity.
alter function public.reclassify_attendance_accountability_event(uuid, text, text)
  rename to reclassify_attendance_accountability_event_pre_contract_hardening;
alter function public.reclassify_attendance_accountability_event_pre_contract_hardening(uuid, text, text)
  set schema private;

revoke all on function private.reclassify_attendance_accountability_event_pre_contract_hardening(uuid, text, text)
  from public, anon, authenticated;

create function public.reclassify_attendance_accountability_event(
  target_event_id uuid,
  target_event_type text,
  target_reason text
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
  result := private.reclassify_attendance_accountability_event_pre_contract_hardening(
    target_event_id,
    target_event_type,
    target_reason
  );

  if target_event_type not in ('called_in_sick', 'call_off', 'no_call_no_show') then
    result := result || jsonb_build_object(
      'callOffId', null,
      'coverageRequired', false
    );
  end if;

  return result;
end
$$;

revoke all on function public.reclassify_attendance_accountability_event(uuid, text, text)
  from public, anon;
grant execute on function public.reclassify_attendance_accountability_event(uuid, text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;

-- Keep the coverage candidate contract total: SQL boolean expressions that
-- include nullable employee metadata must never escape as JSON null.
create or replace function private.shift_coverage_candidate_payload(
  target_shift_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  shift_record public.shifts%rowtype;
  employee_record public.employees%rowtype;
  availability_conflict uuid;
  overlap_conflict jsonb;
  overtime jsonb;
  armed_ready boolean := true;
  already_assigned boolean := false;
  eligible boolean := false;
  block_reason text;
begin
  select * into shift_record
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null;

  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id and employee.status = 'active';

  if shift_record.id is null or employee_record.id is null then
    return null;
  end if;

  availability_conflict := private.assignment_availability_conflict(
    employee_record.id, shift_record.starts_at, shift_record.ends_at, shift_record.time_zone
  );
  overlap_conflict := private.assignment_overlap_conflict(null, shift_record.id, employee_record.id);
  overtime := private.scheduled_overtime_preview(shift_record.id, employee_record.id);
  select exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = shift_record.id
      and assignment.employee_id = employee_record.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) into already_assigned;
  if shift_record.requires_armed then
    armed_ready := public.has_valid_credential(
      employee_record.id,
      'armed_guard'::public.credential_kind,
      (shift_record.starts_at at time zone shift_record.time_zone)::date
    );
  end if;

  eligible := employee_record.role = 'guard'
    and not already_assigned
    and availability_conflict is null
    and overlap_conflict is null
    and armed_ready;

  block_reason := case
    when employee_record.role <> 'guard' then 'This employee is not assigned the Guard role.'
    when already_assigned then 'This guard is already assigned to the original shift.'
    when availability_conflict is not null then 'Approved unavailability overlaps this shift.'
    when overlap_conflict is not null then 'Another active assignment overlaps this shift.'
    when not armed_ready then 'The required armed credential is not active for this date.'
    when coalesce((overtime ->> 'requiresOverride')::boolean, false) then 'This assignment would create scheduled overtime.'
    else null
  end;

  return jsonb_build_object(
    'id', employee_record.id,
    'name', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
    'employeeNumber', employee_record.employee_number,
    'employmentType', employee_record.employment_type,
    'workClassification', employee_record.work_classification,
    'isFlex',
      coalesce(employee_record.employment_type = 'flex', false)
      or coalesce(lower(btrim(employee_record.work_classification)) = 'flex', false),
    'available', availability_conflict is null,
    'noOverlap', overlap_conflict is null,
    'armedReady', armed_ready,
    'overtimeMinutes', coalesce((overtime ->> 'overtimeMinutes')::integer, 0),
    'requiresOvertimeApproval', coalesce((overtime ->> 'requiresOverride')::boolean, false),
    'eligible', eligible,
    'recommended', eligible and not coalesce((overtime ->> 'requiresOverride')::boolean, false),
    'blockReason', block_reason
  );
end
$$;

revoke all on function private.shift_coverage_candidate_payload(uuid, uuid)
from public, anon, authenticated;

comment on function private.shift_coverage_candidate_payload(uuid, uuid) is
  'Builds a protected coverage candidate evaluation with a non-null isFlex boolean.';

do $$
begin
  if not exists (
    select 1
    from pg_proc procedure
    where procedure.oid = 'private.shift_coverage_candidate_payload(uuid,uuid)'::regprocedure
      and procedure.prosecdef
      and coalesce(procedure.proconfig, array[]::text[]) @> array['search_path=""']
  ) then
    raise exception 'Coverage candidate helper must remain security definer with an empty search path.';
  end if;
end
$$;

do $$
declare
  target_employee_id uuid;
  target_shift_id uuid;
  candidate_payload jsonb;
begin
  select employee.id
  into target_employee_id
  from public.employees employee
  where employee.status = 'active'
    and employee.role = 'guard'
  order by
    case when employee.work_classification is null then 0 else 1 end,
    employee.id
  limit 1;

  select shift.id
  into target_shift_id
  from public.shifts shift
  where shift.canceled_at is null
  order by shift.starts_at desc, shift.id
  limit 1;

  if target_employee_id is not null and target_shift_id is not null then
    candidate_payload := private.shift_coverage_candidate_payload(
      target_shift_id,
      target_employee_id
    );
    if candidate_payload is null
       or jsonb_typeof(candidate_payload -> 'isFlex') <> 'boolean' then
      raise exception 'Coverage candidate migration did not produce a JSON boolean isFlex value.';
    end if;
  end if;
end
$$;

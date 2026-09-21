begin;

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
    and employee.employment_type <> 'flex'
    and employee.work_classification is null
  order by employee.id
  limit 1;

  select shift.id
  into target_shift_id
  from public.shifts shift
  where shift.canceled_at is null
  order by shift.starts_at desc, shift.id
  limit 1;

  if target_employee_id is null then
    raise exception 'An active non-Flex guard with a null work classification is required for this regression.';
  end if;
  if target_shift_id is null then
    raise exception 'A shift is required for the coverage candidate regression.';
  end if;

  candidate_payload := private.shift_coverage_candidate_payload(
    target_shift_id,
    target_employee_id
  );

  if candidate_payload is null then
    raise exception 'The coverage candidate helper did not return a payload.';
  end if;
  if jsonb_typeof(candidate_payload -> 'isFlex') <> 'boolean' then
    raise exception 'Coverage isFlex must be a JSON boolean, got %.',
      jsonb_typeof(candidate_payload -> 'isFlex');
  end if;
  if (candidate_payload ->> 'isFlex')::boolean then
    raise exception 'A non-Flex guard with no work classification was incorrectly marked Flex.';
  end if;

  raise notice 'Coverage candidate isFlex is a non-null false boolean for nullable employee metadata.';
end
$$;

rollback;

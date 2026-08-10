begin;

create or replace function private.enrich_payroll_export_work_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_work_type text := 'post';
  work_type_count integer := 0;
  pay_code_record private.payroll_pay_codes%rowtype;
begin
  select
    count(distinct private.effective_time_event_work_type(event.id)),
    min(private.effective_time_event_work_type(event.id))
  into work_type_count, effective_work_type
  from public.time_events event
  where event.employee_id = new.employee_id
    and event.shift_id is not distinct from new.shift_id
    and (coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
      order by correction.approved_at desc, correction.created_at desc, correction.id desc
      limit 1
    ), event.recorded_at) at time zone 'America/Denver')::date = new.operational_date;

  if work_type_count > 1 then
    raise exception using
      errcode = '23514',
      message = 'Mixed Post and Training time must be resolved before payroll can be locked.';
  end if;

  effective_work_type := coalesce(effective_work_type, 'post');
  select code.* into pay_code_record
  from private.payroll_pay_codes code
  where code.work_type = effective_work_type;

  new.row_payload := new.row_payload || jsonb_build_object(
    'workType', effective_work_type,
    'workTypeLabel', pay_code_record.label,
    'payCode', pay_code_record.pay_code,
    'workTypePaid', pay_code_record.paid,
    'workTypeOvertimeEligible', pay_code_record.overtime_eligible,
    'workTypeRateSource', pay_code_record.rate_source
  );
  return new;
end;
$$;

revoke all on function private.enrich_payroll_export_work_type() from public, anon, authenticated;

comment on function private.enrich_payroll_export_work_type() is
  'Enriches immutable payroll export rows with one verified work classification and rejects mixed Post/Training rows at the database boundary.';

commit;

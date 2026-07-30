begin;

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'time.export_payroll', true
from public.access_roles access_role
where access_role.code = 'system_supervisor'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

create or replace function public.get_payroll_export_batch_detail(
  target_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  export_batch private.payroll_export_batches%rowtype;
  export_rows jsonb;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa()
    or not (
      public.is_supervisor_or_admin()
      or public.has_effective_permission('time.export_payroll')
    ) then
    raise insufficient_privilege using message = 'Payroll export permission with MFA is required to download locked payroll exports.';
  end if;

  if target_batch_id is null then
    raise check_violation using message = 'A payroll export batch is required.';
  end if;

  select *
    into export_batch
  from private.payroll_export_batches batch
  where batch.id = target_batch_id;

  if export_batch.id is null then
    raise no_data_found using message = 'The selected payroll export batch was not found.';
  end if;

  select coalesce(jsonb_agg(row_record.row_payload order by row_record.row_number), '[]'::jsonb)
    into export_rows
  from private.payroll_export_rows row_record
  where row_record.batch_id = export_batch.id;

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', export_batch.id,
      'fromDate', export_batch.from_date,
      'throughDate', export_batch.through_date,
      'createdAt', export_batch.created_at,
      'createdBy', export_batch.created_by,
      'createdByName', (
        select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
        from public.employees employee
        where employee.id = export_batch.created_by
      ),
      'rowCount', export_batch.row_count,
      'grossMinutes', export_batch.gross_minutes,
      'paidMinutes', export_batch.paid_minutes,
      'digest', export_batch.digest,
      'note', export_batch.note,
      'duplicate', false
    ),
    'rows', export_rows
  );
end
$$;

revoke all on function public.get_payroll_export_batch_detail(uuid) from public, anon;
grant execute on function public.get_payroll_export_batch_detail(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;

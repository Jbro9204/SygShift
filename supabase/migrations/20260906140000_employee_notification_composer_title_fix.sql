begin;

create or replace function public.get_notification_composer_options(target_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_id uuid := private.current_employee_id(); clean_search text := left(btrim(coalesce(target_search, '')), 120);
begin
  if actor_id is null or not (public.current_app_role() = 'admin' or public.has_effective_permission('notifications.manage')) or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified notification management permission is required.';
  end if;
  return jsonb_build_object(
    'employees', coalesce((select jsonb_agg(jsonb_build_object(
      'id', employee.id,
      'name', concat(coalesce(nullif(employee.preferred_name, ''), employee.first_name), ' ', employee.last_name),
      'role', employee.role::text,
      'title', employee.job_title
    ) order by employee.last_name, employee.first_name)
      from (select * from public.employees employee where employee.status = 'active'
        and (clean_search = '' or concat_ws(' ', employee.first_name, employee.preferred_name, employee.last_name, employee.username, employee.employee_number) ilike '%' || clean_search || '%')
        order by employee.last_name, employee.first_name limit 100) employee), '[]'::jsonb),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('code', role_name, 'label', initcap(replace(role_name, '_', ' ')), 'count', role_count) order by role_name)
      from (select employee.role::text role_name, count(*)::integer role_count from public.employees employee where employee.status = 'active' group by employee.role::text) role_counts), '[]'::jsonb),
    'canSendEveryone', public.current_app_role() = 'admin'
  );
end
$$;

revoke all on function public.get_notification_composer_options(text) from public, anon, authenticated;
grant execute on function public.get_notification_composer_options(text) to authenticated;

notify pgrst, 'reload schema';
commit;

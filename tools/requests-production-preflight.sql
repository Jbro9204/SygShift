-- Read-only. Report route staffing and security posture, never ticket or employee content.
begin read only;
set local statement_timeout = '12s';

with categories(category) as (values
  ('technical'), ('account_access'), ('payroll'), ('human_resources'), ('benefits_leave'),
  ('training_compliance'), ('schedule'), ('timekeeping'), ('site_post'), ('equipment'),
  ('safety'), ('client_request'), ('other')
), routes as (
  select category, private.support_route_permission(category, false) as permission from categories
), staff as materialized (
  select distinct employee.id, employee.role, private.employee_effective_permissions(employee.id) as grants
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id and account.disabled_at is null
  where employee.status = 'active'
)
select route.category, route.permission,
  (select count(*) from staff where route.permission = any(grants)
    and 'apps.sygilant.access' = any(grants) and 'apps.sygshift.access' = any(grants)
    and 'support.tickets.view' = any(grants) and 'support.tickets.manage' = any(grants)
    and (route.category not in ('technical','account_access') or 'sygcurit.workspace.view' = any(grants)
      or grants && array['admin.users.view', 'admin.users.manage', 'admin.roles.view', 'admin.roles.manage', 'security.access.emergency_revoke', 'security.access.restore'])
    and (route.category <> 'other'
      or grants && array['admin.users.view', 'admin.users.manage', 'admin.roles.view', 'admin.roles.manage', 'security.access.emergency_revoke', 'security.access.restore'])) as exact_sygilant_handlers,
  (select count(*) from private.support_notification_recipients(route.permission)) as existing_delivery_recipients
from routes route order by category;

rollback;

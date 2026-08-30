import { readFile } from 'node:fs/promises'
import process from 'node:process'

const files = {
  accessPolicy: new URL('../src/app/accessPolicy.ts', import.meta.url),
  data: new URL('../src/data/hrisPeople.ts', import.meta.url),
  employeeFile: new URL('../src/pages/HrisEmployeeFilePage.tsx', import.meta.url),
  migration: new URL('../supabase/migrations/20260830023000_hris_stage3_people_workspace.sql', import.meta.url),
  navigation: new URL('../src/app/navigation.ts', import.meta.url),
  router: new URL('../src/app/router.tsx', import.meta.url),
  workspace: new URL('../src/pages/HrisPeopleWorkspacePage.tsx', import.meta.url),
}

const contents = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, url]) => [key, await readFile(url, 'utf8')])),
)

const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }
const { accessPolicy, data, employeeFile, migration, navigation, router, workspace } = contents

requireValue(migration.includes('private.require_hr_people_viewer()'), 'Every People and HR RPC must use the protected viewer boundary.')
requireValue(migration.includes('public.has_mfa()'), 'The People and HR workspace must require MFA.')
requireValue(migration.includes("public.has_effective_permission('hr.people.view')"), 'The HR viewer permission is not enforced.')
requireValue(migration.includes("public.has_effective_permission('hr.people.manage')"), 'The HR manager permission is not enforced.')
requireValue(migration.includes("public.has_effective_permission('hr.people.restricted')"), 'Restricted HR contact data is not independently permission-gated.')
requireValue(migration.includes("safe_page_size integer := case when target_page_size in (5, 10, 15, 25) then target_page_size else 15 end"), 'Server-side People result limits must default to 15 and cap at 25.')
requireValue(migration.includes('limit 5'), 'The overview priority queue must be capped at five items.')
requireValue(migration.includes("clean_status text := lower(coalesce(nullif(btrim(target_status), ''), 'active'))"), 'Active employment must remain the server default.')
requireValue(migration.includes('if can_manage then'), 'Priority work must only be returned to HR managers.')
requireValue(migration.includes('private.hr_people_saved_views'), 'Saved People views must be private and employee-owned.')
requireValue(migration.includes('where saved.owner_employee_id = actor_id'), 'Saved views must be isolated to the authenticated employee.')
requireValue(migration.includes('from public, anon'), 'People and HR RPCs must be revoked from public and anonymous roles.')
requireValue(migration.includes('to authenticated'), 'Protected People and HR RPCs must be granted only to authenticated callers.')
requireValue(migration.includes('hris_stage3_people_preservation_baseline'), 'The migration must capture a protected-record preservation baseline.')
requireValue(migration.includes('Stage 3 People and HR changed protected employee, access, or HR identity records.'), 'The migration must fail if protected records change.')
requireValue(migration.includes('Stage 3 People and HR requires the identity backfill gate to remain closed.'), 'The Stage 2 identity gate must remain closed.')
requireValue(!/\bpreferred_name\b/i.test(migration), 'The HR workspace must use legal names rather than preferred names.')
requireValue(!/update\s+public\.employees|delete\s+from\s+public\.employees|insert\s+into\s+public\.employees/i.test(migration), 'Stage 3 cannot mutate permanent employee records.')
requireValue(!/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration), 'Stage 3 cannot change existing role or permission assignments.')
requireValue(data.includes("rpc('get_hr_people_workspace'"), 'The client must use the protected paginated People RPC.')
requireValue(data.includes("rpc('get_hr_people_record'"), 'Employee File must use its protected record RPC.')
requireValue(workspace.includes('Legal names are used throughout this protected HR workspace.'), 'The People page must explain its legal-name behavior.')
requireValue(workspace.includes('<option value={25}>25</option>') && !workspace.includes('<option value={50}>50</option>'), 'The People list UI must cap each page at 25 rows.')
requireValue(employeeFile.includes('Employee File remains a review surface.'), 'Employee File must remain read-only and direct edits to specialized workspaces.')
requireValue(employeeFile.includes('canAccessRoute(workspace.path, sessionQuery.data)'), 'Employee File must hide connected workspace links that the signed-in user cannot access.')
requireValue(navigation.includes("path: '/hr'"), 'People and HR navigation is missing.')
requireValue(accessPolicy.includes("'/hr/people/:employeeId': { anyOf: ['hr.people.view', 'hr.people.manage'] }"), 'Employee File route permission enforcement is missing.')
requireValue(router.includes("path: 'hr/people/:employeeId'"), 'Employee File route is missing.')

if (failures.length > 0) {
  console.error('HRIS Stage 3 People and HR validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('HRIS Stage 3 People and HR validated: MFA and permissions enforced, restricted data separated, lists bounded, legal names used, and protected employee/access records preserved.')

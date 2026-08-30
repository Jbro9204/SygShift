import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`Stage 5 validation failed: ${label}`)
}

const security = JSON.parse(read('config/hris-automation-security.json'))
const worker = read('worker/index.ts')
const wrangler = read('wrangler.jsonc')
const policy = read('src/app/accessPolicy.ts')
const router = read('src/app/router.tsx')
const navigation = read('src/app/navigation.ts')
const foundation = read('supabase/migrations/20260830220000_hris_stage5_workflow_foundation.sql')
const reliability = read('supabase/migrations/20260830223000_hris_stage5_reliability_controls.sql')
const workspace = read('supabase/migrations/20260830230000_hris_stage5_workspace_action_center.sql')

if (security.release.databaseGateDefault !== false || security.release.workerFlagDefault !== false) throw new Error('Stage 5 validation failed: release gates must default off.')
if (security.processing.maximumBatchSize !== 10 || security.processing.leaseSeconds !== 120) throw new Error('Stage 5 validation failed: bounded processing contract changed.')
if (security.workspace.maximumPageSize !== 20) throw new Error('Stage 5 validation failed: worklists must remain bounded to 20.')
if (security.security.assignNewPermissionsDuringMigration !== false) throw new Error('Stage 5 validation failed: migrations must not assign new permissions.')

requireText(wrangler, '"SYGSHIFT_HR_AUTOMATION_ENABLED": "false"', 'Worker release flag is not safely disabled.')
requireText(worker, 'async function processHrAutomationJobs', 'Workflow runner is missing.')
requireText(worker, 'processHrAutomationJobs(environment, 10)', 'Scheduled runner is not batch bounded.')
requireText(worker, "requireSessionPermission(session.context, 'hr.automation.view')", 'Administrative workspace permission is missing.')
requireText(policy, "'/hr/automation': { anyOf: ['hr.automation.view'] }", 'Route authorization does not match the service contract.')
requireText(router, "path: 'hr/automation'", 'Automation route is missing.')
if (navigation.includes('/hr/automation')) throw new Error('Stage 5 validation failed: dormant automation must not appear in navigation.')

for (const permission of security.permissions) requireText(foundation, `'${permission}'`, `Permission ${permission} is missing.`)
requireText(foundation, 'enabled boolean not null default false', 'Database release gate is missing.')
requireText(foundation, 'enable row level security', 'Private workflow tables are not protected by RLS.')
requireText(reliability, 'private.hr_automation_dead_letters', 'Dead-letter storage is missing.')
requireText(reliability, 'for update of job skip locked', 'Concurrent job claiming safeguard is missing.')
requireText(reliability, 'service_complete_hr_workflow_task', 'Human task completion service is missing.')
requireText(workspace, 'service_get_my_hr_automation_tasks', 'Action Center task service is missing.')
requireText(workspace, "limit 10", 'Employee Action Center list is not bounded.')
requireText(workspace, "limit page_size offset row_offset", 'Administrative worklists are not paginated.')
for (const migration of [foundation, reliability, workspace]) {
  requireText(migration, 'changed protected employee or access-control assignments', 'Access-preservation assertion is missing.')
  if (/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration)) throw new Error('Stage 5 validation failed: migration assigns protected access.')
}

console.log('Stage 5 HR automation validation passed.')

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`Stage 9 validation failed: ${label}`)
}

const worker = read('worker/index.ts')
const wrangler = read('wrangler.jsonc')
const policy = read('src/app/accessPolicy.ts')
const router = read('src/app/router.tsx')
const navigation = read('src/app/navigation.ts')
const page = read('src/pages/HrisStage9Page.tsx')
const data = read('src/data/hrStage9.ts')
const migration = read('supabase/migrations/20260831160000_hris_stage9_offboarding_self_service_reporting_foundation.sql')

for (const moduleName of ['OFFBOARDING', 'SELF_SERVICE', 'REPORTING']) {
  requireText(wrangler, `"SYGSHIFT_HR_${moduleName}_ENABLED": "false"`, `${moduleName.toLowerCase()} release flag must default off.`)
}

for (const permission of [
  'hr.offboarding.view', 'hr.offboarding.manage', 'hr.offboarding.approve',
  'hr.self_service.view', 'hr.self_service.manage',
  'hr.reporting.view', 'hr.reporting.manage', 'hr.reporting.export', 'hr.reporting.schedule',
]) {
  requireText(migration, `'${permission}'`, `Permission ${permission} is missing.`)
}

for (const relation of [
  'hr_lifecycle_cases', 'hr_lifecycle_approvals', 'hr_lifecycle_tasks', 'hr_lifecycle_events',
  'hr_service_requests', 'hr_service_request_events',
  'hr_report_definitions', 'hr_report_schedules', 'hr_report_runs', 'hr_report_events',
]) {
  requireText(migration, `private.${relation}`, `Relation ${relation} is missing.`)
}

requireText(migration, 'enabled boolean not null default false', 'Database release gates must default off.')
requireText(migration, 'enable row level security', 'Private HR relations must use RLS.')
requireText(migration, 'revoke all on private.%I from public,anon,authenticated', 'Private HR relations are not revoked from browser roles.')
requireText(migration, 'prevent_append_only_change', 'Append-only audit protection is missing.')
requireText(migration, 'hr_stage9_require_recent_mfa', 'Recent-MFA enforcement is missing.')
requireText(migration, 'hris_stage9_preservation_baseline', 'Production preservation baseline is missing.')
requireText(migration, 'can_manage or request.requester_id=target_actor_id or request.subject_employee_id=target_actor_id', 'Self-service records are not actor scoped.')
requireText(migration, "can_manage or report.owner_id=target_actor_id or report.visibility='authorized_hr'", 'Report definitions are not visibility scoped.')

if (/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration)) {
  throw new Error('Stage 9 validation failed: migration assigns protected access.')
}

requireText(worker, 'handleHrStage9Api', 'Stage 9 Worker handler is missing.')
requireText(worker, 'requireVerifiedOperationsSession(request, environment, `hr_${module}_mfa_required`)', 'Stage 9 requires verified operations sessions.')
requireText(worker, 'requireSessionPermission(session.context, hrStage9Permissions[module])', 'Stage 9 exact permission enforcement is missing.')
requireText(worker, "module === 'offboarding' || module === 'reporting'", 'Offboarding and reporting MFA boundary is missing.')
requireText(worker, 'requireRecentDocumentMfa(request, session)', 'Sensitive modules must require recent MFA.')
requireText(worker, "'service_get_hr_stage9_workspace'", 'Protected Stage 9 RPC connection is missing.')

for (const [path, permission] of [
  ['offboarding', 'hr.offboarding.view'],
  ['self-service', 'hr.self_service.view'],
  ['reporting', 'hr.reporting.view'],
]) {
  requireText(policy, `'/hr/${path}': { anyOf: ['${permission}'`, `${path} route policy is missing.`)
  requireText(router, `path: 'hr/${path}'`, `${path} application route is missing.`)
  requireText(navigation, `path: '/hr/${path}'`, `${path} navigation entry is missing.`)
}

requireText(data, "z.enum(['offboarding', 'self_service', 'reporting'])", 'Protected client module schema is missing.')
requireText(data, "self_service: 'self-service'", 'Self-service route mapping is missing.')
for (const size of ['<option value="5">5</option>', '<option value="10">10</option>', '<option value="20">20</option>']) {
  requireText(page, size, 'Compact 5/10/20 list controls are missing.')
}
requireText(page, 'is safely staged', 'Dormant release state is not explained safely.')

console.log('Stage 9 offboarding, self-service, and reporting validation passed.')

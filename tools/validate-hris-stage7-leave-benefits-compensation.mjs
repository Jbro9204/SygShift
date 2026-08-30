import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`Stage 7 validation failed: ${label}`)
}

const worker = read('worker/index.ts')
const wrangler = read('wrangler.jsonc')
const policy = read('src/app/accessPolicy.ts')
const router = read('src/app/router.tsx')
const navigation = read('src/app/navigation.ts')
const page = read('src/pages/HrisStage7Page.tsx')
const data = read('src/data/hrStage7.ts')
const migration = read('supabase/migrations/20260831040000_hris_stage7_leave_benefits_compensation_foundation.sql')

for (const moduleName of ['LEAVE', 'BENEFITS', 'COMPENSATION']) {
  requireText(wrangler, `"SYGSHIFT_HR_${moduleName}_ENABLED": "false"`, `${moduleName.toLowerCase()} release flag must default off.`)
}

for (const permission of [
  'hr.leave.view', 'hr.leave.manage', 'hr.leave.approve', 'hr.leave.protected.view', 'hr.leave.protected.manage',
  'hr.benefits.view', 'hr.benefits.manage', 'hr.benefits.approve',
  'hr.compensation.view', 'hr.compensation.manage', 'hr.compensation.approve',
]) {
  requireText(migration, `'${permission}'`, `Permission ${permission} is missing.`)
}

for (const relation of [
  'hr_leave_policy_definitions', 'hr_leave_cases', 'hr_leave_downstream_authorizations', 'hr_leave_protected_records', 'hr_leave_events',
  'hr_benefit_plans', 'hr_benefit_plan_versions', 'hr_benefit_coverage_tiers', 'hr_benefit_eligibility_rules', 'hr_benefit_enrollment_windows',
  'hr_benefit_employee_enrollments', 'hr_benefit_dependents', 'hr_benefit_beneficiaries', 'hr_benefit_events',
  'hr_compensation_grades', 'hr_compensation_bands', 'hr_compensation_components', 'hr_employee_compensation_records',
  'hr_compensation_proposals', 'hr_compensation_approvals', 'hr_compensation_events',
]) {
  requireText(migration, `private.${relation}`, `Relation ${relation} is missing.`)
}

requireText(migration, 'enabled boolean not null default false', 'Database release gates must default off.')
requireText(migration, 'enable row level security', 'Private HR relations must use RLS.')
requireText(migration, 'revoke all on private.%I from public,anon,authenticated', 'Private HR relations are not revoked from browser roles.')
requireText(migration, 'time_off_request_id uuid unique references public.time_off_requests(id)', 'Leave cases must preserve the operational request link.')
requireText(migration, 'document_id uuid references private.hr_documents(id)', 'Protected leave documents must use the protected document vault.')
requireText(migration, 'hr_leave_downstream_authorizations', 'Leave downstream authorization controls are missing.')
requireText(migration, 'hr_compensation_require_recent_mfa', 'Compensation recent-MFA enforcement is missing.')
requireText(migration, 'hr_compensation_approval_separation', 'Compensation two-person approval enforcement is missing.')
requireText(migration, "proposal_author = new.approver_id", 'Self-approval protection is missing.')
requireText(migration, 'prevent_append_only_change', 'Append-only audit protection is missing.')
requireText(migration, 'hris_stage7_preservation_baseline', 'Production preservation baseline is missing.')

if (/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration)) {
  throw new Error('Stage 7 validation failed: migration assigns protected access.')
}

for (const [moduleName, permission] of [['Leave', 'hr.leave.view'], ['Benefits', 'hr.benefits.view'], ['Compensation', 'hr.compensation.view']]) {
  requireText(worker, `handleHr${moduleName}Api`, `${moduleName} Worker handler is missing.`)
  requireText(worker, `requireSessionPermission(session.context, '${permission}')`, `${moduleName} exact permission check is missing.`)
}
requireText(worker, "requireVerifiedOperationsSession(request, environment, 'hr_leave_mfa_required')", 'Leave requires a verified operations session.')
requireText(worker, "requireVerifiedOperationsSession(request, environment, 'hr_benefits_mfa_required')", 'Benefits requires a verified operations session.')
requireText(worker, "requireVerifiedOperationsSession(request, environment, 'hr_compensation_mfa_required')", 'Compensation requires a verified operations session.')
requireText(worker, 'const mfa = await requireRecentDocumentMfa(request, session)', 'Compensation must require recent MFA.')

for (const [path, permission] of [['leave', 'hr.leave.view'], ['benefits', 'hr.benefits.view'], ['compensation', 'hr.compensation.view']]) {
  requireText(policy, `'/hr/${path}': { anyOf: ['${permission}'] }`.replace('\\/', '/'), `${path} route policy is missing.`)
  requireText(router, `path: 'hr/${path}'`, `${path} application route is missing.`)
  requireText(navigation, `path: '/hr/${path}'`, `${path} navigation entry is missing.`)
  requireText(data, `/api/v1/hr/${path}/workspace`, `${path} protected client is missing.`)
}

requireText(policy, "'/requests': { anyOf: ['requests.view', 'requests.manage'] }", 'Operational time-off routing must remain available.')
requireText(navigation, "path: '/requests'", 'Operational Time-Off Requests navigation must remain available.')
for (const size of ['<option value="5">5</option>', '<option value="10">10</option>', '<option value="20">20</option>']) {
  requireText(page, size, 'Compact 5/10/20 list controls are missing.')
}
requireText(page, 'is safely staged', 'Dormant release state is not explained safely.')

console.log('Stage 7 leave, benefits, and compensation validation passed.')

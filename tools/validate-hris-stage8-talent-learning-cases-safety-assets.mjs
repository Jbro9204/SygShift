import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`Stage 8 validation failed: ${label}`)
}

const worker = read('worker/index.ts')
const wrangler = read('wrangler.jsonc')
const policy = read('src/app/accessPolicy.ts')
const router = read('src/app/router.tsx')
const navigation = read('src/app/navigation.ts')
const page = read('src/pages/HrisStage8Page.tsx')
const data = read('src/data/hrStage8.ts')
const migration = read('supabase/migrations/20260831120000_hris_stage8_talent_learning_cases_safety_assets_foundation.sql')

for (const moduleName of ['TALENT', 'LEARNING', 'CASES', 'SAFETY', 'ASSETS']) {
  requireText(wrangler, `"SYGSHIFT_HR_${moduleName}_ENABLED": "false"`, `${moduleName.toLowerCase()} release flag must default off.`)
}

for (const permission of [
  'hr.talent.view', 'hr.talent.manage', 'hr.talent.restricted',
  'hr.learning.view', 'hr.learning.manage', 'hr.learning.assign',
  'hr.cases.view', 'hr.cases.manage', 'hr.cases.restricted',
  'hr.safety.view', 'hr.safety.manage', 'hr.safety.restricted',
  'hr.assets.view', 'hr.assets.manage', 'hr.assets.approve',
]) {
  requireText(migration, `'${permission}'`, `Permission ${permission} is missing.`)
}

for (const relation of [
  'hr_talent_cycles', 'hr_talent_goals', 'hr_talent_reviews', 'hr_talent_development_plans', 'hr_talent_restricted_records', 'hr_talent_events',
  'hr_learning_categories', 'hr_learning_items', 'hr_learning_assignments', 'hr_learning_evidence', 'hr_learning_license_connections', 'hr_learning_events',
  'hr_cases', 'hr_case_participants', 'hr_case_notes', 'hr_case_tasks', 'hr_case_evidence', 'hr_case_events',
  'hr_safety_cases', 'hr_safety_witnesses', 'hr_safety_restrictions', 'hr_safety_return_to_work', 'hr_safety_medical_records', 'hr_safety_events',
  'hr_assets', 'hr_asset_assignments', 'hr_asset_acknowledgments', 'hr_asset_financial_reviews', 'hr_asset_events',
]) {
  requireText(migration, `private.${relation}`, `Relation ${relation} is missing.`)
}

requireText(migration, 'enabled boolean not null default false', 'Database release gates must default off.')
requireText(migration, 'enable row level security', 'Private HR relations must use RLS.')
requireText(migration, 'revoke all on private.%I from public,anon,authenticated', 'Private HR relations are not revoked from browser roles.')
requireText(migration, 'document_id uuid references private.hr_documents(id)', 'Protected records must use the document vault.')
requireText(migration, 'hr_stage8_require_recent_mfa', 'Restricted recent-MFA enforcement is missing.')
requireText(migration, 'prevent_append_only_change', 'Append-only audit protection is missing.')
requireText(migration, 'hris_stage8_preservation_baseline', 'Production preservation baseline is missing.')

if (/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration)) {
  throw new Error('Stage 8 validation failed: migration assigns protected access.')
}

requireText(worker, 'handleHrStage8Api', 'Stage 8 Worker handler is missing.')
requireText(worker, 'requireVerifiedOperationsSession(request, environment, `hr_${module}_mfa_required`)', 'Stage 8 requires verified operations sessions.')
requireText(worker, 'requireSessionPermission(session.context, hrStage8Permissions[module])', 'Stage 8 exact permission enforcement is missing.')
requireText(worker, "module === 'cases' || module === 'safety'", 'Restricted cases and safety MFA boundary is missing.')
requireText(worker, 'requireRecentDocumentMfa(request, session)', 'Restricted modules must require recent MFA.')
requireText(worker, "'service_get_hr_stage8_workspace'", 'Protected Stage 8 RPC connection is missing.')

for (const [path, permission] of [
  ['talent-learning', 'hr.talent.view'],
  ['cases-compliance', 'hr.cases.view'],
]) {
  requireText(policy, `'/hr/${path}': { anyOf: ['${permission}'`, `${path} route policy is missing.`)
  requireText(router, `path: 'hr/${path}'`, `${path} application route is missing.`)
  requireText(navigation, `path: '/hr/${path}'`, `${path} navigation entry is missing.`)
}

for (const moduleName of ['talent', 'learning', 'cases', 'safety', 'assets']) {
  requireText(data, `z.enum(['talent', 'learning', 'cases', 'safety', 'assets'])`, 'Protected client module schema is missing.')
  requireText(worker, `target_module: module`, `${moduleName} workspace must use the protected module request.`)
}
for (const size of ['<option value="5">5</option>', '<option value="10">10</option>', '<option value="20">20</option>']) {
  requireText(page, size, 'Compact 5/10/20 list controls are missing.')
}
requireText(page, 'is safely staged', 'Dormant release state is not explained safely.')

console.log('Stage 8 talent, learning, cases, safety, and assets validation passed.')

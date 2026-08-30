import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`Stage 10 validation failed: ${label}`)
}

const worker = read('worker/index.ts')
const wrangler = read('wrangler.jsonc')
const policy = read('src/app/accessPolicy.ts')
const router = read('src/app/router.tsx')
const navigation = read('src/app/navigation.ts')
const page = read('src/pages/HrisPayrollIntegrationPage.tsx')
const data = read('src/data/hrStage10.ts')
const migration = read('supabase/migrations/20260831200000_hris_stage10_payroll_integration_hardening.sql')

for (const gate of ['PAYROLL_INTEGRATION', 'PAYROLL_WEBHOOKS', 'ENTERPRISE_CUTOVER']) {
  requireText(wrangler, `"SYGSHIFT_HR_${gate}_ENABLED": "false"`, `${gate.toLowerCase()} must default off.`)
}

for (const permission of [
  'hr.payroll_integration.view', 'hr.payroll_integration.manage', 'hr.payroll_integration.approve',
  'hr.payroll_integration.reconcile', 'hr.payroll_integration.cutover', 'hr.payroll_integration.webhooks',
]) requireText(migration, `'${permission}'`, `Permission ${permission} is missing.`)

for (const relation of [
  'hr_stage10_release_gates', 'hr_payroll_integration_contracts', 'hr_payroll_change_proposals',
  'hr_payroll_change_approvals', 'hr_payroll_reconciliation_runs', 'hr_payroll_reconciliation_items',
  'hr_payroll_integration_events', 'hr_payroll_webhook_subscriptions', 'hr_payroll_webhook_attempts',
  'hr_payroll_rollback_plans', 'hr_payroll_rollback_executions', 'hr_enterprise_verification_runs',
]) requireText(migration, `private.${relation}`, `Relation ${relation} is missing.`)

requireText(migration, 'hris_stage10_preservation_baseline', 'Protected-record preservation baseline is missing.')
requireText(migration, "payroll_authority text not null default 'sygshift_payroll'", 'Payroll authority is not explicit.')
requireText(migration, "'hourlySource','completed_and_approved_punches'", 'Worked-time source rule is missing.')
requireText(migration, "'weekStartsOn','Sunday'", 'Payroll week rule is missing.')
requireText(migration, "'timeZone','America/Denver'", 'Payroll time zone rule is missing.')
requireText(migration, "'overnightAttribution','scheduled_shift_start_workday'", 'Overnight workday rule is missing.')
requireText(migration, 'private.payroll_export_batches', 'Locked payroll batch authority is not connected.')
requireText(migration, 'private.payroll_export_rows', 'Locked payroll row evidence is not preserved.')
requireText(migration, 'hr_payroll_approval_maker_checker', 'Independent approval enforcement is missing.')
requireText(migration, 'hr_stage10_require_recent_mfa', 'Recent-MFA database enforcement is missing.')
requireText(migration, 'enable row level security', 'Private integration records do not use RLS.')
requireText(migration, 'prevent_append_only_change', 'Immutable evidence protection is missing.')
for (const digestTrigger of ['hr_payroll_contract_digest', 'hr_payroll_proposal_digest', 'hr_payroll_event_digest']) {
  requireText(migration, digestTrigger, `Digest trigger ${digestTrigger} is missing.`)
}
if (migration.includes('payload_digest text generated always')) {
  throw new Error('Stage 10 validation failed: JSON digests must use trigger-maintained values supported by production PostgreSQL.')
}
requireText(migration, "endpoint_url ~ '^https://'", 'Webhook destinations are not HTTPS-only.')
requireText(migration, 'secret_binding_name text not null', 'Webhook secret binding indirection is missing.')

if (/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(migration)) {
  throw new Error('Stage 10 validation failed: migration assigns protected access.')
}

requireText(worker, 'handleHrStage10Api', 'Protected Stage 10 Worker handler is missing.')
requireText(worker, "url.pathname !== '/api/v1/hr/payroll-integration/workspace'", 'Exact API route enforcement is missing.')
requireText(worker, "request.method !== 'GET'", 'Stage 10 workspace is not read-only.')
requireText(worker, "requireSessionPermission(session.context, 'hr.payroll_integration.view')", 'Exact server permission enforcement is missing.')
requireText(worker, 'requireRecentDocumentMfa(request, session)', 'Recent-MFA Worker enforcement is missing.')
requireText(worker, "'service_get_hr_stage10_workspace'", 'Service-role RPC boundary is missing.')

requireText(policy, "'/hr/payroll-integration': { anyOf: ['hr.payroll_integration.view'] }", 'Route access policy is missing.')
requireText(router, "path: 'hr/payroll-integration'", 'Application route is missing.')
requireText(navigation, "path: '/hr/payroll-integration'", 'Navigation entry is missing.')
requireText(data, 'hrStage10WorkspaceSchema', 'Protected response validation is missing.')
for (const size of ['<option value="5">5</option>', '<option value="10">10</option>', '<option value="20">20</option>']) {
  requireText(page, size, 'Compact 5/10/20 list controls are missing.')
}
requireText(page, 'is safely staged', 'Safe dormant state is not clearly presented.')

console.log('Stage 10 payroll integration hardening validation passed.')

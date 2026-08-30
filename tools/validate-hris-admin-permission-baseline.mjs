import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const migration = readFileSync(resolve(root, 'supabase/migrations/20260831210000_hris_admin_permission_baseline.sql'), 'utf8')
const requireText = (text, label) => {
  if (!migration.includes(text)) throw new Error(`Admin permission baseline validation failed: ${label}`)
}

requireText("where admin_role.code = 'system_admin'", 'The protected Admin role is not targeted explicitly.')
requireText('and permission.active', 'Only the active permission catalog must be granted.')
requireText('The protected Admin role must retain every active permission.', 'Admin permission removal is not blocked.')
requireText('private.repair_system_admin_permission_baseline()', 'The service-only recovery function is missing.')
requireText('grant execute on function private.repair_system_admin_permission_baseline() to service_role', 'Recovery is not restricted to the service role.')
requireText('non_admin_role_permission_fingerprint', 'Non-Admin role preservation is not verified.')
requireText('employee_access_role_fingerprint', 'Employee role assignment preservation is not verified.')
requireText('employee_override_fingerprint', 'Employee override preservation is not verified.')
requireText('employee_identity_fingerprint', 'Employee identity and primary-role preservation is not verified.')
requireText('enabled_hr_release_gate_count', 'Dormant HR release gates are not protected.')
requireText("'scope', 'reviewed-current-catalog-only'", 'The reviewed current-catalog scope is not documented.')

if (/create\s+(or\s+replace\s+)?trigger[\s\S]*system_admin/i.test(migration)) {
  throw new Error('Admin permission baseline validation failed: future permissions must not be granted by trigger.')
}

for (const gate of [
  'hr_stage2_backfill_gate', 'hr_document_release_gate', 'hr_automation_release_gate',
  'hr_recruiting_release_gate', 'hr_onboarding_release_gate', 'hr_leave_release_gate',
  'hr_benefits_release_gate', 'hr_compensation_release_gate', 'hr_stage8_release_gates',
  'hr_stage9_release_gates', 'hr_stage10_release_gates',
]) requireText(`private.${gate}`, `Release gate ${gate} is not protected.`)

console.log('Admin permission baseline validation passed.')

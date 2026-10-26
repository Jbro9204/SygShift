import { readFile } from 'node:fs/promises'
import process from 'node:process'

const files = {
  data: new URL('../src/data/hrisPeople.ts', import.meta.url),
  editors: new URL('../src/components/EmployeeFileEditors.tsx', import.meta.url),
  employeeFile: new URL('../src/pages/HrisEmployeeFilePage.tsx', import.meta.url),
  editingMigration: new URL('../supabase/migrations/20260902010000_employee_file_editing_and_pay_rates.sql', import.meta.url),
  migration: new URL('../supabase/migrations/20260831234500_hris_comprehensive_employee_file.sql', import.meta.url),
}

const contents = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, url]) => [key, await readFile(url, 'utf8')])),
)

const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }
const { data, editors, editingMigration, employeeFile, migration } = contents

const modules = [
  ['documents', 'hr.documents'],
  ['onboarding', 'hr.onboarding'],
  ['leave', 'hr.leave'],
  ['benefits', 'hr.benefits'],
  ['compensation', 'hr.compensation'],
  ['talent', 'hr.talent'],
  ['learning', 'hr.learning'],
  ['cases', 'hr.cases'],
  ['safety', 'hr.safety'],
  ['assets', 'hr.assets'],
  ['offboarding', 'hr.offboarding'],
  ['selfService', 'hr.self_service'],
]

requireValue(migration.includes('private.require_hr_people_viewer()'), 'Employee File must retain the protected People viewer boundary.')
for (const [key, permission] of modules) {
  requireValue(migration.includes(`'${key}', can_view_`), `Employee File does not return the ${key} module boundary.`)
  requireValue(migration.includes(`public.has_effective_permission('${permission}.view')`), `${permission}.view is not enforced by the Employee File RPC.`)
  requireValue(migration.includes(`public.has_effective_permission('${permission}.manage')`), `${permission}.manage is not enforced by the Employee File RPC.`)
}
requireValue(migration.includes('private.hr_document_release_gate'), 'Document release gate is not enforced.')
requireValue(migration.includes('private.hr_onboarding_release_gate'), 'Onboarding release gate is not enforced.')
requireValue(migration.includes('private.hr_stage8_release_gates'), 'Stage 8 module release gates are not enforced.')
requireValue(migration.includes('private.hr_stage9_release_gates'), 'Stage 9 module release gates are not enforced.')
requireValue(migration.includes('revoke all on function public.get_hr_people_record(uuid) from public, anon'), 'Employee File RPC is not revoked from public and anonymous users.')
requireValue(migration.includes('grant execute on function public.get_hr_people_record(uuid) to authenticated'), 'Employee File RPC is not restricted to authenticated callers.')
requireValue(!migration.includes('amount_cents'), 'Employee File must never return compensation amounts.')
requireValue(!migration.includes('salary_amount'), 'Employee File must never return salary values.')
requireValue(data.includes('moduleAccess: z.object'), 'Client schema does not validate server module access.')
requireValue(employeeFile.includes('No information is copied or maintained twice.'), 'Employee File must explain its single-source record design.')
requireValue(employeeFile.includes('module.visible && canAccessRoute(module.path, sessionQuery.data)'), 'Employee File must enforce both server module access and client route access.')
requireValue(employeeFile.includes('Pay values remain restricted to the compensation workspace.'), 'Compensation privacy disclosure is missing.')
requireValue(employeeFile.includes("label: 'Employee relations'"), 'Employee relations records are missing from Employee File.')
requireValue(employeeFile.includes('The Employee File owns core identity, employment, contact, emergency-contact, and protected pay-rate maintenance.'), 'Employee File ownership disclosure is missing.')
requireValue(editors.includes('updateHrisEmployeeIdentity'), 'Audited legal-identity editing is missing.')
requireValue(editors.includes('updateHrisEmployeeEmploymentProfile'), 'Audited employment-profile editing is missing.')
requireValue(editors.includes('updateHrisEmployeeContactDetails'), 'Restricted contact and emergency-contact editing is missing.')
requireValue(editingMigration.includes('private.require_hr_people_editor'), 'Employee File editors do not share the protected permission boundary.')
requireValue(editingMigration.includes("public.has_effective_permission('hr.people.restricted')"), 'Restricted contact editing does not enforce the separate permission.')
requireValue(editingMigration.includes('insert into private.audit_events'), 'Employee File edits are not audited.')

if (failures.length > 0) {
  console.error('Comprehensive Employee File validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('Comprehensive Employee File validated: protected module access, compensation privacy, audited core editing, and single-source records are enforced.')

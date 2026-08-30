import { readFile } from 'node:fs/promises'
import process from 'node:process'

const files = {
  control: new URL('../supabase/migrations/20260830005500_hris_stage2_controlled_backfill.sql', import.meta.url),
  data: new URL('../src/data/hrisIdentityReadiness.ts', import.meta.url),
  page: new URL('../src/pages/HrisIdentityReadinessPage.tsx', import.meta.url),
  readiness: new URL('../supabase/migrations/20260830013000_hris_stage2_identity_readiness_workspace.sql', import.meta.url),
}

const [control, data, page, readiness] = await Promise.all(
  Object.values(files).map((url) => readFile(url, 'utf8')),
)

const failures = []
const requireValue = (condition, message) => { if (!condition) failures.push(message) }

requireValue(readiness.includes('private.require_hris_stage2_manager()'), 'The readiness RPC must require the protected HRIS manager boundary.')
requireValue(control.includes("public.has_effective_permission('hr.people.manage')"), 'HR employee-management permission enforcement is missing.')
requireValue(control.includes('public.has_mfa()'), 'MFA enforcement is missing.')
requireValue(readiness.includes('least(greatest(coalesce(target_page_size, 10), 1), 10)'), 'The server must cap readiness results at 10 rows.')
requireValue(readiness.includes("'browserExecutionAvailable', false"), 'Browser backfill execution must remain unavailable.')
requireValue(readiness.includes('baseline.gate_enabled'), 'The migration must preserve a closed backfill gate.')
requireValue(readiness.includes('hris_stage2_readiness_preservation_baseline'), 'The migration must capture a protected-record preservation baseline.')
requireValue(readiness.includes('from public, anon'), 'The readiness RPC must be revoked from public and anonymous roles.')
requireValue(readiness.includes('to authenticated'), 'Only authenticated callers may reach the protected RPC boundary.')
requireValue(data.includes("rpc('authorize_hris_stage2_effective_dates'"), 'The UI data layer must use the protected authorization RPC.')
requireValue(page.includes('No browser execution is available.'), 'The workspace must state that execution is unavailable.')
requireValue(page.includes('Source reference') && page.includes('Audit reason'), 'The evidence form must require a source reference and audit reason.')
requireValue(!/execute_hris_stage2_backfill|set_hris_stage2_backfill_gate/i.test(`${page}\n${data}`), 'The browser bundle cannot expose the backfill executor or gate mutation.')
requireValue(!/insert\s+into\s+private\.hr_(person|worker)_identifiers/i.test(readiness), 'The readiness migration cannot create protected HR identities.')
requireValue(!/update\s+public\.employees/i.test(readiness), 'The readiness migration cannot update employee records.')
requireValue(!/\b(preferred_name|personal_email|company_email|mobile_phone|auth_user_id)\b/i.test(readiness), 'The readiness RPC cannot expose preferred names, contacts, or authentication identity.')

if (failures.length > 0) {
  console.error('HRIS Stage 2 readiness workspace validation failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.info('HRIS Stage 2 readiness workspace validated: MFA and permission protected, 10-row bound, browser executor absent, identity and access records preserved.')

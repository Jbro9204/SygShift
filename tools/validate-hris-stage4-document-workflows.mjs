import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260830200000_hris_stage4_document_workflows.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const managerPage = readFileSync('src/pages/HrisDocumentWorkflowsPage.tsx', 'utf8')
const employeePage = readFileSync('src/pages/MyDocumentsPage.tsx', 'utf8')
const data = readFileSync('src/data/hrDocumentWorkflows.ts', 'utf8')
const routes = readFileSync('src/app/router.tsx', 'utf8')
const accessPolicy = readFileSync('src/app/accessPolicy.ts', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')

const failures = []
const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

requireValue(migration.includes('hris_stage4_run4_preservation_baseline'), 'The Stage 4 workflow preservation baseline is missing.')
requireValue(migration.includes('Stage 4 run 4 preservation assertion failed.'), 'The migration must verify preserved production records.')
requireValue(migration.includes('set enabled = false'), 'The document release gate must remain disabled.')
requireValue(!migration.includes('insert into public.access_role_permissions'), 'The migration must not assign role permissions.')
requireValue(!migration.includes('insert into public.employee_permission_overrides'), 'The migration must not assign individual permissions.')

for (const table of ['hr_document_requests', 'hr_document_request_events', 'hr_document_assignments', 'hr_document_completion_evidence', 'hr_document_assignment_events']) {
  requireValue(migration.includes(`create table private.${table}`), `The private ${table} table is missing.`)
}
for (const trigger of ['hr_document_request_events_append_only', 'hr_document_assignment_events_append_only', 'hr_document_completion_evidence_append_only']) {
  requireValue(migration.includes(`create trigger ${trigger}`), `The append-only ${trigger} trigger is missing.`)
}
requireValue(migration.includes("requirement_type in ('acknowledgment','electronic_signature')"), 'Assignments must distinguish acknowledgment from electronic signature.')
requireValue(migration.includes('version_id uuid not null references private.hr_document_versions'), 'Assignments and evidence must bind to immutable document versions.')
requireValue(migration.includes("authentication_method in ('authenticator','security_key')"), 'Completion evidence must record an approved MFA method.')
requireValue(migration.includes("private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean'"), 'Only clean document versions may be assigned.')
requireValue(migration.includes("private.hr_document_latest_scan_state(assignment_record.version_id) <> 'clean'"), 'Employee access must reject a non-clean assigned version.')
requireValue(migration.includes("target_mfa_verified_at < clock_timestamp() - interval '15 minutes'"), 'Employee document actions must require recent MFA.')
requireValue(migration.includes('assignment.employee_id = target_actor_id'), 'Employee document access must be scoped to the assigned employee.')
requireValue(migration.includes('document.current_version_id = assignment_record.version_id'), 'Completion must validate the exact assigned current version.')
requireValue(migration.includes('private.hr_document_access_events'), 'Employee document actions must be included in the protected access audit.')
requireValue(migration.includes('revoke all on function public.service_get_my_hr_document_workspace'), 'Browser roles must not execute the employee workflow RPC directly.')
requireValue(migration.includes('grant execute on function public.service_complete_hr_document_assignment') && migration.includes('to service_role'), 'Only the service role may execute completion RPCs.')

for (const route of [
  '/api/v1/hr/documents/workflows',
  '/api/v1/hr/documents/mine',
  '/api/v1/hr/documents/requests',
  '/api/v1/hr/documents/assignments',
]) requireValue(worker.includes(route), `The protected Worker route ${route} is missing.`)
requireValue(worker.includes('handleMyHrDocumentAccessGrant'), 'The exact-assignment employee access handler is missing.')
requireValue(worker.includes('handleCompleteHrDocumentAssignment'), 'The employee evidence handler is missing.')
requireValue(worker.includes('requireHrDocumentPipeline(environment)'), 'Worker document workflows must remain behind the release flag.')
requireValue(worker.includes('requireAuthenticatedSession'), 'Worker document workflows must require authentication.')
requireValue(worker.includes('requireRecentDocumentMfa'), 'Worker document access and completion must require recent MFA.')

requireValue(data.includes("cache: 'no-store'"), 'Document workflow requests must never use a browser cache.')
requireValue(data.includes('/api/v1/hr/documents/assignments/${assignmentId}/access'), 'The employee exact-assignment access request is missing.')
requireValue(data.includes('/api/v1/hr/documents/assignments/${id}/complete'), 'The employee completion request is missing.')
requireValue(!data.includes('storage.from('), 'The browser must not access document storage directly.')
requireValue(!data.includes('createSignedUrl'), 'The browser must not receive direct storage URLs.')

requireValue(managerPage.includes('pageSize, setPageSize') && managerPage.includes('useState<PageSize>(10)'), 'The manager worklist must default to ten rows.')
requireValue(managerPage.includes('<option value={5}>5</option>') && managerPage.includes('<option value={20}>20</option>'), 'The manager worklist must support bounded 5/10/20 row counts.')
requireValue(managerPage.includes('exact current clean version'), 'The assignment UI must explain exact clean-version behavior.')
requireValue(managerPage.includes('Required audit note'), 'Request decisions must require an audit note.')
requireValue(employeePage.includes('Complete only after reviewing the exact assigned document version.'), 'The employee completion UI must identify the exact assigned version.')
requireValue(employeePage.includes('Complete legal name'), 'Electronic completion must capture the employee legal name.')
requireValue(employeePage.includes('MFA method'), 'The employee UI must disclose protected completion evidence.')
requireValue(employeePage.includes('mutation.isPending'), 'Employee document mutations must expose a pending state.')

requireValue(routes.includes("path: 'hr/documents/workflows'"), 'The manager workflow route is missing.')
requireValue(routes.includes("path: 'my-documents'"), 'The employee document route is missing.')
requireValue(accessPolicy.includes("'/hr/documents/workflows': { anyOf: ['hr.documents.view', 'hr.documents.manage'] }"), 'Manager workflow route authorization is missing.')
requireValue(accessPolicy.includes("pathname === '/my-documents'"), 'The authenticated self-document route boundary is missing.')
requireValue(!navigation.includes("path: '/hr/documents/workflows'"), 'The dormant manager workflow must not appear in navigation.')
requireValue(!navigation.includes("path: '/my-documents'"), 'The dormant employee workflow must not appear in navigation.')

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log('HRIS Stage 4 document workflow validation passed.')

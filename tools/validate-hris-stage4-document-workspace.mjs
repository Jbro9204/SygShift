import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260830170000_hris_stage4_document_workspace.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const data = readFileSync('src/data/hrDocuments.ts', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')
const accessPolicy = readFileSync('src/app/accessPolicy.ts', 'utf8')
const routes = readFileSync('src/app/router.tsx', 'utf8')

const failures = []
const requireValue = (condition, message) => {
  if (!condition) failures.push(message)
}

const workspaceFunction = migration.match(/create or replace function public\.service_get_hr_document_workspace\([\s\S]*?\n\$\$;/i)?.[0] ?? ''

requireValue(workspaceFunction.length > 0, 'The service-only HR document workspace function is missing.')
requireValue(workspaceFunction.includes('security definer'), 'The workspace function must be security definer.')
requireValue(workspaceFunction.includes("set search_path = ''"), 'The workspace function must use an empty search path.')
requireValue(workspaceFunction.includes("auth.role()) <> 'service_role'"), 'The workspace function must require the service role.')
requireValue(workspaceFunction.includes('hr_document_release_gate'), 'The workspace function must enforce the database release gate.')
requireValue(workspaceFunction.includes('employee_effective_permissions'), 'The workspace function must use effective employee permissions.')
requireValue(workspaceFunction.includes("'hr.documents.view'"), 'The workspace function must enforce document view permission.')
requireValue(workspaceFunction.includes("'hr.documents.manage'"), 'The workspace function must enforce document management permission.')
requireValue(workspaceFunction.includes("employee.status in ('active', 'onboarding', 'leave')"), 'Employee selectors must exclude separated employees.')
requireValue(workspaceFunction.includes("concat_ws(' ', employee.first_name"), 'Employee selectors must use legal names.')
requireValue(workspaceFunction.includes('target_page_size in (5, 10, 20)'), 'Inventory page sizes must remain compact and bounded.')
requireValue(migration.includes('revoke all on function public.service_get_hr_document_workspace'), 'Browser roles must be denied direct workspace RPC access.')
requireValue(migration.includes('grant execute on function public.service_get_hr_document_workspace') && migration.includes('to service_role'), 'Only the service role may execute the workspace RPC.')
requireValue(migration.includes('set enabled = false'), 'The database document release gate must remain disabled.')
requireValue(migration.includes('hris_stage4_run3_preservation_baseline'), 'Identity and access preservation checks are missing.')
requireValue(!migration.includes('insert into public.access_role_permissions'), 'The workspace migration must not assign role permissions.')
requireValue(!migration.includes('insert into public.employee_permission_overrides'), 'The workspace migration must not assign individual permissions.')

requireValue(worker.includes("url.pathname === '/api/v1/hr/documents/workspace'"), 'The protected workspace API route is missing.')
requireValue(worker.includes('handleHrDocumentWorkspace'), 'The protected workspace handler is missing.')
requireValue(worker.includes('requireHrDocumentPipeline(environment)'), 'The Worker release flag must guard document routes.')
requireValue(worker.includes('requireRecentDocumentMfa'), 'Recent authenticator MFA must guard document access.')
requireValue(worker.includes("'service_get_hr_document_workspace'"), 'The Worker must load inventory through the service-only RPC.')

requireValue(data.includes("fetch(`/api/v1/hr/documents/workspace?"), 'The browser workspace client is missing.')
requireValue(data.includes("request.open('PUT', '/api/v1/hr/documents/uploads')"), 'Protected upload progress handling is missing.')
requireValue(data.includes('idempotencyKey: input.idempotencyKey'), 'Upload retries must reuse a stable idempotency key.')
requireValue(data.includes("fetch(`/api/v1/hr/documents/${documentId}/access`"), 'Audited preview/download grants are missing.')
requireValue(data.includes('getHrDocumentBlob'), 'Protected one-time document retrieval is missing.')
requireValue(!data.includes('createSignedUrl'), 'The browser must not receive direct storage URLs.')
requireValue(!data.includes('storage.from('), 'The browser must not access document storage directly.')

requireValue(page.includes('pageSize: 10'), 'The document inventory must default to ten rows.')
requireValue(page.includes('<option value={5}>5</option>') && page.includes('<option value={20}>20</option>'), 'The document inventory must support compact 5/10/20 page sizes.')
requireValue(page.includes('aria-expanded={isExpanded}'), 'Document details must use accessible expandable rows.')
requireValue(page.includes('Upload HR document'), 'The protected upload modal is missing.')
requireValue(page.includes('Preparing protected ${action}'), 'The protected preview/download loading state is missing.')
requireValue(page.includes('Access is recorded in the audit history.'), 'Document access must clearly disclose audit recording.')
requireValue(page.includes('reason.trim().length < 8'), 'Preview and download must require a meaningful access reason.')
requireValue(page.includes("preview.mimeType === 'application/pdf'"), 'Protected PDF preview is missing.')
requireValue(page.includes("preview.mimeType.startsWith('image/')"), 'Protected image preview is missing.')
requireValue(migration.includes("version.detected_mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'text/plain')"), 'Office files must remain download-only rather than being previewed inline.')

requireValue(navigation.includes("path: '/hr/documents'"), 'The HR Documents navigation entry is missing.')
requireValue(accessPolicy.includes("'/hr/documents': { anyOf: ['hr.documents.view', 'hr.documents.manage'] }"), 'The HR Documents route policy is missing.')
requireValue(routes.includes("path: 'hr/documents'"), 'The HR Documents route is missing.')

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log('HRIS Stage 4 document workspace validation passed.')

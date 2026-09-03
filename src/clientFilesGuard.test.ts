import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const migration = read('supabase/migrations/20260902180918_enterprise_client_files.sql')
const exportHardening = read('supabase/migrations/20260902185602_client_activity_export_cap.sql')
const directoryCompletion = read('supabase/migrations/20260903194919_client_directory_completion.sql')

describe('enterprise Client Files release guard', () => {
  it('makes the client the stable root without duplicating authoritative operational records', () => {
    expect(migration).toContain('create table public.clients')
    expect(migration).toContain('add column if not exists client_id uuid references public.clients')
    expect(migration).toContain("'shift'::text as kind")
    expect(migration).toContain("select hit.id, 'patrol_hit'")
    expect(migration).toContain('private.apply_client_relationships')
  })

  it('keeps documents private, permission checked, identity verified, and audited', () => {
    expect(migration).toContain("values ('client-documents', 'client-documents', false")
    expect(migration).toContain('alter table public.client_documents enable row level security')
    expect(migration).toContain('private.require_recent_client_document_mfa')
    expect(migration).toContain('service_authorize_client_document_access')
    expect(migration).toContain('CLIENT_DOCUMENT_VIEWED')
    const worker = read('worker/index.ts')
    expect(worker).toContain('/api/v1/clients/')
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
    expect(worker).toContain("requireAnySessionPermission(session.context, ['clients.documents.manage'])")
    expect(worker).toContain("requireAnySessionPermission(session.context, ['clients.documents.view'])")
  })

  it('renders protected PDFs in the shared in-app viewer instead of a browser-blocked frame', () => {
    const page = read('src/pages/ClientFilesPage.tsx')
    expect(page).toContain("import { SecurePdfViewer } from '../components/SecurePdfViewer'")
    expect(page).toContain('<SecurePdfViewer title={document.title} url={preview.url} />')
    expect(page).not.toContain('<iframe')
  })

  it('provides compact navigation, reporting, and controlled source review', () => {
    expect(read('src/app/navigation.ts')).toContain("label: 'Client Directory'")
    expect(read('src/app/accessPolicy.ts')).toContain("'/clients/:clientId'")
    expect(read('src/pages/ClientFilesPage.tsx')).toContain('Rows')
    expect(read('src/pages/ClientFilesPage.tsx')).toContain('View all ${data.contacts.length} contacts')
    expect(read('src/pages/ClientFilesPage.tsx')).toContain('Complete the Client Directory')
    expect(read('src/pages/ReportsPage.tsx')).toContain('Client Portfolio &amp; Activity')
    expect(migration).toContain('create table private.client_import_rows')
    expect(exportHardening).toContain('limit 10000')
  })

  it('can create a canonical file from staged source and retain source provenance', () => {
    const page = read('src/pages/ClientFilesPage.tsx')
    expect(page).toContain('Create Client File')
    expect(page).toContain('Match existing')
    expect(page).toContain('Exclude non-client row')
    expect(page).toContain('Michelle’s source records')
    expect(directoryCompletion).toContain('public.get_client_import_source_records')
    expect(directoryCompletion).toContain("target_action = 'promote'")
    expect(directoryCompletion).toContain("set status = case")
  })

  it('preserves protected production counts in the migration', () => {
    expect(migration).toContain('client_file_release_baseline')
    expect(migration).toContain("raise exception 'Client File release altered protected production record counts.'")
  })
})

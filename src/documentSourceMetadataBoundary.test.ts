/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const data = readFileSync('src/data/hrDocuments.ts', 'utf8')
const libraryData = readFileSync('src/data/hrDocumentLibrary.ts', 'utf8')
const migration = readFileSync('supabase/migrations/20261001183000_hr_document_workspace_source_metadata.sql', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const handler = worker.slice(
  worker.indexOf('async function handleHrDocumentWorkspace'),
  worker.indexOf('async function handleHrDocumentArchive'),
)
const libraryHandler = worker.slice(
  worker.indexOf('async function handleHrTemplateLibrary'),
  worker.indexOf('async function handleHrSystemRegistration'),
)
const registrationHandler = worker.slice(
  worker.indexOf('async function handleHrSystemRegistration'),
  worker.indexOf('async function handleAssignedTrainingDocument'),
)

describe('HR document source metadata boundary', () => {
  it('embeds source metadata through a service-only additive v3 RPC', () => {
    expect(migration).toContain('create or replace function public.service_get_hr_document_workspace_v3')
    expect(migration).toContain("set search_path = ''")
    expect(migration).toContain('public.service_get_hr_document_workspace_v2(')
    expect(migration).toContain("result -> 'documents'")
    expect(migration).toContain("'sourceMetadata'")
    expect(migration).toContain("'lifecycleStatus', source_item.lifecycle_status")
    expect(migration).toContain("'sourceType', source_item.source_type")
    expect(migration).toContain('add column source_type text not null default \'unclassified\'')
    expect(migration).toContain('hr_template_library_adopted_source_classified')
    expect(migration).toContain('item.source_document_id = (listed.document_json ->> \'id\')::uuid')
    expect(migration).toContain('order by item.active desc')
    expect(migration).toContain('limit 1')
    expect(migration).toMatch(/revoke all on function public\.service_get_hr_document_workspace_v3[\s\S]*from public, anon, authenticated/)
    expect(migration).toMatch(/grant execute on function public\.service_get_hr_document_workspace_v3[\s\S]*to service_role/)
  })

  it('returns the persisted subtype in the paged library with a safe v2-to-v1 rollout', () => {
    expect(migration).toContain('create or replace function public.service_get_hr_system_library_v2')
    expect(migration).toContain("'sourceType', coalesce(source_item.source_type, 'unclassified')")
    expect(migration).toContain("'sourceSha256', source_item.source_sha256")
    expect(migration).toContain("'updatedAt', source_item.updated_at")
    expect(libraryHandler).toContain("'service_get_hr_system_library_v2'")
    expect(libraryHandler).toContain("'service_get_hr_system_library'")
    expect(libraryHandler).toContain('if (!v2Unavailable) throw error')
    expect(data).toContain("'unclassified'")
  })

  it('keeps legacy adopted rows valid while classifying known reference sources explicitly', () => {
    expect(migration).toContain("target_code in ('GS-HR-000'")
    expect(migration).toContain("lower(target_section) = 'legacy library'")
    expect(migration).toContain('hr_template_library_source_type_kind')
    expect(migration).toContain("source_type = 'unclassified'")
  })

  it('keeps registration draft-only and persists a reviewed compatible subtype on insert and update', () => {
    expect(migration).toContain('create or replace function private.register_hr_system_item(')
    expect(migration).toContain('create or replace function public.service_register_hr_system_item_v2(')
    expect(migration).toContain("if target_lifecycle_status <> 'draft_for_adoption'")
    expect(migration).toContain('package_metadata, source_type')
    expect(migration).toContain('source_type = excluded.source_type')
    expect(migration).toContain('existing_source.document_kind <> target_document_kind')
    expect(migration).toContain("existing_source.lifecycle_status <> 'draft_for_adoption'")
    expect(migration).toContain('document.employee_id is null')
    expect(migration).toContain("private.service_require_hr_document_permission(")
    expect(migration).toContain("private.hr_document_latest_scan_state(")
    expect(registrationHandler).toContain("'service_register_hr_system_item_v2'")
    expect(registrationHandler).toContain("'service_register_hr_system_item'")
    expect(registrationHandler).toContain("lifecycleStatus !== 'draft_for_adoption'")
    expect(registrationHandler).toContain("registrationArguments.target_document_kind === 'training_module'")
  })

  it('adopts one reviewed source with MFA, optimistic concurrency, release gates, and an audit reason', () => {
    expect(migration).toContain('create or replace function public.service_adopt_hr_library_source(')
    expect(migration).toContain('for update')
    expect(migration).toContain('target_expected_updated_at')
    expect(migration).toContain('target_expected_sha256')
    expect(migration).toContain("source_item.lifecycle_status <> 'draft_for_adoption'")
    expect(migration).toContain('private.hr_template_library_release_gate')
    expect(migration).toContain('private.hr_document_release_gate')
    expect(migration).toContain("'lifecycleFrom', 'draft_for_adoption'")
    expect(migration).toContain("'lifecycleTo', 'adopted'")
    expect(registrationHandler).toContain('async function handleHrLibraryAdoption')
    expect(registrationHandler).toContain('await requireRecentHrMfa(request, session)')
    expect(registrationHandler).toContain("'service_adopt_hr_library_source'")
    expect(registrationHandler).toContain('target_expected_sha256')
    expect(registrationHandler).toContain('target_expected_updated_at')
    expect(registrationHandler).toContain("optionalExactIsoTimestamp(body.updatedAt, 'Reviewed source timestamp')")
    expect(worker).toMatch(/function optionalExactIsoTimestamp[\s\S]*return text/)
  })

  it('pins the exact clean PDF version and blocks silent adopted-source replacement', () => {
    expect(migration).toContain('add column source_version_id uuid references private.hr_document_versions(id) on delete restrict')
    expect(migration).toContain('source_item.source_version_id is distinct from version_record.id')
    expect(migration).toContain('source_item.source_sha256 is distinct from version_record.sha256_checksum')
    expect(migration).toContain('target_expected_sha256 is distinct from version_record.sha256_checksum')
    expect(migration).toContain('create trigger prevent_final_hr_library_source_replacement')
    expect(migration).toContain('before update of current_version_id on private.hr_documents')
    expect(migration).toContain("item.lifecycle_status in ('adopted', 'retired')")
  })

  it('retires one adopted source through the same MFA, concurrency, vault, audit, and training boundaries', () => {
    expect(migration).toContain('create or replace function public.service_retire_hr_library_source(')
    expect(migration).toContain("source_item.lifecycle_status <> 'adopted'")
    expect(migration).toContain("'lifecycleFrom', 'adopted'")
    expect(migration).toContain("'lifecycleTo', 'retired'")
    expect(migration).toContain("set lifecycle_status = 'retired'")
    expect(migration).toContain("set status = 'retired'")
    expect(registrationHandler).toContain('async function handleHrLibraryRetirement')
    expect(registrationHandler).toContain("'service_retire_hr_library_source'")
    expect(worker).toContain('/retire$/i')
    expect(libraryData).toContain('retireHrDocumentLibrarySource')
  })

  it('keeps draft training non-assignable and reconciles prior imports without deleting assignments or versions', () => {
    expect(migration).toContain("course_active := target_lifecycle_status = 'adopted'")
    expect(migration).toContain("if target_lifecycle_status = 'adopted' then")
    expect(migration).toContain('update public.training_courses course')
    expect(migration).toContain('update private.hr_learning_items learning')
    expect(migration).toContain('mismatched_courses')
    expect(migration).toContain('mismatched_learning')
    expect(migration).toContain('create trigger prevent_unadopted_library_training_activation')
    expect(migration).toContain('create trigger prevent_unadopted_library_training_version')
    expect(migration).not.toContain('delete from public.training_assignments')
    expect(migration).not.toContain('delete from public.training_course_versions')
  })

  it('rolls out safely from v3 to v2 to v1 without hiding non-missing-function failures', () => {
    const v3 = handler.indexOf("'service_get_hr_document_workspace_v3'")
    const v2 = handler.indexOf("'service_get_hr_document_workspace_v2'")
    const v1 = handler.indexOf("'service_get_hr_document_workspace'")
    expect(v3).toBeGreaterThan(-1)
    expect(v2).toBeGreaterThan(v3)
    expect(v1).toBeGreaterThan(v2)
    expect(handler).toContain("error.code === 'PGRST202'")
    expect(handler).toContain("error.code === '42883'")
    expect(handler).toContain('if (!v3Unavailable) throw error')
    expect(handler).toContain('if (!v2Unavailable) throw fallbackError')
  })

  it('uses only page-bounded embedded metadata in the browser', () => {
    expect(data).toContain('sourceMetadata: documentSourceMetadataSchema.nullable().optional()')
    expect(page).toContain('document.employeeId ? null : document.sourceMetadata')
    expect(page).toContain('document.canManage && source === null')
    expect(page).not.toContain('getHrDocumentLibrarySourceIndex')
    expect(libraryData).not.toContain('getHrDocumentLibrarySourceIndex')
    expect(libraryData).not.toContain('Promise.all(')
  })

  it('blocks approved and retired library sources from the generic archive lifecycle', () => {
    expect(migration).toContain('create or replace function private.prevent_active_hr_library_source_archive()')
    expect(migration).toContain('create trigger prevent_active_hr_library_source_archive')
    expect(migration).toContain('before update of archived_at on private.hr_documents')
    expect(migration).toContain('where item.source_document_id = old.id')
    expect(migration).toContain("and item.lifecycle_status in ('adopted', 'retired')")
    expect(migration).toMatch(/revoke all on function private\.prevent_active_hr_library_source_archive\(\)[\s\S]*from public, anon, authenticated, service_role/)
  })

  it('only advertises lifecycle management to document managers', () => {
    expect(migration).toContain("to_jsonb('hr.documents.manage' = any(effective_permissions))")
    expect(migration).not.toContain("to_jsonb(effective_permissions && array['hr.documents.manage','hr.learning.manage','training.manage']")
  })
})

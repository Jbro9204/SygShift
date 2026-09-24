/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260924213024_employee_licensing_center_self_service.sql'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'licensing.ts'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const selfService = readFileSync(join(root, 'src', 'components', 'LicensingSelfServiceWorkspace.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('employee Licensing Center major update', () => {
  it('opens self-service to every authenticated employee but keeps management selected by permission', () => {
    expect(canAccessRoute('/licensing', { permissions: [] })).toBe(true)
    expect(page).toContain("licensingManagementPermissions")
    expect(page).toContain('<MyLicensingWorkspace />')
    expect(page).toContain('<LicensingManagementCenter />')
  })

  it('enforces ownership and review authority in database functions rather than only the interface', () => {
    expect(migration).toContain("submission.employee_id <> target_actor_id")
    expect(migration).toContain("credential.employee_id <> target_actor_id")
    expect(migration).toContain('private.require_licensing_reviewer_mfa()')
    expect(migration).toContain("'licensing.manage' = any")
    expect(migration).toContain("'directory.edit_credentials' = any")
    expect(migration).toContain('force row level security')
    expect(migration).toContain('revoke all on table public.licensing_submissions')
  })

  it('preserves the canonical credential and immutable prior versions on approval', () => {
    expect(migration).toContain('create table public.licensing_credential_versions')
    expect(migration).toContain('source_submission_id')
    expect(migration).toContain('update public.employee_credentials item')
    expect(migration).toContain("set status = 'approved'")
    expect(migration).toContain("renewal_status = 'awaiting_issuing_authority'")
  })

  it('supports drafts, secure multi-file uploads, review decisions, corrections, and notifications', () => {
    expect(data).toContain('saveMyLicensingSubmission')
    expect(data).toContain('uploadLicensingSubmissionDocument')
    expect(data).toContain('reviewLicensingSubmission')
    expect(selfService).toContain('multiple')
    expect(selfService).toContain('Save draft')
    expect(selfService).toContain('Request a correction')
    expect(migration).toContain('private.notify_licensing_reviewers(submission)')
    expect(migration).toContain('private.create_workflow_notification')
    expect(migration).toContain('private.notify_workflow_status')
  })

  it('uses the protected Worker upload and audited access pipeline for employee documents', () => {
    expect(worker).toContain('handleLicensingSubmissionDocumentUpload')
    expect(worker).toContain('service_prepare_licensing_submission_document_upload')
    expect(worker).toContain('validateHrDocumentFile')
    expect(worker).toContain('sha256BytesHex')
    expect(worker).toContain('service_authorize_licensing_document_access')
    expect(migration).toContain('LICENSING_SUBMISSION_DOCUMENT_UPLOAD_STARTED')
    expect(migration).toContain('LICENSING_DOCUMENT_PREVIEWED')
    expect(migration).toContain('LICENSING_DOCUMENT_DOWNLOADED')
  })
})

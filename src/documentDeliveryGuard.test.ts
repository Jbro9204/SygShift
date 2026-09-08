/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260909220000_employee_writeup_and_signature_delivery.sql'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const studio = readFileSync(join(root, 'src', 'components', 'DocumentStudioDashboard.tsx'), 'utf8')

describe('employee write-up and signature delivery', () => {
  it('delivers each attendance-accountability action to the affected employee once', () => {
    expect(migration).toContain('deliver_accountability_writeup_to_employee')
    expect(migration).toContain("'accountability-writeup-action:' || new.id::text")
    expect(migration).toContain('employee_notification_email_deliveries')
    expect(migration).toContain('event_record.employee_id = new.actor_id')
    expect(migration).toContain("'/time/accountability'")
  })

  it('exposes active signature policies to authorized requesters without policy-admin access', () => {
    expect(migration).toContain('service_get_signature_policy_options')
    expect(migration).toContain("'documents.signatures.request' = any(effective_permissions)")
    expect(migration).toContain('grant execute on function public.service_get_signature_policy_options(uuid)')
    expect(worker).toContain("'service_get_signature_policy_options'")
    expect(worker).toContain('policies, requestId')
  })

  it('treats assigned signature email as transactional and keeps one in-app mirror', () => {
    expect(migration).toContain('mirror_signature_request_notification')
    expect(migration).toContain("'document-signature-outbox:' || new.id::text")
    expect(worker).toContain("const isRequiredDocumentDelivery = job.messageType === 'document_signature_required'")
    expect(worker).toContain('respectEmployeePreferences && !isRequiredDocumentDelivery')
  })

  it('makes the outside-document signing path clear and keeps templates optional', () => {
    expect(studio).toContain('Upload, prepare, and send from one workspace')
    expect(studio).toContain('Upload document')
    expect(studio).toContain('A reusable template is optional.')
    expect(studio).toContain('Send document without placed fields')
    expect(studio).toContain('An approved signing policy is required')
  })
})

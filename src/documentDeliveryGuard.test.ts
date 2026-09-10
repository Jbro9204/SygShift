/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260909220000_employee_writeup_and_signature_delivery.sql'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const studio = readFileSync(join(root, 'src', 'components', 'DocumentStudioDashboard.tsx'), 'utf8')
const signatureWizard = readFileSync(join(root, 'src', 'components', 'DocumentSignatureWizard.tsx'), 'utf8')
const workbench = readFileSync(join(root, 'src', 'components', 'DocumentWorkbench.tsx'), 'utf8')
const myDocuments = readFileSync(join(root, 'src', 'pages', 'MyDocumentsPage.tsx'), 'utf8')

describe('employee write-up and signature delivery', () => {
  it('delivers each attendance-accountability action to the affected employee once', () => {
    expect(migration).toContain('deliver_accountability_writeup_to_employee')
    expect(migration).toContain("'accountability-writeup-action:' || new.id::text")
    expect(migration).toContain('employee_notification_email_deliveries')
    expect(migration).toContain('event_record.employee_id = new.actor_id')
    expect(migration).toContain("'dismissed', 'voided', 'reopened', 'reclassified'")
    expect(migration).toContain("'/notifications'")
    expect(migration).toContain('Open your SygShift notifications: https://app.sygilant.us/notifications')
    expect(migration).not.toContain("'/time/accountability'")
    expect(migration).toContain('Sensitive record details are not included in email.')
    expect(migration).not.toContain("coalesce(nullif(btrim(new.reason), ''), nullif(btrim(event_record.note), '')")
  })

  it('exposes active signature policies to authorized requesters without policy-admin access', () => {
    expect(migration).toContain('service_get_signature_policy_options')
    expect(migration).toContain("'documents.signatures.request' = any(effective_permissions)")
    expect(migration).toContain('grant execute on function public.service_get_signature_policy_options(uuid)')
    expect(worker).toContain("'service_get_signature_policy_options'")
    expect(worker).toContain('policies, requestId')
  })

  it('treats assigned signature email as transactional and keeps one in-app mirror', () => {
    const signatureMirror = migration.match(
      /create or replace function private\.mirror_signature_request_notification\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/,
    )?.[1]

    expect(signatureMirror).toBeDefined()
    expect(signatureMirror).not.toContain('employee_notification_email_deliveries')
    expect(signatureMirror).not.toContain("new.payload ->> 'message'")
    expect(migration).toContain('mirror_signature_request_notification')
    expect(migration).toContain("'document-signature-outbox:' || new.id::text")
    expect(migration).toContain('create or replace function public.service_claim_notification_batch')
    expect(migration).toContain("when outbox.message_type = 'document_signature_required' then jsonb_build_object")
    expect(migration).toContain('where employee.id = outbox.recipient_employee_id')
    expect(migration).toContain("'A protected document is ready for your review.'")
    expect(migration).not.toContain("new.payload ->> 'message'")
    expect(migration).not.toContain('pg_get_functiondef')
    expect(migration).not.toContain("outbox.message_type <> 'document_signature_required'")
    expect(migration).toContain("interval '20 minutes'")
    expect(worker).toContain("const isRequiredDocumentDelivery = job.messageType === 'document_signature_required'")
    expect(worker).toContain('respectEmployeePreferences && !isRequiredDocumentDelivery')
    expect(worker).toContain("'service_mark_notification_result'")
  })

  it('keeps the generic delivery worker from stealing another processor\'s queue rows', () => {
    const claimant = migration.match(
      /create or replace function public\.service_claim_notification_batch\(target_limit integer default 10\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/,
    )?.[1]

    expect(claimant).toBeDefined()
    expect(claimant).toContain("and outbox.message_type in (\n        'announcement_published',\n        'call_off_supervisor_alert',\n        'document_signature_required',\n        'schedule_published'\n      )")
    expect(claimant).not.toContain("when outbox.message_type = 'automatic_clock_out_employee'")
    expect(claimant).not.toContain("when outbox.message_type = 'time_off_decision'")
    expect(claimant).not.toContain("when outbox.message_type = 'hr_workflow'")
    expect(claimant).not.toContain("when outbox.message_type = 'hr_task_escalation'")
  })

  it('makes the outside-document signing path clear and keeps templates optional', () => {
    expect(studio).toContain('Open it, complete it, and choose where it goes')
    expect(studio).toContain('No policy, template, filing section, or setup wizard is required.')
    expect(studio).toContain('Add to an employee file')
    expect(workbench).toContain('Send document')
    expect(workbench).toContain('createTypedSignaturePng')
    expect(studio).toContain('Send document without placed fields')
    expect(studio).toContain('An approved signing policy is required')
    expect(workbench).toContain("policy.active && policy.code === 'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE'")
    expect(workbench).toContain('routingOrder: 1')
    expect(workbench).toContain("vault.code === 'hr-general'")
    expect(signatureWizard).toContain("policy.code === 'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE'")
    expect(signatureWizard).toContain('You do not have to choose a section.')
    expect(signatureWizard).toContain('recipients: recipientIds.map')
    expect(signatureWizard).toContain('await sendSignatureEnvelope(created.id)')
    expect(worker).toContain('Signature completion page')
    expect(worker).toContain('if (signatureImage && !signaturePlaced)')
    expect(myDocuments).toContain('Preview signed PDF')
    expect(myDocuments).toContain('Download signed PDF')
  })

  it('keeps both signature RPCs lint-safe under an empty search path', () => {
    const createEnvelope = migration.match(
      /create or replace function public\.service_create_signature_envelope\([\s\S]*?as \$\$([\s\S]*?)\$\$;/,
    )?.[1]
    const recordAction = migration.match(
      /create or replace function public\.service_record_signature_action\([\s\S]*?as \$\$([\s\S]*?)\$\$;/,
    )?.[1]
    const normalizedMigration = migration.replace(/\s+/g, ' ')

    expect(createEnvelope).toBeDefined()
    expect(createEnvelope).toContain('created_envelope_id uuid')
    expect(createEnvelope).toContain('recipient_employee_id uuid')
    expect(createEnvelope).toContain('where employee.id = recipient_employee_id')
    expect(createEnvelope).not.toContain('employee.id = employee_id')
    expect(createEnvelope).not.toMatch(/^\s*employee_id uuid;/m)
    expect(createEnvelope).not.toContain('where recipient.envelope_id = envelope_id')
    expect(recordAction).toBeDefined()
    expect(recordAction).toContain('extensions.digest(')
    expect(recordAction).not.toMatch(/fields_checksum\s*:=\s*encode\(\s*digest\(/)
    expect(migration).toContain('security definer')
    expect(migration).toContain("set search_path = ''")
    expect(normalizedMigration).toContain(
      'grant execute on function public.service_create_signature_envelope( uuid, uuid, uuid, uuid, text, text, timestamptz, jsonb, uuid, text, timestamptz, text ) to service_role;',
    )
    expect(normalizedMigration).toContain(
      'grant execute on function public.service_record_signature_action( uuid, uuid, text, jsonb, text, timestamptz, text, text, text, text, text, text, boolean, text, text, timestamptz, text, text ) to service_role;',
    )
  })
})

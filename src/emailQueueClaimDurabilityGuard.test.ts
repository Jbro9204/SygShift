import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20261024173000_durable_email_queue_claims_and_review.sql',
  'utf8',
)
const worker = readFileSync('worker/index.ts', 'utf8')

function section(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker)
  const end = migration.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('durable email queue claim and review contract', () => {
  it('leases all six claim lanes without consuming an attempt on claim response loss', () => {
    for (const signature of [
      'create function public.service_claim_notification_batch(',
      'create function public.service_claim_timekeeping_notification_batch(',
      'create function public.service_claim_time_off_notification_batch(',
      'create function public.service_claim_support_ticket_notification_batch(',
      'create function public.service_claim_employee_notification_batch(',
      'create function public.service_claim_notification_by_id(',
    ]) {
      expect(migration).toContain(signature)
    }

    const lease = section(
      'create or replace function private.apply_email_job_claim_lease(',
      'revoke all on function private.apply_email_job_claim_lease',
    )
    expect(lease).toContain('claim_token = leased_token')
    expect(lease).toContain('claim_expires_at = lease_until')
    expect(lease.match(/attempt_count = greatest\(source\.attempt_count - 1, 0\)/g)).toHaveLength(3)

    const generalClaim = section(
      'create function public.service_claim_notification_batch(',
      'create function public.service_claim_timekeeping_notification_batch(',
    )
    expect(generalClaim).toContain("outbox.message_type in ('security_key_added', 'security_key_removed')")
    expect(generalClaim).toContain("outbox.payload -> 'recipientManifestFrozen' = 'true'::jsonb")
    expect(generalClaim).toContain('attempt_count = outbox.attempt_count + 1')
    expect(generalClaim).toContain("private.apply_email_job_claim_lease(\n    'notification_outbox'")
  })

  it('uses source-local terminal reconciliation and one lock order instead of a historical sweep', () => {
    expect(migration).not.toContain('reconcile_terminal_email_dispatch_sources')

    const completion = section(
      'create or replace function public.service_complete_email_recipient_dispatch(',
      'create or replace function public.service_list_email_recipient_dispatch_review(',
    )
    const completionSourceLock = completion.indexOf("'email-dispatch-source:' || target_source_kind")
    const completionRowLock = completion.indexOf('for update;', completionSourceLock)
    expect(completionSourceLock).toBeGreaterThanOrEqual(0)
    expect(completionRowLock).toBeGreaterThan(completionSourceLock)
    expect(completion).toContain('perform private.reconcile_terminal_email_dispatch_source(')
    expect(completion).toContain('dispatch_record.failure_detail is distinct from clean_failure')

    const result = section(
      'create or replace function private.resolve_email_job_claim(',
      'revoke all on function private.resolve_email_job_claim',
    )
    expect(result.indexOf("'email-dispatch-source:' || target_source_kind"))
      .toBeLessThan(result.indexOf('for update;'))
    expect(result).toContain('source_reconciled := coalesce')
    expect(result).toContain("when target_outcome = 'failed' and not source_reconciled then 1")

    const attendance = section(
      'create or replace function public.service_mark_attendance_accountability_dispatch_result(',
      'revoke all on function public.service_mark_attendance_accountability_dispatch_result',
    )
    expect(attendance).toContain("'email-dispatch-source:attendance_accountability_event:'")
    expect(attendance).toContain('private.reconcile_terminal_email_dispatch_source(')

    const targetedClaim = section(
      'create function public.service_claim_notification_by_id(',
      'create or replace function private.resolve_email_job_claim(',
    )
    const targetedClaimSourceLock = targetedClaim.indexOf("'email-dispatch-source:notification_outbox:'")
    const targetedClaimReconcile = targetedClaim.indexOf('private.reconcile_terminal_email_dispatch_source(')
    expect(targetedClaimSourceLock).toBeGreaterThanOrEqual(0)
    expect(targetedClaimReconcile).toBeGreaterThan(targetedClaimSourceLock)
  })

  it('binds exact claim/review replays and requires concrete verified-unsent evidence', () => {
    expect(migration).toContain('create table private.email_job_claim_results')
    expect(migration).toContain('Email claim result replay does not match the committed outcome.')
    expect(migration).toContain('create table private.email_dispatch_review_operations')
    expect(migration).toContain('Email dispatch review operation conflicts with its committed request.')

    const review = section(
      'create or replace function public.service_resolve_email_recipient_dispatch_review(',
      '-- Known-unsent release is not a human provider review.',
    )
    expect(review).toContain("target_resolution in ('retry_verified_unsent', 'failed_verified_unsent')")
    expect(review).toContain('length(clean_failure) < 12')
    expect(review).toContain("dispatch_record.source_kind not in (\n      'notification_outbox',\n      'support_ticket_notification',\n      'employee_notification_delivery'")
    expect(review).toContain('failure_detail = clean_failure')
    expect(worker).toContain("'email_dispatch_review_evidence_required'")
  })

  it('keeps known-unsent recovery token-fenced with truthful nullable actor attribution', () => {
    const release = section(
      'create or replace function public.service_release_known_unsent_email_dispatch(',
      '-- Security-key mutations and their notice intent now commit atomically.',
    )
    expect(release.indexOf("'email-dispatch-source:' || dispatch_record.source_kind"))
      .toBeLessThan(release.indexOf('for update;'))
    expect(release).toContain('dispatch_record.dispatch_token is distinct from target_dispatch_token')
    expect(release).toContain("when target_initiator_employee_id is null then 'system_or_signed_out'")
    expect(release).toContain('Known-unsent release does not match the committed evidence.')
  })

  it('queues security-key notices atomically without credential material in the payload', () => {
    const securityNotice = section(
      'create or replace function private.queue_security_key_change_notice()',
      'drop trigger if exists webauthn_credentials_queue_change_notice',
    )
    expect(securityNotice).toContain("'security_key_' || action")
    expect(securityNotice).toContain("'recipientManifestFrozen', true")
    expect(securityNotice).toContain("'security-key-change:' || action || ':' || new.id::text")
    expect(securityNotice).not.toContain('new.credential_id')
    expect(securityNotice).not.toContain('new.public_key')
    expect(securityNotice).not.toContain('new.challenge')
  })
})

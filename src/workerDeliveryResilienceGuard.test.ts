import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const worker = readFileSync(resolve(root, 'worker/index.ts'), 'utf8')
const emailMigration = readFileSync(resolve(
  root,
  'supabase/migrations/20261024153000_durable_email_recipient_dispatch.sql',
), 'utf8')
const pushMigration = readFileSync(resolve(
  root,
  'supabase/migrations/20261024156000_durable_push_provider_outcome.sql',
), 'utf8')

function sqlFunction(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature)
  const end = source.indexOf(nextSignature, start + signature.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('durable provider outcome safeguards', () => {
  it('fences every email recipient before provider delivery and audits acceptance atomically', () => {
    expect(emailMigration).toContain('create table private.email_recipient_dispatches')
    expect(emailMigration).toContain('unique (source_kind, source_id, intended_recipient, notification_type)')
    expect(emailMigration).toContain('service_prepare_email_recipient_dispatch_batch')
    expect(emailMigration).toContain("'attendance_accountability_event'")
    expect(emailMigration).toContain("'inline_email'")
    expect(emailMigration).toContain('insert into private.email_delivery_audit')
    expect(worker).toContain("'service_prepare_email_recipient_dispatch_batch'")
    expect(worker).toContain("headers: { 'X-SygShift-Delivery-ID': decision.dispatchToken }")
    expect(worker).toContain('sendDurableInlineEmail')
  })

  it('requires explicit evidence before retrying an unknown email provider outcome', () => {
    expect(emailMigration).toContain("target_resolution not in ('accepted', 'suppressed', 'retry_verified_unsent')")
    expect(emailMigration).toContain("set state = 'retry_approved'")
    expect(emailMigration).toContain("if dispatch_record.state = 'retry_approved'")
    expect(emailMigration).toContain('service_list_email_recipient_dispatch_review')
    expect(emailMigration).toContain('service_resolve_email_recipient_dispatch_review')
    expect(emailMigration).toContain("dispatch_record.source_kind = 'attendance_accountability_event'")
  })

  it('does not finalize a multi-recipient source while any recipient still needs review', () => {
    const resolution = sqlFunction(
      emailMigration,
      'create or replace function public.service_resolve_email_recipient_dispatch_review(',
      'create or replace function public.service_complete_email_recipient_dispatch(',
    )
    expect(resolution).toContain("count(*) filter (where item.state in ('dispatching', 'uncertain', 'retry_approved'))")
    expect(resolution).toContain("elsif unresolved_count = 0 and dispatch_record.source_kind = 'notification_outbox'")
    expect(resolution).toContain('case when accepted_count > 0 then clock_timestamp() else null end')
  })

  it('never lets the legacy push claim consume a provider-started delivery', () => {
    const claim = sqlFunction(
      pushMigration,
      'create or replace function public.service_claim_employee_push(',
      'create or replace function public.service_complete_employee_push(',
    )
    expect(claim).not.toContain('service_claim_employee_push_pre_call_off')
    expect(claim).toContain("delivery.provider_state = 'pending'")
    expect(claim).toContain("provider_state = 'request_started'")
    expect(claim).toContain('provider_attempt_id = pending.next_claim_token')
  })

  it('quarantines legacy claimed rows instead of defaulting them to pending', () => {
    expect(pushMigration).toContain('private.classify_legacy_push_provider_state(')
    expect(pushMigration).toContain("when target_claim_token is not null then 'uncertain'")
    expect(pushMigration).toContain("when target_completed_at is not null then 'resolved'")
    expect(pushMigration).toContain('and delivery.claim_token is not null')
    expect(pushMigration).toContain("and delivery.provider_state = 'pending'")
  })

  it('recovers accepted and resolved completion writes while uncertain pushes remain fenced', () => {
    const completion = sqlFunction(
      pushMigration,
      'create or replace function public.service_complete_employee_push(',
      'create or replace function public.service_mark_employee_push_provider_state(',
    )
    const reconciliation = sqlFunction(
      pushMigration,
      'create or replace function public.service_reconcile_employee_push_provider_outcomes(',
      'create or replace function public.service_list_employee_push_provider_review(',
    )
    expect(completion).toContain("delivery.provider_state in ('request_started', 'uncertain')")
    expect(completion).toContain('return;')
    expect(reconciliation).toContain("delivery.provider_state = 'accepted'")
    expect(reconciliation).toContain("delivery.provider_state = 'resolved'")
    expect(reconciliation).toContain("delivery.provider_state in ('request_started', 'uncertain')")
    expect(pushMigration).toContain('service_list_employee_push_provider_review')
    expect(pushMigration).toContain("target_resolution not in ('delivered', 'failed', 'retry_verified_unsent')")
    expect(pushMigration).toContain("set provider_state = 'pending'")
    expect(worker.indexOf('reconcilePushProviderOutcomes(pushRpc)'))
      .toBeLessThan(worker.indexOf('deliverPushBatch({ publicKey, privateKey, hookSecret }, pushRpc)'))
  })
})

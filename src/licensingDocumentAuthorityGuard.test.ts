import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const migration = readFileSync(resolve(
  root,
  'supabase/migrations/20261024166000_licensing_document_authority_fence.sql',
), 'utf8')
const rollbackRegression = readFileSync(resolve(
  root,
  'supabase/tests/licensing_document_authority_fence_regression.sql',
), 'utf8')

function functionBody(signature: string, nextMarker: string): string {
  const start = migration.indexOf(signature)
  const end = migration.indexOf(nextMarker, start + signature.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('Licensing credential-document authority fence', () => {
  it('serializes one credential and deterministically selects its newest stored document', () => {
    const helper = functionBody(
      'create or replace function private.reconcile_licensing_credential_document_authority(',
      'revoke all on function private.reconcile_licensing_credential_document_authority',
    )

    expect(helper).toContain('where credential.id = target_credential_id\n  for update;')
    expect(helper).toContain("and document.upload_state = 'stored'")
    expect(helper).toContain('and document.archived_at is null')
    expect(helper).toContain('order by document.uploaded_at desc, document.id desc')
    expect(helper).toContain('credential.document_path is not distinct from prior_document_path')
    expect(helper).toContain("'LICENSING_DOCUMENT_AUTHORITY_RECONCILED'")
    expect(migration).toContain(
      'from public, anon, authenticated, service_role;',
    )
    expect(migration).toContain(
      'revoke all on function public.record_licensing_credential_document(uuid, text, text, text, bigint)',
    )
  })

  it('uses the same authority helper for interactive completion and exact retries', () => {
    const interactive = functionBody(
      'create or replace function public.service_complete_licensing_document_upload(',
      '-- Scheduled recovery applies the same row-locked winner selection.',
    )
    const exactRetry = interactive.indexOf("if document_record.upload_state = 'stored' then")
    const retryFence = interactive.indexOf(
      'private.reconcile_licensing_credential_document_authority(',
      exactRetry,
    )
    const stateTransition = interactive.indexOf(
      "set upload_state = 'stored'",
      retryFence,
    )
    const completionFence = interactive.indexOf(
      'private.reconcile_licensing_credential_document_authority(',
      stateTransition,
    )

    expect(exactRetry).toBeGreaterThanOrEqual(0)
    expect(retryFence).toBeGreaterThan(exactRetry)
    expect(stateTransition).toBeGreaterThan(retryFence)
    expect(completionFence).toBeGreaterThan(stateTransition)
    expect(interactive).toContain("'interactive_exact_retry'")
    expect(interactive).toContain("'interactive_completion'")
  })

  it('fences scheduled recovery and covers out-of-order overlap with rollback tests', () => {
    const recovery = functionBody(
      'create or replace function public.service_complete_licensing_document_upload_recovery(',
      'revoke all on function public.service_complete_licensing_document_upload(',
    )
    const exactRetry = recovery.indexOf("if document_record.upload_state = 'stored' then")
    const retryFence = recovery.indexOf(
      'private.reconcile_licensing_credential_document_authority(',
      exactRetry,
    )
    const stateTransition = recovery.indexOf(
      "set upload_state = 'stored'",
      retryFence,
    )
    const recoveryFence = recovery.indexOf(
      'private.reconcile_licensing_credential_document_authority(',
      stateTransition,
    )

    expect(retryFence).toBeGreaterThan(exactRetry)
    expect(recoveryFence).toBeGreaterThan(stateTransition)
    expect(recovery).toContain("'scheduled_recovery_exact_retry'")
    expect(recovery).toContain("'scheduled_recovery_completion'")
    expect(rollbackRegression).toContain(
      'Out-of-order interactive completion must preserve the newest document path.',
    )
    expect(rollbackRegression).toContain(
      'Recovery overlap must preserve the newest stored document path.',
    )
    expect(rollbackRegression).toContain(
      'An exact recovery retry must not duplicate the recovered audit event.',
    )
    expect(rollbackRegression.trimEnd()).toMatch(/rollback;$/)
  })
})

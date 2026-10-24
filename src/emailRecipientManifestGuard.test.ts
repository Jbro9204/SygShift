import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20261024153000_durable_email_recipient_dispatch.sql',
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

describe('durable email recipient manifest guardrails', () => {
  it('persists one immutable source-level normalized recipient set', () => {
    expect(migration).toContain('create table private.email_recipient_dispatch_manifests')
    expect(migration).toContain('primary key (source_kind, source_id)')
    expect(migration).toContain('email_recipient_dispatch_manifest_immutable')
    expect(migration).toContain('Email recipient manifests are immutable.')
    expect(migration).toContain('revoke all on table private.email_recipient_dispatch_manifests from public, anon, authenticated, service_role;')
    expect(migration).toContain(
      "coalesce(array_agg(unique_recipient.recipient order by unique_recipient.recipient), array[]::text[])",
    )
  })

  it('serializes first creation and rejects every non-exact batch retry before dispatch rows', () => {
    const manifest = section(
      'create or replace function private.ensure_email_recipient_dispatch_manifest(',
      'revoke all on function private.ensure_email_recipient_dispatch_manifest',
    )
    const batch = section(
      'create or replace function public.service_prepare_email_recipient_dispatch_batch(',
      '-- Unknown provider outcomes are deliberately not guessed.',
    )
    const lock = manifest.indexOf('pg_catalog.pg_advisory_xact_lock(')
    const lookup = manifest.indexOf('from private.email_recipient_dispatch_manifests manifest', lock)
    const insert = manifest.indexOf('insert into private.email_recipient_dispatch_manifests', lookup)
    const exactSet = manifest.indexOf(
      'manifest_record.intended_recipients is distinct from normalized_recipients',
      insert,
    )

    expect(lock).toBeGreaterThanOrEqual(0)
    expect(manifest).toContain("'email-recipient-manifest:' || target_source_kind || ':' || target_source_id::text")
    expect(lookup).toBeGreaterThan(lock)
    expect(insert).toBeGreaterThan(lookup)
    expect(exactSet).toBeGreaterThan(insert)
    expect(manifest).toContain('Email recipients do not match the original dispatch manifest.')
    expect(batch.indexOf('private.ensure_email_recipient_dispatch_manifest('))
      .toBeLessThan(batch.indexOf('public.service_prepare_email_recipient_dispatch('))
    expect(batch).toContain('true')
  })

  it('prevents single-recipient callers and prepared Worker decisions from bypassing the manifest', () => {
    const single = section(
      'create or replace function public.service_prepare_email_recipient_dispatch(',
      '-- Establish the complete recipient manifest in one transaction',
    )
    expect(single).toContain('private.ensure_email_recipient_dispatch_manifest(')
    expect(single).toContain('false')
    expect(migration).toContain('Email recipient is not part of the original dispatch manifest.')
    expect(worker).toContain('preparedDecisions.size !== uniqueRecipients.length')
    expect(worker).toContain('does not exactly match the delivery recipients')
  })
})

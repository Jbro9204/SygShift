import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260930133740_accountability_calloff_idempotency_repair.sql',
  'utf8',
)
const worker = readFileSync('worker/index.ts', 'utf8')
const accountabilityData = readFileSync('src/data/accountability.ts', 'utf8')
const accountabilityPage = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')

describe('accountability call-off idempotency repair guardrails', () => {
  it('resolves only an unambiguous current published assignment and serializes logical retries', () => {
    expect(migration).toContain('private.resolve_published_accountability_shift(')
    expect(migration).toContain("if source_status <> 'superseded' then")
    expect(migration).toContain("schedule.status = 'published'")
    expect(migration).toContain('private.same_scheduled_occurrence(target_shift_id, candidate.id)')
    expect(migration).toContain('if coalesce(cardinality(resolved_shift_ids), 0) = 1 then')
    expect(migration).toContain("pg_advisory_xact_lock(hashtextextended('attendance-occurrence:'")
  })

  it('returns the canonical event and coverage handoff for exact or revision retries', () => {
    expect(migration).toContain('private.canonical_attendance_accountability_event(')
    expect(migration).toContain('private.canonical_attendance_call_off_report(')
    expect(migration).toContain("'callOffId', call_off_id")
    expect(migration).toContain("'created', false")
    expect(migration).toContain("'alreadyRecorded', true")
    expect(accountabilityData).toContain('alreadyRecorded: z.boolean().optional().default(false)')
  })

  it('links retained duplicate history instead of deleting factual records', () => {
    expect(migration).toContain('duplicate_of_event_id uuid')
    expect(migration).toContain('duplicate_of_call_off_report_id uuid')
    expect(migration).toContain("'LINK_DUPLICATE'")
    const reconciliation = migration.slice(
      migration.indexOf('-- Reconcile pre-existing revision duplicates'),
      migration.indexOf('-- Terminal coverage decisions close their operational alert immediately.'),
    )
    expect(reconciliation).not.toMatch(/delete\s+from/i)
  })

  it('closes terminal coverage alerts and hides linked duplicates from every operational reader', () => {
    expect(migration).toContain('private.clear_call_off_operational_alert_on_close()')
    expect(migration).toContain('after insert or update of resolved_at, canceled_at on public.call_off_reports')
    expect(migration).toContain("lifecycle_state = 'resolved'")
    expect(migration).toContain('where coalesce(native_event.duplicate_of_event_id is null, true)')
    expect(migration).toContain('$request_center_canonical_call_offs$')
    expect(migration).toContain('$short_notice_canonical_call_offs$')
    expect(migration).toContain('$workforce_activity_canonical_call_offs$')
  })

  it('suppresses delivered Dispatch retries while allowing failed delivery to recover', () => {
    const retryBoundary = worker.slice(
      worker.indexOf('if (report.created === false && report.dispatchAlreadyNotified === true)'),
      worker.indexOf('let dispatchNotified = false'),
    )
    expect(worker).toContain('if (report.created === false && report.dispatchAlreadyNotified === true)')
    expect(retryBoundary).toContain('alreadyRecorded: true')
    expect(retryBoundary).toContain('dispatchAlreadyNotified')
    expect(retryBoundary).not.toContain('sendAuditedEmail')
    expect(accountabilityPage).toContain('Continue the existing coverage workflow instead of entering it again.')
    expect(accountabilityPage).toContain('Continue coverage')
    expect(accountabilityPage).toContain('queryKey: ["workforce-activity-report"]')
    expect(accountabilityPage).toContain('queryKey: ["my-notifications"]')
  })
})

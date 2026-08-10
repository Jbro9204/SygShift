/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260810143000_timekeeping_exception_resolution.sql'),
  'utf8',
)
const exceptionPage = readFileSync(join(root, 'src', 'time', 'TimeExceptionsPage.tsx'), 'utf8')
const timekeepingData = readFileSync(join(root, 'src', 'data', 'timekeeping.ts'), 'utf8')
const payrollWorkbook = readFileSync(join(root, 'src', 'time', 'payrollWorkbook.ts'), 'utf8')

describe('timekeeping exception-resolution guardrails', () => {
  it('recognizes a completed return-to-work segment while keeping its gap unpaid', () => {
    expect(migration).toContain("or (previous_kind = 'clock_out' and kind = 'clock_in')")
    expect(migration).toContain("where kind = 'clock_out'")
    expect(migration).toContain("and next_kind = 'clock_in'")
    expect(migration).toContain("'unpaidGapMinutes'")
    expect(migration).toContain("'segments'")
    expect(migration).toContain("then extract(epoch from next_effective_at - effective_at) / 60")
  })

  it('keeps decisions append-only, occurrence-specific, permission-backed, and audited', () => {
    expect(migration).toContain('create table public.timekeeping_exception_resolutions')
    expect(migration).toContain('timekeeping_exception_resolutions_append_only')
    expect(migration).toContain('private.prevent_append_only_change()')
    expect(migration).toContain('timekeeping_exception_resolutions_audit')
    expect(migration).toContain('private.write_audit_event()')
    expect(migration).toContain("public.has_effective_permission('time.resolve_exceptions')")
    expect(migration).toContain('public.has_mfa()')
    expect(migration).toContain('target_occurrence_fingerprint')
    expect(migration).toContain('The punches or schedule changed after this blocker was opened.')
    expect(migration).toContain('char_length(clean_reason) < 8')
  })

  it('allows only named judgment calls and retains hard payroll blockers', () => {
    expect(migration).toContain("code in ('unscheduled', 'multiple_work_segments', 'schedule_deviation', 'multiple_locations')")
    expect(migration).toContain("clean_code not in ('unscheduled', 'multiple_work_segments', 'schedule_deviation', 'multiple_locations')")
    expect(migration).toContain('This is a hard payroll blocker and cannot be bypassed.')
    for (const hardCode of ['missing_clock_in', 'missing_clock_out', 'invalid_sequence', 'pending_correction', 'zero_paid_minutes']) {
      expect(migration).not.toContain(`clean_code not in ('${hardCode}')`)
    }
  })

  it('requires an explicit reviewed decision in the UI without altering punches', () => {
    expect(exceptionPage).toContain('Punch timeline')
    expect(exceptionPage).toContain('Calculated work segments')
    expect(exceptionPage).toContain('Unpaid gaps')
    expect(exceptionPage).toContain('Approve valid exception')
    expect(exceptionPage).toContain('Dismiss false positive')
    expect(exceptionPage).toContain('Required reason')
    expect(exceptionPage).toContain('Leave unresolved')
    expect(exceptionPage).toContain('This applies only to this exact set of punches.')
    expect(timekeepingData).toContain("rpc('resolve_timekeeping_exception'")
  })

  it('carries exception decisions into locked payroll exports', () => {
    expect(migration).toContain("''exceptionResolutionHistory'', coalesce(export_batch.review_payload -> ''exceptionResolutionHistory''")
    expect(payrollWorkbook).toContain("name: 'Exception Decisions'")
    expect(payrollWorkbook).toContain('Original punches remain unchanged.')
  })
})

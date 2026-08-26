/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const lifecycle = readFileSync(
  join(root, 'supabase', 'migrations', '20260826210000_operational_alert_lifecycle_reconciliation.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('operational alert lifecycle reconciliation', () => {
  it('uses a stable real-world occurrence key and prevents unresolved schedule-revision duplicates', () => {
    expect(lifecycle).toContain('private.timekeeping_operational_occurrence_key')
    expect(lifecycle).toContain('timekeeping_operational_exceptions_one_unresolved_occurrence_idx')
    expect(lifecycle).toContain("where status = 'unresolved' and occurrence_key is not null")
    expect(lifecycle).toContain("resolution_method = 'superseded_duplicate'")
    expect(lifecycle).toContain("'resolved_duplicate'")
  })

  it('resolves only authoritative corrections and preserves unresolved no-shows for payroll', () => {
    expect(lifecycle).toContain("when shift.canceled_at is not null then 'shift_canceled'")
    expect(lifecycle).toContain("then 'call_off'")
    expect(lifecycle).toContain("then 'clock_in_received'")
    expect(lifecycle).toContain("private.current_effective_time_event_kind(event.id) = 'clock_in'")
    expect(lifecycle).toContain("when 'clock_in_received' then 'resolved_clock_in_received'")
    expect(lifecycle).toContain("then 'assignment_changed'")
    expect(lifecycle).toContain("lifecycle_state = 'payroll_review'")
    expect(lifecycle).toContain("exception.status = 'unresolved'")
    expect(lifecycle).not.toMatch(/delete\s+from\s+public\.(timekeeping_operational_exceptions|operational_alerts|time_events|shifts)/i)
  })

  it('keeps missing clock-ins live through the shift plus one hour, then removes only the live alert', () => {
    expect(lifecycle).toContain("exception.scheduled_end_at + interval '1 hour'")
    expect(lifecycle).toContain("clear_source = 'payroll_handoff'")
    expect(lifecycle).toContain('The unresolved occurrence remains available for payroll review.')
  })

  it('runs incremental reconciliation every minute and a full integrity pass at 2 AM Mountain', () => {
    expect(worker).toContain("'service_reconcile_operational_alert_lifecycle'")
    expect(worker).toContain("timeZone: 'America/Denver'")
    expect(worker).toContain("denverHour === '02' && denverMinute === '00'")
    expect(worker).toContain('{ target_full_reconciliation: fullReconciliation }')
  })

  it('keeps acknowledgment separate from global alert resolution', () => {
    expect(lifecycle).not.toContain('delete from public.operational_alert_acknowledgments')
    expect(lifecycle).not.toContain('update public.operational_alert_acknowledgments')
    expect(lifecycle).toContain("clear_source text")
    expect(lifecycle).toContain("cleared_reason text")
  })
})

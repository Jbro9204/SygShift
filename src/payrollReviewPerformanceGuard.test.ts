/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrations = [
  '20260821173000_payroll_review_set_based_performance.sql',
  '20260821174500_payroll_review_context_equivalence.sql',
  '20260821175000_occurrence_context_effective_event_performance.sql',
  '20260821175500_set_based_occurrence_identity.sql',
  '20260824234500_payroll_review_session_timeout_repair.sql',
].map((name) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8'))

const [reviewMigration, equivalenceMigration, contextMigration, identityMigration, timeoutRepairMigration] = migrations

describe('payroll review performance and occurrence integrity', () => {
  it('reads corrections and overrides once from a shared set-based punch source', () => {
    expect(reviewMigration).toContain('private.get_effective_time_events(')
    expect(reviewMigration).toContain('effective_events as materialized (')
    expect(reviewMigration).toContain('occurrence_contexts as (')
    expect(reviewMigration).toContain('payrollAssignmentAnchorSeed')
    expect(reviewMigration).toContain('payrollOccurrenceKeySeed')
  })

  it('retains occurrence-aware review for incomplete and multi-segment work', () => {
    expect(equivalenceMigration).toContain("not coalesce((base_row ->> 'sequenceComplete')::boolean, false)")
    expect(equivalenceMigration).toContain("coalesce((base_row ->> 'eventCount')::integer, 0) > 2")
    expect(equivalenceMigration).toContain('private.get_timekeeping_occurrence_context(')
    expect(equivalenceMigration).toContain("'validSequence'")
  })

  it('uses the shared effective-event source in both occurrence-context overloads', () => {
    expect(contextMigration).toContain("'private.get_timekeeping_occurrence_context(uuid,uuid,date)'::regprocedure")
    expect(contextMigration).toContain("'private.get_timekeeping_occurrence_context(uuid,uuid,date,timestamptz)'::regprocedure")
    expect(contextMigration).toContain('private.get_effective_time_events(target_employee_id)')
  })

  it('preserves immutable punch identity while resolving sessions without row-by-row correction scans', () => {
    expect(identityMigration).toContain('private.get_effective_time_events_with_occurrence(')
    expect(identityMigration).toContain('event.original_shift_id is not null')
    expect(identityMigration).toContain("'unscheduled-session:' || unscheduled.session_event_id::text")
    expect(identityMigration).toContain('event.occurrence_key = (select anchor.occurrence_key')
    expect(identityMigration).not.toContain('update public.time_events')
    expect(identityMigration).not.toContain('delete from public.time_events')
  })

  it('keeps payroll session assignment set-based for full pay-period reviews', () => {
    expect(timeoutRepairMigration).toContain('session_membership as materialized (')
    expect(timeoutRepairMigration).toContain('session_candidates as materialized (')
    expect(timeoutRepairMigration).toContain('rows between unbounded preceding and 1 preceding')
    expect(timeoutRepairMigration).toContain("target.effective_at - interval '24 hours'")
    expect(timeoutRepairMigration).toContain('private.get_effective_time_events(target_employee_id)')
    expect(timeoutRepairMigration).toContain("position('private.get_unscheduled_time_session_start(event.id' in review_sql) > 0")
    expect(timeoutRepairMigration).not.toContain('update public.time_events')
    expect(timeoutRepairMigration).not.toContain('delete from public.time_events')
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const indexMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20261026165217_timekeeping_due_shift_index.sql'),
  'utf8',
)
const repairMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20261026165219_scheduled_runtime_molecular_repair.sql'),
  'utf8',
)
const eventIndexMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20261026165218_timekeeping_employee_shift_event_index.sql'),
  'utf8',
)
const indexPostflight = readFileSync(
  join(root, 'supabase', 'migrations', '20261026170133_scheduled_runtime_index_postflight.sql'),
  'utf8',
)
const recovery = readFileSync(
  join(root, 'supabase', 'recovery', '20261026165219_scheduled_runtime_molecular_repair.sql'),
  'utf8',
)
const dueIndexRecovery = readFileSync(
  join(root, 'supabase', 'recovery', '20261026165217_timekeeping_due_shift_index.sql'),
  'utf8',
)
const eventIndexRecovery = readFileSync(
  join(root, 'supabase', 'recovery', '20261026165218_timekeeping_employee_shift_event_index.sql'),
  'utf8',
)
const regression = readFileSync(
  join(root, 'supabase', 'tests', 'scheduled_runtime_molecular_repair_regression.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const webPush = readFileSync(join(root, 'worker', 'webPush.ts'), 'utf8')
const automationBaselineMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260826100000_auto_clock_out_revision_continuity.sql'),
  'utf8',
)
const attendanceBaselineMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260912020000_attendance_alert_schedule_refresh.sql'),
  'utf8',
)

function dollarConstant(source: string, name: string, tag: 'old' | 'new'): string {
  const prefix = `${name} constant text := $${tag}$`
  const start = source.indexOf(prefix)
  if (start < 0) throw new Error(`Missing ${name}`)
  const valueStart = start + prefix.length
  const suffix = `$${tag}$;`
  const end = source.indexOf(suffix, valueStart)
  if (end < 0) throw new Error(`Unterminated ${name}`)
  return source.slice(valueStart, end)
}

function replaceExactlyOnce(source: string, from: string, to: string): string {
  const first = source.indexOf(from)
  expect(first).toBeGreaterThanOrEqual(0)
  expect(source.indexOf(from, first + from.length)).toBe(-1)
  return source.slice(0, first) + to + source.slice(first + from.length)
}

describe('scheduled-runtime molecular repair', () => {
  it('starts timekeeping automation from indexed materialized due-shift ranges', () => {
    expect('20261026165217'.localeCompare('20261026165218')).toBeLessThan(0)
    expect('20261026165218'.localeCompare('20261026165219')).toBeLessThan(0)
    expect(indexMigration).toContain('create index concurrently if not exists shifts_timekeeping_due_end_idx')
    expect(indexMigration).toContain('on public.shifts (ends_at, id)')
    expect(eventIndexMigration).toContain('time_events_employee_shift_recorded_idx')
    expect(eventIndexMigration).toContain('on public.time_events (employee_id, shift_id, recorded_at desc, id)')
    expect(indexPostflight).toContain('index_state.indisvalid')
    expect(indexPostflight).toContain('index_state.indisready')
    expect(indexPostflight).toContain('time_events_employee_shift_recorded_idx')
    expect(repairMigration).toContain("to_regclass('public.time_events_employee_shift_recorded_idx')")
    expect(repairMigration).toContain('The reviewed employee-occurrence event index must exist')
    expect(dueIndexRecovery).toContain('drop index concurrently if exists public.shifts_timekeeping_due_end_idx')
    expect(eventIndexRecovery).toContain('drop index concurrently if exists public.time_events_employee_shift_recorded_idx')
    expect(indexMigration).toContain('where canceled_at is null')
    expect(repairMigration).toContain('with due_shifts as materialized')
    expect(repairMigration).toContain('with due_missing_shifts as materialized')
    const automaticDueRange = dollarConstant(repairMigration, 'automatic_header_new', 'new')
    const missingDueRange = dollarConstant(repairMigration, 'missing_header_new', 'new')
    expect(automaticDueRange).toContain("shift.ends_at >= statement_timestamp() - interval '7 days'")
    expect(automaticDueRange).not.toContain('clock_timestamp()')
    expect(missingDueRange).toContain("shift.starts_at >= statement_timestamp() - interval '7 days'")
    expect(missingDueRange).not.toContain('clock_timestamp()')
    expect(repairMigration).toContain('from due_shifts shift')
    expect(repairMigration).toContain('from due_missing_shifts shift')
    expect(repairMigration).toContain('occurrence_schedule.week_starts_on = schedule.week_starts_on')
    expect(repairMigration).toContain('occurrence_schedule.week_starts_on = target_schedule.week_starts_on')
    expect(repairMigration).not.toMatch(/statement_timeout\s*=\s*'(?:[4-9]\d|\d{3,})s'/i)
  })

  it('keeps service-only execution and exact guarded recovery', () => {
    expect(repairMigration).toContain("md5(automation_definition) <> '5f8bb3822085eb6ce7d77be0e25941c4'")
    expect(repairMigration).toContain("md5(attendance_definition) <> '0551c29b020e668744d199a0ac736233'")
    expect(repairMigration).toContain('revoke all on function public.service_run_timekeeping_automation(uuid)')
    expect(repairMigration).toContain('grant execute on function public.service_run_timekeeping_automation(uuid)')
    expect(repairMigration).toContain('to service_role')
    expect(recovery).toContain("md5(recovered_automation) <> '5f8bb3822085eb6ce7d77be0e25941c4'")
    expect(recovery).toContain("md5(recovered_attendance) <> '0551c29b020e668744d199a0ac736233'")
    expect(recovery).toContain("shift.ends_at >= statement_timestamp() - interval '7 days'")
    expect(recovery).toContain("shift.starts_at >= statement_timestamp() - interval '7 days'")
    expect(recovery).not.toMatch(/delete\s+from\s+public\./i)
    expect(recovery).not.toMatch(/update\s+public\./i)
  })

  it('transforms each reviewed baseline once and the recovery restores it byte-for-byte', () => {
    const originalMissing = "and event.shift_id = shift.id\n          and event.kind = 'clock_in'"
    const revisionMissing = "and private.same_scheduled_occurrence(event.shift_id, shift.id)\n          and private.current_effective_time_event_kind(event.id) = 'clock_in'"
    const originalResolve = 'where event.shift_id = exception.shift_id\n            and event.employee_id = exception.employee_id'
    const revisionResolve = 'where private.same_scheduled_occurrence(event.shift_id, exception.shift_id)\n            and event.employee_id = exception.employee_id'
    let automationBaseline = replaceExactlyOnce(automationBaselineMigration, originalMissing, revisionMissing)
    automationBaseline = replaceExactlyOnce(automationBaseline, originalResolve, revisionResolve)

    const automationTransforms = [
      'automatic_header',
      'automatic_join',
      'automatic_filter',
      'missing_header',
      'missing_join',
      'missing_filter',
      'missing_event',
      'resolve_event',
    ]
    let candidate = automationBaseline
    for (const name of automationTransforms) {
      candidate = replaceExactlyOnce(
        candidate,
        dollarConstant(repairMigration, `${name}_old`, 'old'),
        dollarConstant(repairMigration, `${name}_new`, 'new'),
      )
    }
    expect(candidate).toContain('with due_shifts as materialized')
    expect(candidate).toContain('time_events event')

    let restored = candidate
    for (const name of automationTransforms) {
      restored = replaceExactlyOnce(
        restored,
        dollarConstant(recovery, `${name}_old`, 'old'),
        dollarConstant(recovery, `${name}_new`, 'new'),
      )
    }
    expect(restored).toBe(automationBaseline)

    const attendanceOld = dollarConstant(repairMigration, 'attendance_anchor_old', 'old')
    const attendanceNew = dollarConstant(repairMigration, 'attendance_anchor_new', 'new')
    const attendanceCandidate = replaceExactlyOnce(attendanceBaselineMigration, attendanceOld, attendanceNew)
    const attendanceRestored = replaceExactlyOnce(
      attendanceCandidate,
      dollarConstant(recovery, 'attendance_anchor_old', 'old'),
      dollarConstant(recovery, 'attendance_anchor_new', 'new'),
    )
    expect(attendanceRestored).toBe(attendanceBaselineMigration)
  })

  it('forces value-aware attendance plans and proves candidate parity and idempotency', () => {
    expect(repairMigration).toContain("set_config('plan_cache_mode', 'force_custom_plan', true)")
    expect(regression).toContain('$automatic_candidate_parity$')
    expect(regression).toContain('$missing_candidate_parity$')
    expect(regression).toContain('$resolution_evidence_parity$')
    expect(regression).toContain('$synthetic_occurrence_parity$')
    expect(regression).toContain('$automation_idempotency$')
    expect(regression).toContain('rollback;')
  })

  it('stages database-wide lanes instead of stacking them on the 02:00 tick', () => {
    expect(worker).toContain("attendanceFullReconciliation: (hour === '02' || springForwardFallback) && minute === 0")
    expect(worker).toContain("operationalAlertFullReconciliation: (hour === '02' || springForwardFallback) && minute === 10")
    expect(worker).toContain("const springForwardFallback = hour === '03' && previousHour === '01'")
    expect(worker).toContain('const availabilityRecoveryDue = !attendanceFullReconciliation && minute % 15 === 0')
    expect(worker).toContain('{ target_full_reconciliation: attendanceFullReconciliation }')
    expect(worker).toContain('{ target_full_reconciliation: operationalAlertFullReconciliation }')
    expect(worker).toContain('fullReconciliation: attendanceFullReconciliation')
  })

  it('does not couple the molecular release to the unactivated durability database contract', () => {
    for (const source of [worker, webPush]) {
      expect(source).not.toContain('service_reconcile_employee_push_provider_outcomes')
      expect(source).not.toContain('service_mark_employee_push_provider_state')
      expect(source).not.toContain('provider_state')
    }
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260826200000_scheduler_mixed_coverage_assignments.sql'),
  'utf8',
)
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const scheduleData = readFileSync(join(root, 'src', 'data', 'schedule.ts'), 'utf8')
const appStyles = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const overtimeGuardrailMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260831051000_schedule_overtime_guardrail.sql'),
  'utf8',
)

describe('scheduler mixed coverage and additive assignment', () => {
  it('creates distinct armed and unarmed positions under one coverage plan', () => {
    expect(migration).toContain('create or replace function public.scheduler_create_coverage_plan')
    expect(migration).toContain('target_armed_headcount integer')
    expect(migration).toContain('unarmed_headcount := target_headcount - target_armed_headcount;')
    expect(migration).toContain('target_armed_headcount, true, true')
    expect(migration).toContain('unarmed_headcount, false, true')
    expect(migration).toContain("'armed_headcount', target_armed_headcount")
    expect(migration).toContain("'unarmed_headcount', unarmed_headcount")
  })

  it('preserves an explicit shift requirement instead of forcing the post default', () => {
    expect(migration).toContain('alter column requires_armed drop default')
    expect(migration).toContain('before insert or update of post_id, event_id, requires_armed')
    expect(migration).toContain('new.requires_armed is null')
    expect(migration).toContain('new.requires_armed := inherited_requires_armed;')
  })

  it('adds one employee without canceling or replacing existing assignments', () => {
    const additiveFunction = migration.slice(
      migration.indexOf('create or replace function public.scheduler_add_draft_shift_assignment'),
      migration.indexOf('create or replace function public.scheduler_create_coverage_plan'),
    )
    const guardedWrapper = overtimeGuardrailMigration.slice(
      overtimeGuardrailMigration.indexOf('create or replace function public.scheduler_add_draft_shift_assignment_v2'),
      overtimeGuardrailMigration.indexOf('create or replace function public.scheduler_add_draft_shift_assignment('),
    )

    expect(additiveFunction).toContain('insert into public.shift_assignments')
    expect(additiveFunction).toContain('private.active_shift_assignment_count(target_shift.id) >= target_shift.headcount_required')
    expect(additiveFunction).not.toContain('delete from public.shift_assignments')
    expect(additiveFunction).not.toContain("set status = 'canceled'")
    expect(additiveFunction).not.toContain('update public.shift_assignments')
    expect(guardedWrapper).toContain('public.scheduler_add_draft_shift_assignment_core(')
    expect(guardedWrapper).toContain("'scheduled_overtime'")
  })

  it('exposes total and armed-position controls with a clear mix summary', () => {
    expect(schedulePage).toContain('Total guards needed')
    expect(schedulePage).toContain('Armed positions')
    expect(schedulePage).toContain('Initial guard position')
    expect(schedulePage).toContain('openShiftUnarmedHeadcount')
    expect(schedulePage).toContain('Add guard to open position')
    expect(schedulePage).toContain('Everyone already assigned remains on the draft.')
    expect(appStyles).toContain('.schedule-builder-coverage-mix')
  })

  it('uses the new database contracts from the data layer', () => {
    expect(scheduleData).toContain("getSupabaseClient().rpc('scheduler_create_coverage_plan_v2'")
    expect(scheduleData).toContain("getSupabaseClient().rpc('scheduler_add_draft_shift_assignment_v2'")
    expect(scheduleData).toContain('target_armed_headcount: input.armedHeadcount')
    expect(scheduleData).toContain("target_assignment_requires_armed: input.assignmentRequirement === 'armed'")
    expect(scheduleData).toContain('target_overtime_override_note: input.overtimeOverrideNote?.trim() || null')
  })
})

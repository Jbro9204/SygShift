import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath = 'supabase/migrations/20260925182312_enforce_schedule_dst_boundaries.sql'
const regressionPath = 'supabase/tests/schedule_dst_boundary_regression.sql'

describe('schedule DST boundary migration guardrails', () => {
  const migration = readFileSync(migrationPath, 'utf8')
  const regression = readFileSync(regressionPath, 'utf8')

  it('validates both wall clocks before every supported create and edit core', () => {
    expect(migration).toContain('private.validate_schedule_wall_clock_range')
    expect(migration).toContain('starts_at at time zone target_time_zone is distinct from entered_local_start')
    expect(migration).toContain('ends_at at time zone target_time_zone is distinct from entered_local_end')
    expect(migration).toContain('public.scheduler_create_coverage_plan_v3')
    expect(migration).toContain('public.scheduler_create_coverage_plan_batch_v1')
    expect(migration).toContain('public.scheduler_create_employee_local_coverage_plan_v3')
    expect(migration).toContain('public.scheduler_update_typed_draft_shift_v2')
    expect(migration).toContain('public.scheduler_update_typed_draft_shift_v3')
    expect(migration).toContain('select shift.* into target_shift')
    expect(migration).toContain('select schedule.* into target_schedule')
  })

  it('keeps compatible RPCs while isolating every unvalidated implementation', () => {
    expect(migration).toContain('scheduler_create_coverage_plan_unvalidated')
    expect(migration).toContain('scheduler_create_employee_local_coverage_plan_unvalidated')
    expect(migration).toContain('scheduler_create_employee_local_coverage_plan_v2_unvalidated')
    expect(migration).toContain('public.create_supervisor_open_shift')
    expect(migration).toContain('public.update_schedule_draft_shift')
    expect(migration).toContain('public.get_scheduled_overtime_create_preview_v2')
    expect(migration).toContain('public.get_scheduled_overtime_update_preview_v2')
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain('The guarded schedule boundary privilege was not preserved')
    expect(migration).toContain('The repeated coverage boundary is not zone-bound and atomic')
    expect(migration).toContain('cross join lateral private.validate_employee_schedule_wall_clock_range(')
  })

  it('requires a supported standalone-event zone and preserves linked-Site authority', () => {
    expect(migration).toContain('private.resolve_schedule_source_time_zone')
    expect(migration).toContain("raise check_violation using message = 'Choose the event time zone.'")
    expect(migration).toContain('target_event_site_id is not null')
    expect(migration).toContain("'America/Phoenix', 'America/Los_Angeles'")
    expect(migration).not.toContain("coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver')")
    expect(migration).toContain('create or replace function private.set_shift_security_fields()')
    expect(migration).toContain("tg_op = 'UPDATE' and not source_changed and not provenance_changed")
    expect(migration).toContain('new.time_zone := old.time_zone')
    expect(migration).toContain('The shift security trigger does not preserve recorded edit basis')
    expect(regression).toContain('The active standalone-event create path defaulted a missing zone')
    expect(regression).toContain('The atomic standalone-event path defaulted a missing zone')
    expect(regression).toContain('A linked event trusted a stale caller zone instead of the Site authority')
  })

  it('makes schedules, shifts, and assignments audited RPC-only mutations', () => {
    expect(migration).toContain('revoke insert, update, delete on table public.shifts from anon, authenticated')
    expect(migration).toContain('revoke insert, update, delete on table public.shift_assignments from anon, authenticated')
    expect(migration).toContain('revoke insert, update, delete on table public.schedules from anon, authenticated')
    expect(migration).toContain("has_table_privilege('authenticated', 'public.shifts', 'INSERT')")
    expect(migration).toContain("has_table_privilege('authenticated', 'public.shift_assignments', 'INSERT')")
    expect(migration).toContain("has_table_privilege('authenticated', 'public.schedules', 'UPDATE')")
  })

  it('retires fixed-instant copy access and keeps the current wrapper on the repaired core', () => {
    expect(migration).toContain('public.copy_schedule_week_to_draft(date, date, boolean, boolean)')
    expect(migration).toContain('from public, anon, authenticated')

    const wrapperStart = migration.indexOf(
      'create or replace function public.replace_schedule_week_draft_with_work_types(',
    )
    const wrapperEnd = migration.indexOf(
      'create or replace function public.scheduler_create_coverage_plan_v2(',
      wrapperStart,
    )
    const wrapper = migration.slice(wrapperStart, wrapperEnd)

    expect(wrapper).toContain('public.replace_schedule_week_draft_from_revision(')
    expect(wrapper).not.toContain('make_interval')
    expect(wrapper).not.toContain('destination.starts_at = source.starts_at')
    expect(migration).toContain('when event.site_id is null then event.time_zone')
    expect(migration).toContain('else site.time_zone')
    expect(migration).toContain('left join public.sites site on site.id = event.site_id')
  })

  it('proves create, edit, preview, compatibility, provenance, and direct-write behavior', () => {
    expect(regression).toContain('Site Time create accepted a nonexistent spring-forward start')
    expect(regression).toContain('Employee Time v3 create accepted a nonexistent spring-forward start')
    expect(regression).toContain('The actively used typed open-shift RPC bypassed DST validation')
    expect(regression).toContain('The repeated-date overtime preview normalized a spring gap')
    expect(regression).toContain('A later repeat failure left the earlier date committed')
    expect(regression).toContain('The atomic repeat RPC did not bind save to the previewed zone')
    expect(regression).toContain('The rejected typed v3 edit changed the shift before validation completed')
    expect(regression).toContain('An ordinary edit reinterpreted Employee Time after the employee profile zone changed')
    expect(regression).toContain('An ordinary edit reinterpreted Site Time after the Site zone changed')
    expect(regression).toContain('Reassignment silently changed the stored Employee Time source or instant')
    expect(regression).toContain('Authenticated direct assignment INSERT can bypass the source contract')
    expect(regression).toContain('rollback;')
  })
})

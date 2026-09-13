import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260913175135_absence_coverage_workflow.sql', 'utf8')
const requests = readFileSync('src/pages/RequestsPage.tsx', 'utf8')
const accountability = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')

describe('absence-to-coverage workflow guardrails', () => {
  it('preserves the original assignment and creates a separate coverage shift', () => {
    expect(migration).toContain('original_assignment_snapshot jsonb not null')
    expect(migration).toContain('coverage_shift_id uuid unique references public.shifts')
    expect(migration).toContain('coverage_source_shift_id uuid references public.shifts')
    expect(migration).toContain('private.create_absence_coverage_shift(shift_record.id, actor_id)')
    expect(migration).toContain('create trigger schedules_remap_shift_coverage_revision')
    expect(migration).toContain("'coverage_revision_rebased'")
    expect(migration).toContain("'assignmentId', original_assignment.id")
    expect(migration).toContain("'scheduleId', shift_record.schedule_id")
    expect(migration).toContain('Absence coverage copy; the original assignment remains preserved.')
    expect(migration).not.toContain('where id = coverage_case.source_assignment_id')
    expect(migration).toContain('where id = coverage_shift.id')
    expect(migration).toContain("'publish_absence_coverage'")
    expect(migration).toContain("'notificationQueued', false")
    expect(requests).toContain('The original schedule will not disappear')
  })

  it('keeps unexcused separate from an unconfigured points policy and payroll', () => {
    expect(migration).toContain("'confirmed', 'unexcused', 'excused_protected'")
    expect(migration).not.toContain('attendance_points')
    expect(accountability).toContain('<option value="unexcused">Mark unexcused</option>')
    expect(accountability).toContain('without assigning points or changing payroll')
  })

  it('validates replacement eligibility at the database boundary', () => {
    expect(migration).toContain('private.assignment_availability_conflict')
    expect(migration).toContain('private.assignment_overlap_conflict')
    expect(migration).toContain("'armed_guard'::public.credential_kind")
    expect(migration).toContain('private.scheduled_overtime_preview')
    expect(migration).toContain('Confirm the overtime approval before assigning them.')
  })

  it('uses idempotent Flex-first notification waves without exposing absence reasons', () => {
    expect(migration).toContain("'flex_no_overtime'")
    expect(migration).toContain("'other_no_overtime'")
    expect(migration).toContain("'overtime'")
    expect(migration).toContain('unique (coverage_case_id, wave_number)')
    expect(migration).toContain("concat('shift-coverage:', coverage.id, ':wave:'")
    const notificationFunction = migration.slice(migration.indexOf('create function public.service_process_shift_coverage_notification_waves'))
    expect(notificationFunction).not.toContain('report_record.reason')
    expect(worker).toContain("'service_process_shift_coverage_notification_waves'")
  })

  it('keeps coverage history append-only and direct table access closed', () => {
    expect(migration).toContain('Coverage history is append-only.')
    expect(migration).toContain('alter table public.shift_coverage_cases enable row level security')
    expect(migration).toContain('revoke all on table public.shift_coverage_cases from public, anon, authenticated')
    expect(migration).toContain("public.has_any_effective_permission(array[")
    expect(migration).toContain('and public.has_mfa()')
  })

  it('presents one guided, mobile-aware manager workflow', () => {
    expect(requests).toContain("['Review absence', 'Choose coverage', 'Confirm']")
    expect(requests).toContain('Coverage already found')
    expect(requests).toContain('Find an available guard')
    expect(requests).toContain('Request patrol review')
    expect(requests).toContain('No replacement needed')
    expect(requests).toContain('Name or employee number')
  })
})

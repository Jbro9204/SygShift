/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260910060000_unify_time_correction_workflow.sql'), 'utf8')
const operationsPage = readFileSync(join(root, 'src', 'time', 'TimeOperationsPage.tsx'), 'utf8')
const teamPage = readFileSync(join(root, 'src', 'time', 'TimeTeamAttendancePage.tsx'), 'utf8')

describe('unified time correction workflow', () => {
  it('exposes a scoped, MFA-aware pending punch correction queue', () => {
    expect(migration).toContain('create or replace function public.get_pending_time_event_corrections')
    expect(migration).toContain("public.has_effective_permission('time.adjustments.review')")
    expect(migration).toContain('correction.requested_by = actor_id')
    expect(migration).toContain('security definer')
    expect(migration).toContain("set search_path = ''")
    expect(migration).toContain('grant execute on function public.get_pending_time_event_corrections(date, date) to authenticated')
  })

  it('resolves pending employee requests when management corrects the same punch', () => {
    expect(migration).toContain('create or replace function public.supervisor_correct_time_event_details')
    expect(migration).toContain('resolvedPendingRequestCount')
    expect(migration).toContain('approvedPendingRequestCount')
    expect(migration).toContain('declinedPendingRequestCount')
    expect(migration).toContain('Superseded by an authorized Operations maintenance correction')
  })

  it('reconciles only stale requests that were followed by an approved maintenance correction', () => {
    expect(migration).toContain("correction.decision_note = 'Operations maintenance correction.'")
    expect(migration).toContain('correction.created_at >= pending.created_at')
    expect(migration).toContain('where pending.approved_at is null')
    expect(migration).toContain('and pending.declined_at is null')
  })

  it('shows both request sources in Operations and preserves Team date context', () => {
    expect(operationsPage).toContain("getPendingTimeEventCorrections")
    expect(operationsPage).toContain("['time-event-correction-queue', fromDate, throughDate]")
    expect(operationsPage).toContain('visibleEventCorrections')
    expect(teamPage).toContain('timeCorrectionReviewPath({ employeeId: row.employeeId, fromDate, throughDate })')
  })
})

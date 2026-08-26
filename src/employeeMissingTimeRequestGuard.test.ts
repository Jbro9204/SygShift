/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewMissingTimeRequest, submitMissingTimeRequest } from './data/timeOperations'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('./lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260826180000_employee_missing_time_requests.sql'),
  'utf8',
)
const employeePage = readFileSync(join(root, 'src', 'time', 'MyTimePage.tsx'), 'utf8')
const operationsPage = readFileSync(join(root, 'src', 'time', 'TimeOperationsPage.tsx'), 'utf8')

describe('employee missing-time request guardrails', () => {
  beforeEach(() => rpc.mockReset())

  it('submits the complete missing-time request without accepting an employee identity', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        id: '94000000-0000-4000-8000-000000000001',
        status: 'submitted',
        submittedAt: '2026-08-26T12:00:00.000Z',
      },
      error: null,
    })

    await submitMissingTimeRequest({
      workDate: '2026-08-21',
      requestedClockInAt: '2026-08-21T14:00:00.000Z',
      requestedClockOutAt: '2026-08-21T22:30:00.000Z',
      postId: '94000000-0000-4000-8000-000000000002',
      unpaidBreakMinutes: 30,
      reason: 'Worked the full shift but could not access the time clock.',
    })

    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledWith('submit_missing_time_request', {
      target_work_date: '2026-08-21',
      target_requested_clock_in_at: '2026-08-21T14:00:00.000Z',
      target_requested_clock_out_at: '2026-08-21T22:30:00.000Z',
      target_post_id: '94000000-0000-4000-8000-000000000002',
      target_unpaid_break_minutes: 30,
      target_reason: 'Worked the full shift but could not access the time clock.',
    })
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('target_employee_id')
  })

  it('keeps employee identity server-derived and payroll unchanged while review is pending', () => {
    expect(migration).toContain('actor_id uuid := private.current_employee_id()')
    expect(migration).toContain("actor_id, matched_shift_id, target_work_date, 'missing_shift'")
    expect(migration).toContain("values (inserted.id, 'submitted', clean_reason, actor_id, to_jsonb(inserted))")

    const submissionFunction = migration.slice(
      migration.indexOf('create or replace function public.submit_missing_time_request'),
      migration.indexOf('create or replace function public.review_missing_time_request'),
    )
    expect(submissionFunction).not.toContain('insert into public.time_events')
    expect(submissionFunction).not.toContain('target_employee_id')
  })

  it('requires authorized review before creating an audited work segment', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        id: '94000000-0000-4000-8000-000000000001',
        status: 'approved',
        timeEventIds: [
          '94000000-0000-4000-8000-000000000003',
          '94000000-0000-4000-8000-000000000004',
        ],
        warningCodes: [],
      },
      error: null,
    })

    await reviewMissingTimeRequest({
      id: '94000000-0000-4000-8000-000000000001',
      status: 'approved',
      decisionNote: 'Verified against the post log and approved.',
      confirmWarnings: true,
    })

    expect(rpc).toHaveBeenCalledWith('review_missing_time_request', expect.objectContaining({
      target_decision: 'approved',
      target_confirm_warnings: true,
    }))
    expect(migration).toContain("private.timekeeping_require_permission('time.adjustments.review')")
    expect(migration).toContain('insert into public.time_events')
    expect(migration).toContain("'break_start'::public.time_event_kind")
    expect(migration).toContain("'break_end'::public.time_event_kind")
    expect(migration).toContain('insert into public.time_event_maintenance_notes')
    expect(migration).toContain('insert into public.time_adjustment_request_actions')
  })

  it('makes Site/Post, the work period, unpaid break, and explanation visible in both workflows', () => {
    expect(employeePage).toContain('Request missing time')
    expect(employeePage).toContain('Work date')
    expect(employeePage).toContain('Clock-in time')
    expect(employeePage).toContain('Clock-out time')
    expect(employeePage).toContain('Site/Post')
    expect(employeePage).toContain('Unpaid break')
    expect(employeePage).toContain('Explanation')
    expect(employeePage).toContain('No punches or payroll hours are created until an authorized reviewer approves this request.')
    expect(operationsPage).toContain('No payroll effect until approved')
    expect(operationsPage).toContain('requestedUnpaidBreakMinutes')
  })
})

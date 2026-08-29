/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const overview = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const requestsPage = readFileSync(join(root, 'src', 'pages', 'RequestsPage.tsx'), 'utf8')
const accessPolicy = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const modal = readFileSync(join(root, 'src', 'components', 'TimeOffRequestModal.tsx'), 'utf8')
const requestsData = readFileSync(join(root, 'src', 'data', 'requests.ts'), 'utf8')
const css = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260828180000_home_time_off_request_workflow.sql'),
  'utf8',
)

describe('Home time-off request workflow guardrails', () => {
  it('keeps one prominent universal Home entry point and a working request-history destination', () => {
    expect(overview).toContain('className="home-planned-time-off"')
    expect(overview).toContain('Request Time Off')
    expect(overview).toContain('<TimeOffRequestModal')
    expect(overview).toContain('requestHistoryPath="/requests"')
    expect(accessPolicy).toContain("pathname === '/requests'")
    expect((overview.match(/Request Time Off/g) ?? []).length).toBe(1)
  })

  it('shows only the request types authorized for the employee employment class', () => {
    expect(migration).toContain("when 'salary' then jsonb_build_array('paid_vacation', 'sick_time', 'unpaid_time_off')")
    expect(migration).toContain("else jsonb_build_array('sick_time', 'unpaid_time_off')")
    expect(migration).toContain("employee_record.employment_type::text not in ('hourly', 'salary', 'flex')")
    expect(modal).toContain('Available to salary employees only.')
    expect(modal).toContain('context.allowedTypes.map')
    expect(modal).toContain('Treatment')
  })

  it('keeps planned leave distinct from urgent call-off reporting in both UI and server validation', () => {
    expect(modal).toContain('Use this form for planned time away.')
    expect(modal).toContain('Use Report Sick / Call-Off')
    expect(modal).toContain('to="/time/my-time?report=call-off"')
    expect(migration).toContain('For a current or imminent shift, use Report Sick / Call-Off')
    expect(migration).toContain("request_kind = 'sick_time'")
  })

  it('stores immutable submission context and preserves affected published-shift evidence', () => {
    expect(migration).toContain('submission_snapshot jsonb')
    expect(migration).toContain('affected_shifts_snapshot jsonb')
    expect(migration).toContain('time_off_submission_snapshot_immutable')
    expect(migration).toContain('Submitted time-off details are immutable.')
    expect(migration).toContain("schedule.status = 'published'")
    expect(migration).toContain("'affectedShifts', affected")
    expect(requestsData).toContain("rpc('submit_time_off_request_v2'")
  })

  it('requires an authorized MFA reviewer, a decision note, and an audited decision snapshot', () => {
    expect(migration).toContain("public.has_effective_permission('requests.manage')")
    expect(migration).toContain('public.has_mfa()')
    expect(migration).toContain("btrim(coalesce(target_note, '')) = ''")
    expect(migration).toContain('decision_snapshot')
    expect(migration).toContain('insert into private.audit_events')
    expect(requestsPage).toContain('Review request')
    expect(requestsPage).toContain('<TimeOffReviewDialog')
    expect(modal).toContain('Decision note')
    expect(modal).toContain('Leave unresolved')
  })

  it('keeps the modal responsive and focused rather than building a second request workflow', () => {
    expect(requestsPage).toContain('<TimeOffRequestModal')
    expect(requestsPage).not.toContain('function GuardTimeOffForm')
    expect(css).toContain('.modal-dialog--time-off-request')
    expect(css).toContain('.time-off-purpose-note')
    expect(css).toContain('@media (max-width: 540px)')
    expect(modal).toContain('Submitting your request...')
    expect(modal).toContain('Time-off request submitted')
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toZonedLocalDateTimeInput, zonedLocalDateTimeToUtc } from './data/timeOperations'

const root = process.cwd()
const foundation = readFileSync(join(root, 'supabase', 'migrations', '20260818120000_timekeeping_operations_expansion.sql'), 'utf8')
const workflows = readFileSync(join(root, 'supabase', 'migrations', '20260818121000_timekeeping_operations_workflows.sql'), 'utf8')
const reporting = readFileSync(join(root, 'supabase', 'migrations', '20260818122000_timekeeping_reporting_and_audit.sql'), 'utf8')
const integrity = readFileSync(join(root, 'supabase', 'migrations', '20260818123000_timekeeping_operations_integrity_hardening.sql'), 'utf8')
const visibility = readFileSync(join(root, 'supabase', 'migrations', '20260818126000_timekeeping_operations_visibility_hardening.sql'), 'utf8')
const operationsPage = readFileSync(join(root, 'src', 'time', 'TimeOperationsPage.tsx'), 'utf8')
const reportsPage = readFileSync(join(root, 'src', 'pages', 'ReportsPage.tsx'), 'utf8')
const reportDefinitions = readFileSync(join(root, 'src', 'reports', 'reportDefinitions.ts'), 'utf8')
const workbook = readFileSync(join(root, 'src', 'time', 'payrollWorkbook.ts'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const wrangler = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')

describe('production timekeeping operations expansion', () => {
  it('runs automatic clock-out at the configured threshold and records scheduled end, audit, exception, and employee notice', () => {
    expect(foundation).toContain("'timekeeping.automatic_clock_out_grace_minutes', '3'::jsonb")
    expect(foundation).toContain('shift.ends_at + make_interval(mins => automatic_grace) <= clock_timestamp()')
    expect(foundation).toContain("'clock_out'::public.time_event_kind")
    expect(foundation).toContain('candidate.ends_at,')
    expect(foundation).toContain("'system'::public.time_event_source")
    expect(foundation).toContain("'automatic_clock_out'")
    expect(foundation).toContain("'automatic_clock_out_employee'")
    expect(foundation).toContain('scheduledEndAt')
    expect(foundation).toContain('timekeeping_operational_exception_actions')
  })

  it('is duplicate-safe, concurrency-safe, and limited to live published assignments', () => {
    expect(foundation).toContain("pg_try_advisory_xact_lock(hashtext('sygshift.timekeeping.operations'))")
    expect(foundation).toContain("on conflict (id) do nothing")
    expect(foundation).toContain("return jsonb_build_object('jobRunId', target_job_run_id, 'status', 'duplicate'")
    expect(foundation).toContain("schedule.status = 'published'")
    expect(foundation).toContain('shift.canceled_at is null')
    expect(foundation).toContain("on conflict (idempotency_key) do nothing")
    expect(foundation).toContain("on conflict (employee_id, shift_id, exception_code) do nothing")
  })

  it('creates missing-clock-in review records without inventing a clock-in', () => {
    expect(foundation).toContain("'timekeeping.missing_clock_in_grace_minutes', '15'::jsonb")
    expect(foundation).toContain("event.kind = 'clock_in'")
    expect(foundation).toContain("'missing_clock_in', 'unresolved', 'blocking'")
    expect(foundation).toContain('No clock-in punch was received within the configured grace period.')
    expect(foundation).toContain("resolution_method = case")
    expect(foundation).toContain("when shift.canceled_at is not null then 'shift_canceled'")
    expect(foundation).toContain("then 'call_off'")
  })

  it('enforces manual-entry permissions, validation, warnings, and append-only history on the server', () => {
    expect(workflows).toContain("private.timekeeping_require_permission('time.manual_entry.create')")
    expect(reporting).toContain("private.timekeeping_require_permission('time.manual_entry.edit')")
    expect(workflows).toContain('Clock-out must be after clock-in.')
    expect(workflows).toContain("warning_codes := array_append(warning_codes, 'overlapping_time_record')")
    expect(workflows).toContain("warning_codes := array_append(warning_codes, 'outside_scheduled_shift')")
    expect(workflows).toContain("warning_codes := array_append(warning_codes, 'unusually_long_shift')")
    expect(workflows).toContain('target_confirm_warnings')
    expect(reporting).toContain('before_values := to_jsonb(entry)')
    expect(reporting).toContain("values (entry.id, 'edited', before_values, to_jsonb(entry)")
    expect(foundation).toContain('manual_time_entry_history_append_only')
  })

  it('keeps employee adjustment requests pending until an authorized reviewer decides them', () => {
    expect(workflows).toContain('create or replace function public.submit_time_adjustment_request')
    expect(workflows).toContain("'submitted'")
    expect(integrity).toContain('create or replace function public.review_time_adjustment_request')
    expect(integrity).toContain("private.timekeeping_require_permission('time.adjustments.review')")
    expect(integrity).toContain("target_decision not in ('under_review', 'approved', 'partially_approved', 'rejected')")
    expect(integrity).toContain('time_event_corrections')
    expect(integrity).toContain('time_adjustment_request_actions')
    expect(operationsPage).toContain('Request a time change')
    expect(operationsPage).toContain('Decision history')
  })

  it('records call-offs with permission enforcement, urgent deduplicated alerts, and acknowledgment', () => {
    expect(foundation).toContain("'accountability.report_call_off'")
    expect(workflows).toContain("private.timekeeping_require_permission('accountability.report_call_off')")
    expect(workflows).toContain("on conflict (shift_id, employee_id) do nothing")
    expect(workflows).toContain("'employee_call_off', 'urgent'")
    expect(workflows).toContain("array['dispatcher', 'scheduler', 'supervisor', 'admin']")
    expect(workflows).toContain("concat('call-off:', report.id)")
    expect(workflows).toContain('create or replace function public.acknowledge_operational_alert')
    expect(foundation).toContain('operational_alert_acknowledgments_audit')
    expect(operationsPage).toContain('Report Sick / Call-Off')
  })

  it('suppresses the configured blocked email domain before provider delivery while retaining an audit record', () => {
    expect(worker).toContain("'guardianshipsecurity.net'")
    expect(worker).toContain('isBlockedEmailRecipient(environment, recipient)')
    expect(worker).toContain("'suppressed_blocked_domain'")
    expect(worker).toContain("'service_mark_notification_suppressed'")
    expect(foundation).toContain('private.email_delivery_audit')
    expect(foundation).toContain("'Suppressed — Blocked Domain'")
    expect(wrangler).toContain('SYGSHIFT_BLOCKED_EMAIL_DOMAINS')
  })

  it('exposes the eight protected operational reports through the existing Reports workspace', () => {
    for (const report of [
      'timekeepingExceptions', 'automaticClockOuts', 'manualTimeEntryAudit', 'timeAdjustmentRequests',
      'attendanceCallOffs', 'scheduledVsActual', 'coverageUnfilled', 'overtimePayrollRisk',
    ]) {
      expect(reporting).toContain(`'${report}'`)
      expect(reportDefinitions).toContain(`key: '${report}'`)
    }
    expect(reporting).toContain("private.timekeeping_require_permission('time.reports.view')")
    expect(reportsPage).toContain('getTimekeepingOperationsReportPage')
    expect(reportsPage).toContain('Choose one report')
    expect(reportsPage).toContain('pageSizes = [10, 25, 50]')
    expect(reportsPage).toContain('type="date"')
  })

  it('keeps employee self-service time access separate from team-wide operations data', () => {
    const operationsPermissionBody = visibility.match(/create or replace function private\.timekeeping_can_view_operations\(\)[\s\S]*?\$\$;/)?.[0] ?? ''
    expect(operationsPermissionBody).not.toContain("has_effective_permission('time.view')")
    expect(operationsPermissionBody).toContain("has_effective_permission('time.manage')")
    expect(visibility).toContain('(can_view_staffing_context or assignment.employee_id = workspace_actor_id)')
    expect(visibility).toContain("'employees', case when can_view_staffing_context")
    expect(visibility).toContain("'callOffReports', case when can_view_operations or can_report_call_off")
  })

  it('exports complete shift notes as literal spreadsheet text', () => {
    expect(workbook).toContain("'Shift Notes'")
    expect(workbook).toContain('row.shiftNotes')
    expect(workbook).toContain('t="inlineStr"')
    expect(workbook).toContain('xmlEscape(String(cell))')
    expect(workbook).not.toContain('<f>${')
  })

  it('keeps Denver overnight timestamps authoritative and rejects nonexistent DST wall time', () => {
    expect(zonedLocalDateTimeToUtc('2026-07-01T23:30', 'America/Denver')).toBe('2026-07-02T05:30:00.000Z')
    expect(toZonedLocalDateTimeInput('2026-07-02T05:30:00.000Z', 'America/Denver')).toBe('2026-07-01T23:30')
    expect(() => zonedLocalDateTimeToUtc('2026-03-08T02:30', 'America/Denver')).toThrow(/daylight-saving time/)
  })
})

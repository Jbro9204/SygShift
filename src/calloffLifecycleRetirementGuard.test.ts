/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20261005123949_call_off_alert_lifecycle_retirement.sql',
  'utf8',
)
const regression = readFileSync('supabase/tests/call_off_lifecycle_regression.sql', 'utf8')

describe('call-off alert lifecycle retirement guardrails', () => {
  it('records an authoritative terminal outcome without deleting call-off history', () => {
    expect(migration).toContain('resolution_outcome')
    for (const outcome of [
      'covered',
      'no_replacement',
      'no_replacement_required',
      'patrol_completed',
      'canceled',
      'shift_ended_unfilled',
      'legacy_resolved',
    ]) {
      expect(migration).toContain(`'${outcome}'`)
    }
    expect(migration).not.toMatch(
      /delete\s+from\s+public\.(call_off_reports|call_off_report_actions|operational_alerts|employee_notifications|shift_coverage_cases|shift_coverage_case_actions)/i,
    )
  })

  it('keeps replacement-needed call-offs live through shift end plus one hour', () => {
    expect(migration).toMatch(/ends_at\s*\+\s*interval\s+'1 hour'/i)
    expect(migration).toContain('live_until_at')
    expect(migration).toContain("new.resolution_outcome := 'shift_ended_unfilled'")
    expect(migration).toContain('clear_source = case')
    expect(migration).toContain("'automatic_resolution'")
    expect(migration).toContain("lifecycle_state = 'resolved'")
  })

  it('settles replacement-not-needed reports immediately and safely controls reopening', () => {
    expect(migration).toContain('replacement_needed')
    expect(migration).toContain("'no_replacement_required'")
    expect(migration).toContain('new.resolved_at := coalesce(new.resolved_at, clock_timestamp())')
    expect(migration).toMatch(/not\s+report\.replacement_needed[\s\S]+ends_at\s*\+\s*interval\s+'1 hour'/i)
    expect(migration).toContain('Replacement coverage can no longer be reopened for this call-off.')

    const updateCallOff = migration.match(
      /create or replace function public\.update_employee_call_off\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(updateCallOff).toBeDefined()
    expect(updateCallOff).toContain("existing.resolution_outcome <> 'no_replacement_required'")
    expect(updateCallOff).toContain("resolved_at = case when reopening then null")
    expect(updateCallOff).toContain("resolution_outcome = case when reopening then null")
    expect(updateCallOff).toMatch(/clock_timestamp\(\)\s*>=\s*shift_ends_at\s*\+\s*interval\s+'1 hour'/i)
  })

  it('resolves retained workflow notifications and closes stale coverage artifacts', () => {
    expect(migration).toContain("source_type = 'call_off_request'")
    expect(migration).toContain('notification.resolved_at')
    expect(migration).toContain('notification.expires_at')
    expect(migration).toContain('action_required = false')
    expect(migration).toContain("coverage_before.status in ('draft', 'open_pool', 'patrol_review')")
    expect(migration).toContain("status = 'closed'")
    expect(migration).toMatch(/status = 'closed',[\s\S]*?resolved_at = coalesce\(coverage\.resolved_at,[\s\S]*?where coverage\.id = coverage_before\.id/i)
    expect(migration).toMatch(/'closed',\s*target_actor_id,\s*target_reason,/)
    expect(migration).toContain("wave.status in ('pending', 'processing')")
    expect(migration).toContain("request.status = 'pending'")
    expect(migration).toContain('update private.employee_push_deliveries delivery')
    expect(migration).toContain('update public.employee_notification_email_deliveries delivery')
    expect(migration).toContain('update private.notification_outbox outbox')
    expect(regression).toContain('and coverage.resolved_by is null')
    expect(migration).toContain("'Call-off lifecycle retirement: ' || target_reason")
    expect(migration).toContain('coverage_shift.coverage_source_shift_id is not null')
    expect(migration).toContain("coverage_before.status <> 'assigned'")
    expect(regression).toContain("shift.cancellation_reason like 'Call-off lifecycle retirement:%'")
  })

  it('rechecks terminal state at delivery and coverage-wave claim time', () => {
    const deliveryClaim = migration.match(
      /create function public\.service_claim_notification_batch\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(deliveryClaim).toBeDefined()
    expect(deliveryClaim).toContain("outbox.message_type = 'call_off_supervisor_alert'")
    expect(deliveryClaim).toContain('report.replacement_needed')
    expect(deliveryClaim).toContain('report.resolved_at')
    expect(deliveryClaim).toContain('report.canceled_at')
    expect(deliveryClaim).toMatch(/shift\.ends_at\s*\+\s*interval\s+'1 hour'/i)

    const waveWorker = migration.match(
      /create or replace function public\.service_process_shift_coverage_notification_waves\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(waveWorker).toBeDefined()
    expect(waveWorker).toContain('public.call_off_reports')
    expect(waveWorker).toContain('report.replacement_needed')
    expect(waveWorker).toContain('report.resolved_at')
    expect(waveWorker).toContain('report.canceled_at')
    expect(waveWorker).toContain('report.duplicate_of_call_off_report_id')
    expect(waveWorker).toMatch(/(?:source_shift|shift_record)\.ends_at\s*\+\s*interval\s+'1 hour'/i)
    expect(waveWorker).toMatch(/for update(?:\s+of\s+(?:report|coverage))?/i)
    expect(regression).toContain('stale_wave_result')
    expect(regression).toContain("action.action = 'notification_wave_sent'")
  })

  it('locks coverage before retiring its dependent artifacts', () => {
    const retirement = migration.match(
      /create or replace function private\.retire_call_off_live_artifacts\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(retirement).toBeDefined()
    expect(retirement).toMatch(/from public\.shift_coverage_cases coverage[\s\S]*?for update;/i)
    expect(retirement).toContain("wave.status in ('pending', 'processing')")
    expect(retirement).toContain("status = 'closed'")
  })

  it('gates coverage decisions behind the authoritative report lifecycle', () => {
    const coverageGate = migration.match(
      /create function public\.resolve_call_off_coverage\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(coverageGate).toBeDefined()
    expect(coverageGate).toContain('for update of item')
    expect(coverageGate).toContain('report.canceled_at')
    expect(coverageGate).toContain('report.resolved_at')
    expect(coverageGate).toContain('report.duplicate_of_call_off_report_id')
    expect(coverageGate).toContain('not report.replacement_needed')
    expect(coverageGate).toMatch(/shift_ends_at\s*\+\s*interval\s+'1 hour'/i)
    expect(coverageGate!.indexOf('for update of item')).toBeLessThan(
      coverageGate!.indexOf('coverage.last_idempotency_key'),
    )
    expect(coverageGate).toContain('coverage.call_off_report_id = report.id')
    expect(coverageGate).toContain('coverage.call_off_report_id <> report.id')
    expect(coverageGate).toContain('This idempotency key belongs to a different call-off.')
    expect(coverageGate!.indexOf('if replay.id is not null')).toBeLessThan(
      coverageGate!.indexOf('if report.canceled_at is not null'),
    )
    expect(regression).toContain('terminal_coverage_replay_result')
    expect(regression).toContain('foreign_replay_blocked')

    const requestGate = migration.match(
      /create function public\.decide_shift_request\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(requestGate).toBeDefined()
    expect(requestGate).toContain('for update of report_row')
    expect(requestGate).toContain('report.resolved_at')
    expect(requestGate).toContain('report.canceled_at')
    expect(requestGate).toContain('not report.replacement_needed')
    expect(requestGate).toMatch(/shift_ends_at\s*\+\s*interval\s+'1 hour'/i)
    expect(regression).toContain('grace_coverage_result')
    expect(regression).toContain("coverage.status = 'patrol_review'")
    expect(regression).toContain('grace_patrol_notification_id')
  })

  it('fails closed at raw request, workspace, and Request Center boundaries', () => {
    const requestInsertGuard = migration.match(
      /create or replace function private\.guard_call_off_shift_request_lifecycle\(\)[\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(requestInsertGuard).toBeDefined()
    expect(requestInsertGuard).toContain('for update of report_row')
    expect(requestInsertGuard).toContain('report.resolved_at')
    expect(requestInsertGuard).toContain('report.canceled_at')
    expect(requestInsertGuard).toContain('report.duplicate_of_call_off_report_id')
    expect(requestInsertGuard).toContain('not report.replacement_needed')
    expect(requestInsertGuard).toMatch(/shift_ends_at\s*\+\s*interval\s+'1 hour'/i)
    expect(migration).toMatch(
      /create trigger guard_call_off_shift_request_lifecycle\s+before insert or update of shift_id, status on public\.shift_requests/i,
    )
    expect(migration).toContain(
      'revoke insert, update on table public.shift_requests from authenticated',
    )

    const withdrawRequest = migration.match(
      /create or replace function public\.withdraw_shift_request\(target_request_id uuid\)[\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(withdrawRequest).toBeDefined()
    expect(withdrawRequest).toContain('security definer')
    expect(withdrawRequest).toContain('actor_employee_id uuid := private.current_employee_id()')
    expect(withdrawRequest).toContain('request.employee_id = actor_employee_id')
    expect(withdrawRequest).toContain("request.status = 'pending'")

    const coverageWorkspace = migration.match(
      /create function public\.get_call_off_coverage_workspace\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(coverageWorkspace).toBeDefined()
    expect(coverageWorkspace).toContain("'actionable', false")
    expect(coverageWorkspace).toContain("'{candidates}', '[]'::jsonb")
    expect(coverageWorkspace).toContain("'available', false")
    expect(coverageWorkspace).toContain('report.replacement_needed')
    expect(coverageWorkspace).toContain('report.duplicate_of_call_off_report_id is null')
    expect(coverageWorkspace).toMatch(/shift_ends_at\s*\+\s*interval\s+'1 hour'/i)

    expect(migration).toContain('do $request_center_call_off_lifecycle$')
    expect(migration).toContain('report.resolved_at is null and report.replacement_needed')
    expect(migration).toContain("shift.ends_at + interval ''1 hour'' > clock_timestamp()")
    expect(regression).toContain('late_shift_request_insert_blocked')
    expect(regression).toContain('terminal_shift_request_reopen_blocked')
    expect(regression).toContain('terminal_shift_request_move_blocked')
    expect(regression).toContain('raw_shift_request_update_blocked')
    expect(regression).toContain('owner_withdrawal_result')
    expect(regression).toContain('terminal_coverage_workspace')
  })

  it('restores patrol-review work and records only real reconciliation actions', () => {
    const reactivation = migration.match(
      /create or replace function private\.reactivate_call_off_operational_work\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(reactivation).toBeDefined()
    expect(reactivation).toContain("elsif restored_status = 'patrol_review' then")
    expect(reactivation).toContain("'shift_coverage'")
    expect(reactivation).toContain('coverage_after.id')
    expect(reactivation).toContain('action_required = true')
    expect(reactivation).toContain("'patrol.assignments.manage'")
    expect(reactivation).toContain('insert into public.employee_notifications')
    expect(reactivation).toContain("':reopen:'")
    expect(reactivation).toContain('update public.employee_notifications notification')
    expect(reactivation).toContain('action_required = false')
    expect(reactivation).toMatch(/from public\.operational_alerts alert[\s\S]*?limit 1/i)
    expect(reactivation).toContain('and alert.id <> alert_id')
    expect(regression).toContain('actor_push_subscription_id')
    expect(regression).toContain("notification.source_key like '%:reopen:%'")
    expect(regression).toContain('having count(*) <> 1')

    const reconciler = migration.match(
      /create or replace function private\.reconcile_call_off_alert_lifecycle\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(reconciler).toBeDefined()
    expect(reconciler).toContain('recorded_action_count := private.record_call_off_system_resolution(')
    expect(reconciler).toContain('current_action_count - prior_action_count')
    expect(regression).toContain("service_reconcile_operational_alert_lifecycle(true)")
    expect(regression).toContain("'callOffActionRecordedCount'")
    expect(regression).toContain('settled_no_replacement_report_id')
    expect(regression).toContain('unresolved_no_replacement_report_id')
    expect(regression).toContain('unresolved_duplicate_report_id')
  })

  it('fails closed for orphan sources and keeps the clear-source constraint aligned', () => {
    expect(migration).toMatch(
      /add constraint operational_alerts_clear_source_check[\s\S]*?'orphaned_source'/i,
    )

    const alertGate = migration.match(
      /create or replace function private\.prepare_operational_alert_lifecycle\(\)[\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(alertGate).toBeDefined()
    expect(alertGate).toContain('call_off_source_missing')
    expect(alertGate).toContain("when call_off_source_missing then 'orphaned_source'")
    expect(migration).toMatch(
      /drop trigger if exists operational_alert_lifecycle[\s\S]*?create trigger operational_alert_lifecycle[\s\S]*?private\.prepare_operational_alert_lifecycle\(\)/i,
    )

    const notificationGate = migration.match(
      /create or replace function private\.prepare_call_off_notification_lifecycle\(\)[\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(notificationGate).toBeDefined()
    expect(notificationGate).toMatch(/if report\.id is null then[\s\S]*?new\.action_required := false/i)

    const outboxGate = migration.match(
      /create or replace function private\.suppress_terminal_call_off_outbox\(\)[\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(outboxGate).toBeDefined()
    expect(outboxGate).toMatch(/if report\.id is null[\s\S]*?new\.failed_at/i)

    expect(regression).toContain('orphan_report_id')
    expect(regression).toContain('Postflight found a live artifact')
  })

  it('repairs terminal coverage evidence even before the response cutoff', () => {
    const reconciler = migration.match(
      /create or replace function private\.reconcile_call_off_alert_lifecycle\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(reconciler).toBeDefined()
    expect(reconciler).toContain('coverage_evidence.outcome as coverage_outcome')
    expect(reconciler).toContain("coverage.status in ('assigned', 'no_replacement')")
    expect(reconciler).toContain("when candidate.coverage_outcome is not null then candidate.coverage_outcome")
    expect(regression).toContain('divergence_covered_report_id')
    expect(regression).toContain('divergence_no_replacement_report_id')
    expect(regression).toContain("report.resolution_outcome = 'covered'")
    expect(regression).toContain("report.resolution_outcome = 'no_replacement'")
  })

  it('detects terminal drift across every retained coverage child', () => {
    const reconciler = migration.match(
      /create or replace function private\.reconcile_call_off_alert_lifecycle\([\s\S]*?\n\$\$;/i,
    )?.[0]
    expect(reconciler).toBeDefined()
    expect(reconciler).toContain("notification.source_type = 'shift_coverage'")
    expect(reconciler).toContain("notification.source_type = 'shift_request'")
    expect(reconciler).toMatch(/announcement\.expires_at is null[\s\S]*?announcement\.expires_at > clock_timestamp\(\)/i)
    expect(reconciler).toMatch(/employee_notification_email_deliveries delivery[\s\S]*?delivery\.failed_at is null/i)
    expect(reconciler).toMatch(/employee_push_deliveries delivery[\s\S]*?delivery\.completed_at is null/i)
  })

  it('keeps the service reconciliation observable and retry-safe', () => {
    for (const key of [
      'callOffResolvedCount',
      'callOffAlertRetiredCount',
      'callOffNotificationResolvedCount',
      'staleCoverageCaseClosedCount',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }
    expect(migration).toMatch(/pg_try_advisory_xact_lock\([\s\S]+sygshift\.(?:operational\.alert|call\.off\.alert)\.lifecycle/)
    expect(regression).toContain('second_reconciliation')
    expect(regression).toContain('service_claim_notification_batch')
    expect(regression).toContain('service_claim_employee_push')
    expect(regression).toContain("resolution_outcome = 'shift_ended_unfilled'")
    expect(regression).toContain("shift.time_zone = 'America/Denver'")
    expect(regression.match(/^\s*begin;\s*$/gim) ?? []).toHaveLength(1)
    expect(regression.match(/^\s*rollback;\s*$/gim) ?? []).toHaveLength(1)
    expect(regression).not.toMatch(/^\s*commit;\s*$/im)
    expect(regression.trimEnd().endsWith('rollback;')).toBe(true)
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260831200000_hris_stage10_payroll_integration_hardening.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const wrangler = readFileSync('wrangler.jsonc', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')
const policy = readFileSync('src/app/accessPolicy.ts', 'utf8')
const router = readFileSync('src/app/router.tsx', 'utf8')
const page = readFileSync('src/pages/HrisPayrollIntegrationPage.tsx', 'utf8')
const pagination = readFileSync('src/components/HrPagination.tsx', 'utf8')

describe('HRIS Stage 10 payroll integration hardening', () => {
  it('keeps integration, webhooks, and cutover dormant', () => {
    for (const gate of ['PAYROLL_INTEGRATION', 'PAYROLL_WEBHOOKS', 'ENTERPRISE_CUTOVER']) {
      expect(wrangler).toContain(`"SYGSHIFT_HR_${gate}_ENABLED": "false"`)
    }
    expect(migration).toContain("values ('integration'),('webhooks'),('cutover')")
    expect(migration).toContain('enabled boolean not null default false')
  })

  it('preserves identities, access, schedules, punches, and locked payroll evidence', () => {
    expect(migration).toContain('hris_stage10_preservation_baseline')
    for (const protectedCount of [
      'employee_count', 'employee_role_count', 'role_permission_count', 'override_count',
      'account_count', 'schedule_count', 'time_event_count', 'payroll_batch_count', 'payroll_row_count',
    ]) expect(migration).toContain(`baseline.${protectedCount}`)
    expect(migration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
  })

  it('keeps SygShift Payroll authoritative and contract rules versioned', () => {
    expect(migration).toContain("payroll_authority text not null default 'sygshift_payroll'")
    expect(migration).toContain("'hourlySource','completed_and_approved_punches'")
    expect(migration).toContain("'weekStartsOn','Sunday'")
    expect(migration).toContain("'timeZone','America/Denver'")
    expect(migration).toContain("'overnightAttribution','scheduled_shift_start_workday'")
    expect(migration).toContain("'lockedSnapshotsImmutable',true")
    expect(migration).toContain('private.payroll_export_batches')
    expect(migration).toContain('private.payroll_export_rows')
  })

  it('requires maker-checker approval, reason, exact permission, and recent MFA', () => {
    expect(migration).toContain('hr_payroll_approval_maker_checker')
    expect(migration).toContain('The proposer cannot approve their own payroll-impacting change.')
    expect(migration).toContain('hr_stage10_require_actor_permission')
    expect(migration).toContain('hr_stage10_require_recent_mfa')
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.payroll_integration.view')")
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
  })

  it('isolates private controls and protects immutable evidence', () => {
    expect(migration).toContain('enable row level security')
    expect(migration).toContain('revoke all on private.%I from public,anon,authenticated')
    for (const trigger of [
      'hr_payroll_contracts_append_only', 'hr_payroll_approvals_append_only',
      'hr_payroll_reconciliation_items_append_only', 'hr_payroll_events_append_only',
      'hr_payroll_webhook_attempts_append_only', 'hr_payroll_rollback_executions_append_only',
    ]) expect(migration).toContain(trigger)
    for (const trigger of ['hr_payroll_contract_digest', 'hr_payroll_proposal_digest', 'hr_payroll_event_digest']) {
      expect(migration).toContain(trigger)
    }
    expect(migration).not.toContain('payload_digest text generated always')
  })

  it('keeps webhooks disabled, HTTPS-only, and secret values out of the database', () => {
    expect(migration).toContain('enabled boolean not null default false')
    expect(migration).toContain("endpoint_url ~ '^https://'")
    expect(migration).toContain('secret_binding_name text not null')
    expect(migration).not.toMatch(/webhook_secret\s+text/i)
  })

  it('exposes only the protected read-only workspace API', () => {
    expect(worker).toContain("url.pathname !== '/api/v1/hr/payroll-integration/workspace'")
    expect(worker).toContain("request.method !== 'GET'")
    expect(worker).toContain("'service_get_hr_stage10_workspace'")
    expect(worker).not.toMatch(/payroll-integration\/(proposal|approval|reconcile|cutover|webhook)/)
  })

  it('uses exact route access and compact governed lists', () => {
    expect(policy).toContain("'/hr/payroll-integration': { anyOf: ['hr.payroll_integration.view'] }")
    expect(router).toContain("path: 'hr/payroll-integration'")
    expect(navigation).toContain("path: '/hr/payroll-integration'")
    expect(page).toContain('<HrPagination')
    for (const size of ['<option value="5">5</option>', '<option value="10">10</option>', '<option value="20">20</option>']) {
      expect(pagination).toContain(size)
    }
    expect(page).toContain('is safely staged')
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260831160000_hris_stage9_offboarding_self_service_reporting_foundation.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const wrangler = readFileSync('wrangler.jsonc', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')
const page = readFileSync('src/pages/HrisStage9Page.tsx', 'utf8')

describe('HRIS Stage 9 lifecycle, self-service, and reporting foundation', () => {
  it('keeps all production release gates dormant', () => {
    for (const moduleName of ['OFFBOARDING', 'SELF_SERVICE', 'REPORTING']) {
      expect(wrangler).toContain(`"SYGSHIFT_HR_${moduleName}_ENABLED": "false"`)
    }
    expect(migration).toContain('enabled boolean not null default false')
  })

  it('does not assign access or alter protected operating records', () => {
    expect(migration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
    expect(migration).toContain('hris_stage9_preservation_baseline')
    expect(migration).toContain('baseline.schedule_count')
    expect(migration).toContain('baseline.time_event_count')
  })

  it('isolates records and protects append-only history', () => {
    expect(migration).toContain('enable row level security')
    expect(migration).toContain('revoke all on private.%I from public,anon,authenticated')
    expect(migration).toContain('prevent_append_only_change')
    expect(migration).toContain('hr_lifecycle_events_append_only')
    expect(migration).toContain('hr_report_events_append_only')
  })

  it('scopes self-service and report records to effective authority', () => {
    expect(migration).toContain('can_manage or request.requester_id=target_actor_id or request.subject_employee_id=target_actor_id')
    expect(migration).toContain("can_manage or report.owner_id=target_actor_id or report.visibility='authorized_hr'")
  })

  it('requires verified sessions, exact permissions, and recent MFA', () => {
    expect(worker).toContain('requireVerifiedOperationsSession(request, environment, `hr_${module}_mfa_required`)')
    expect(worker).toContain('requireSessionPermission(session.context, hrStage9Permissions[module])')
    expect(worker).toContain("module === 'offboarding' || module === 'reporting'")
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
  })

  it('uses compact lists and safe staged messages', () => {
    expect(page).toContain('<option value="5">5</option>')
    expect(page).toContain('<option value="10">10</option>')
    expect(page).toContain('<option value="20">20</option>')
    expect(page).toContain('is safely staged')
    expect(navigation).toContain("path: '/hr/offboarding'")
    expect(navigation).toContain("path: '/hr/self-service'")
    expect(navigation).toContain("path: '/hr/reporting'")
  })
})

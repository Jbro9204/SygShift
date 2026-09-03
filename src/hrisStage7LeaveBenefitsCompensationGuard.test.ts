/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260831040000_hris_stage7_leave_benefits_compensation_foundation.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const wrangler = readFileSync('wrangler.jsonc', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')
const page = readFileSync('src/pages/HrisStage7Page.tsx', 'utf8')
const employeeFileRelease = readFileSync('supabase/migrations/20260902010000_employee_file_editing_and_pay_rates.sql', 'utf8')

describe('HRIS Stage 7 leave, benefits, and compensation foundation', () => {
  it('releases leave and benefits through the approved operational boundary', () => {
    expect(wrangler).toContain('"SYGSHIFT_HR_LEAVE_ENABLED": "true"')
    expect(wrangler).toContain('"SYGSHIFT_HR_BENEFITS_ENABLED": "true"')
    expect(wrangler).toContain('"SYGSHIFT_HR_COMPENSATION_ENABLED": "true"')
    expect(migration).toContain('enabled boolean not null default false')
    expect(employeeFileRelease).toContain('update private.hr_compensation_release_gate')
    expect(employeeFileRelease).toContain('where singleton')
    expect(employeeFileRelease).toContain('release_key =')
  })

  it('preserves existing access assignments and operational time off', () => {
    expect(migration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
    expect(migration).toContain('hris_stage7_preservation_baseline')
    expect(migration).toContain('references public.time_off_requests(id)')
    expect(navigation).toContain("path: '/requests'")
  })

  it('isolates protected records and browser access', () => {
    expect(migration).toContain('document_id uuid references private.hr_documents(id)')
    expect(migration).toContain('enable row level security')
    expect(migration).toContain('revoke all on private.%I from public,anon,authenticated')
    expect(migration).toContain('to service_role')
  })

  it('requires exact permissions and verified operations sessions', () => {
    expect(worker).toContain("requireVerifiedOperationsSession(request, environment, 'hr_leave_mfa_required')")
    expect(worker).toContain("requireVerifiedOperationsSession(request, environment, 'hr_benefits_mfa_required')")
    expect(worker).toContain("requireVerifiedOperationsSession(request, environment, 'hr_compensation_mfa_required')")
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.leave.view')")
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.benefits.view')")
    expect(worker).toContain("requireSessionPermission(session.context, 'hr.compensation.view')")
  })

  it('protects compensation with recent MFA and two-person approval', () => {
    expect(worker).toContain('const mfa = await requireRecentDocumentMfa(request, session)')
    expect(migration).toContain('hr_compensation_require_recent_mfa')
    expect(migration).toContain('hr_compensation_approval_separation')
    expect(migration).toContain('proposal_author = new.approver_id')
    expect(migration).toContain('hr_compensation_approvals_append_only')
  })

  it('uses compact lists and a safe staged state', () => {
    expect(page).toContain('<option value="5">5</option>')
    expect(page).toContain('<option value="10">10</option>')
    expect(page).toContain('<option value="20">20</option>')
    expect(page).toContain('is safely staged')
  })
})

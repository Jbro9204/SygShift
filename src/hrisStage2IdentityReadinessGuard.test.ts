/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const page = readFileSync(join(root, 'src', 'pages', 'HrisIdentityReadinessPage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'hrisIdentityReadiness.ts'), 'utf8')
const navigation = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const accessPolicy = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const router = readFileSync(join(root, 'src', 'app', 'router.tsx'), 'utf8')
const readinessMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260830013000_hris_stage2_identity_readiness_workspace.sql'),
  'utf8',
)
const controlMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260830005500_hris_stage2_controlled_backfill.sql'),
  'utf8',
)

describe('HRIS Stage 2 employment-data readiness guardrails', () => {
  it('requires MFA-protected HR employee-management permission on both readiness actions', () => {
    expect(readinessMigration).toContain('private.require_hris_stage2_manager()')
    expect(controlMigration).toContain('private.require_hris_stage2_manager()')
    expect(controlMigration).toContain("public.has_effective_permission('hr.people.manage')")
    expect(controlMigration).toContain('public.has_mfa()')
    expect(readinessMigration).toContain('from public, anon')
    expect(readinessMigration).toContain('to authenticated')
  })

  it('keeps the browser workspace review-only and the identity backfill gate closed', () => {
    expect(readinessMigration).toContain("'browserExecutionAvailable', false")
    expect(readinessMigration).toContain('backfill gate to remain closed')
    expect(page).toContain('No browser execution is available.')
    expect(page).not.toContain('execute_hris_stage2_backfill')
    expect(page).not.toContain('set_hris_stage2_backfill_gate')
    expect(data).not.toContain('execute_hris_stage2_backfill')
    expect(data).not.toContain('set_hris_stage2_backfill_gate')
  })

  it('bounds every result page and limits discovery to legal name and employee number', () => {
    expect(readinessMigration).toContain('least(greatest(coalesce(target_page_size, 10), 1), 10)')
    expect(readinessMigration).toContain("clean_status not in ('all', 'onboarding', 'active', 'leave', 'inactive', 'separated')")
    expect(page).toContain('<option value={5}>5</option>')
    expect(page).toContain('<option value={10}>10</option>')
    expect(page).toContain('Legal name or employee number')
    expect(readinessMigration).not.toContain('preferred_name')
    expect(readinessMigration).not.toContain('personal_email')
    expect(readinessMigration).not.toContain('company_email')
    expect(readinessMigration).not.toContain('mobile_phone')
    expect(readinessMigration).not.toContain('auth_user_id')
  })

  it('records authoritative date evidence without modifying employee or identity records', () => {
    expect(data).toContain("rpc('authorize_hris_stage2_effective_dates'")
    expect(page).toContain('Source reference')
    expect(page).toContain('Audit reason')
    expect(page).toContain('required value={dateForm.sourceReference}')
    expect(page).toContain('required rows={4} value={dateForm.reason}')
    expect(controlMigration).toContain('The supplied hire date conflicts with the permanent employee record.')
    expect(controlMigration).toContain('The supplied separation date conflicts with the permanent employee record.')
    expect(readinessMigration).not.toMatch(/insert\s+into\s+private\.hr_(person|worker)_identifiers/i)
    expect(readinessMigration).not.toMatch(/update\s+public\.employees/i)
    expect(readinessMigration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
  })

  it('proves protected record preservation inside the database transaction', () => {
    expect(readinessMigration).toContain('hris_stage2_readiness_preservation_baseline')
    expect(readinessMigration).toContain('Stage 2 readiness workspace changed protected employee, access, or HR identity records.')
    expect(readinessMigration).toContain('baseline.person_identifier_count')
    expect(readinessMigration).toContain('baseline.worker_identifier_count')
    expect(readinessMigration).toContain('baseline.gate_enabled')
  })

  it('wires the protected workspace through the HR & Finance route boundary', () => {
    expect(navigation).toContain("label: 'Employment Data Readiness'")
    expect(navigation).toContain("path: '/hr/identity-readiness'")
    expect(navigation).toContain("permissions: ['hr.people.manage']")
    expect(accessPolicy).toContain("'/hr/identity-readiness': { anyOf: ['hr.people.manage'] }")
    expect(router).toContain("path: 'hr/identity-readiness'")
  })
})

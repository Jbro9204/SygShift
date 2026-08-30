/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260831120000_hris_stage8_talent_learning_cases_safety_assets_foundation.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const wrangler = readFileSync('wrangler.jsonc', 'utf8')
const navigation = readFileSync('src/app/navigation.ts', 'utf8')
const page = readFileSync('src/pages/HrisStage8Page.tsx', 'utf8')

describe('HRIS Stage 8 talent, learning, cases, safety, and assets foundation', () => {
  it('keeps every production release gate dormant', () => {
    for (const moduleName of ['TALENT', 'LEARNING', 'CASES', 'SAFETY', 'ASSETS']) {
      expect(wrangler).toContain(`"SYGSHIFT_HR_${moduleName}_ENABLED": "false"`)
    }
    expect(migration).toContain('enabled boolean not null default false')
  })

  it('does not assign protected access or alter existing people', () => {
    expect(migration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
    expect(migration).toContain('hris_stage8_preservation_baseline')
    expect(migration).toContain('baseline.employee_count')
    expect(migration).toContain('baseline.employee_role_count')
  })

  it('isolates protected records and append-only history', () => {
    expect(migration).toContain('enable row level security')
    expect(migration).toContain('revoke all on private.%I from public,anon,authenticated')
    expect(migration).toContain('prevent_append_only_change')
    expect(migration).toContain('hr_asset_acknowledgments_append_only')
  })

  it('requires verified sessions and exact permissions', () => {
    expect(worker).toContain('requireVerifiedOperationsSession(request, environment, `hr_${module}_mfa_required`)')
    expect(worker).toContain('requireSessionPermission(session.context, hrStage8Permissions[module])')
    for (const permission of ['hr.talent.view', 'hr.learning.view', 'hr.cases.view', 'hr.safety.view', 'hr.assets.view']) {
      expect(worker).toContain(permission)
    }
  })

  it('requires recent MFA for employee cases and safety records', () => {
    expect(worker).toContain("module === 'cases' || module === 'safety'")
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
    expect(migration).toContain("target_module in ('cases','safety')")
    expect(migration).toContain('hr_stage8_require_recent_mfa')
  })

  it('uses compact lists and safe staged messages', () => {
    expect(page).toContain('<option value="5">5</option>')
    expect(page).toContain('<option value="10">10</option>')
    expect(page).toContain('<option value="20">20</option>')
    expect(page).toContain('is safely staged')
    expect(navigation).toContain("path: '/hr/talent-learning'")
    expect(navigation).toContain("path: '/hr/cases-compliance'")
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260831210000_hris_admin_permission_baseline.sql', 'utf8')

describe('HRIS Admin permission baseline', () => {
  it('grants the protected Admin role every currently active permission', () => {
    expect(migration).toContain("where admin_role.code = 'system_admin'")
    expect(migration).toContain('and permission.active')
    expect(migration).toContain('on conflict (role_id, permission_code) do update')
    expect(migration).toContain('Admin permission activation did not cover the complete active catalog.')
  })

  it('does not silently grant future permissions', () => {
    expect(migration).toContain("'scope', 'reviewed-current-catalog-only'")
    expect(migration).not.toMatch(/create\s+(or\s+replace\s+)?trigger[\s\S]*system_admin/i)
  })

  it('prevents Admin permissions from being removed through role management', () => {
    expect(migration).toContain('The protected Admin role must retain every active permission.')
    expect(migration).toContain('not (catalog.code = any(clean_permissions))')
  })

  it('preserves every other access boundary', () => {
    for (const boundary of [
      'non_admin_role_permission_fingerprint', 'employee_access_role_fingerprint',
      'employee_override_fingerprint', 'employee_identity_fingerprint',
    ]) expect(migration).toContain(boundary)
  })

  it('keeps every unfinished HR release gate disabled', () => {
    for (const gate of [
      'hr_stage2_backfill_gate', 'hr_document_release_gate', 'hr_automation_release_gate',
      'hr_recruiting_release_gate', 'hr_onboarding_release_gate', 'hr_leave_release_gate',
      'hr_benefits_release_gate', 'hr_compensation_release_gate', 'hr_stage8_release_gates',
      'hr_stage9_release_gates', 'hr_stage10_release_gates',
    ]) expect(migration).toContain(`private.${gate}`)
    expect(migration).toContain('A dormant HR release gate changed during Admin activation.')
  })

  it('provides a service-only audited recovery path', () => {
    expect(migration).toContain('private.repair_system_admin_permission_baseline()')
    expect(migration).toContain('grant execute on function private.repair_system_admin_permission_baseline() to service_role')
    expect(migration).toContain("'REPAIR'")
  })
})

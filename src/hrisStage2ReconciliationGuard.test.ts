import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const contract = JSON.parse(readFileSync(resolve(process.cwd(), 'config/hris-stage-2-reconciliation.json'), 'utf8'))
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260829233000_hris_stage2_reconciliation_proposal.sql'), 'utf8')

describe('HRIS Stage 2 deterministic reconciliation proposal', () => {
  it('keeps the feature, protected backfill, role mapping, and browser access disabled', () => {
    expect(contract.releaseState).toEqual({
      featureEnabled: false,
      protectedProductionBackfillAllowed: false,
      roleMappingAllowed: false,
      browserDirectAccessAllowed: false,
    })
    expect(migration).not.toMatch(/insert\s+into\s+private\.hr_(person|worker)_identifiers/i)
  })

  it('proposes stable one-to-one identifiers from the permanent employee UUID', () => {
    expect(contract.proposal.deterministicIdentifiers).toBe(true)
    expect(migration).toContain("private.hris_deterministic_uuid('sygshift-hr-person-v1', employee.id)")
    expect(migration).toContain("private.hris_deterministic_uuid('sygshift-hr-worker-v1', employee.id)")
    expect(migration).toContain("'SYG-' || employee.id::text")
  })

  it('blocks identity conflicts and records incomplete source data as review warnings', () => {
    for (const code of contract.blockingConditions) expect(migration).toContain(`'${code}'`)
    for (const code of contract.reviewWarnings) expect(migration).toContain(`'${code}'`)
    expect(migration).toContain("when cardinality(inspected.blocker_codes) > 0 then 'blocked'")
  })

  it('limits detailed proposal access to the service layer and keeps aggregate reporting free of employee detail', () => {
    expect(contract.proposal.serviceRoleOnly).toBe(true)
    expect(contract.proposal.aggregateOutputContainsPersonalData).toBe(false)
    expect(migration).toContain('revoke all on function private.hris_stage2_mapping_proposal() from public, anon, authenticated')
    expect(migration).toContain('grant execute on function private.hris_stage2_mapping_proposal() to service_role')
    expect(migration).toContain("'protectedBackfillAllowed', false")
  })

  it('preserves live employee, access, and HR mapping counts in the migration transaction', () => {
    expect(migration).toContain('hris_stage2_run2_preservation_baseline')
    expect(migration).toContain('baseline.employee_count')
    expect(migration).toContain('baseline.employee_role_count')
    expect(migration).toContain('baseline.role_permission_count')
    expect(migration).toContain('baseline.override_count')
    expect(migration).toContain('baseline.person_identifier_count')
    expect(migration).toContain('baseline.worker_identifier_count')
    expect(migration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
  })
})

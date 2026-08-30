import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const config = JSON.parse(readFileSync(resolve(process.cwd(), 'config/hris-core-data-architecture.json'), 'utf8'))
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260829230000_hris_core_data_architecture.sql'), 'utf8')

describe('HRIS Stage 2 core data architecture', () => {
  it('extends the permanent employee identity without creating a second directory', () => {
    expect(config.identity).toMatchObject({
      authoritativeEmployeeTable: 'public.employees',
      employeeNumberIsPrimaryKey: false,
      onePersonPerEmployee: true,
      oneWorkerPerPerson: true,
      duplicatesLegalNames: false,
      duplicatesContactDetails: false,
      duplicatesAuthenticationIdentity: false,
    })
    expect(migration).toContain('employee_id uuid not null unique references public.employees(id) on delete restrict')
  })

  it('keeps protected records feature-off and blocks production backfill', () => {
    expect(config.releaseState).toMatchObject({
      featureEnabled: false,
      protectedProductionBackfillAllowed: false,
      roleMappingAllowed: false,
      browserDirectAccessAllowed: false,
    })
    expect(migration).not.toContain('insert into private.hr_person_identifiers')
    expect(migration).not.toContain('insert into private.hr_worker_identifiers')
  })

  it('protects effective-dated history from deletion, rewriting, and overlap', () => {
    expect(config.historyControls).toMatchObject({
      deletesAllowed: false,
      effectiveRecordsCloseOnly: true,
      overlapPrevention: true,
      separatedEmployeesPreserved: true,
    })
    expect(migration).toContain('create function private.hris_protect_effective_record()')
    expect(migration).toContain('create function private.hris_prevent_effective_overlap()')
    expect(migration).toContain('history is permanent and cannot be deleted')
    expect(migration).toContain('has an overlapping effective-dated record')
    expect(migration).toContain('A worker cannot be assigned as their own manager.')
    expect(migration).toContain('requires an actor, timestamp, and reason')
  })

  it('adds permission definitions without changing current role or person access', () => {
    expect(config.permissions).toEqual(expect.arrayContaining([
      'hr.people.view',
      'hr.people.manage',
      'hr.people.restricted',
      'hr.total_rewards.view',
      'hr.total_rewards.manage',
      'hr.total_rewards.restricted',
    ]))
    expect(migration).toContain('hris_stage2_preservation_baseline')
    expect(migration).not.toContain('insert into public.access_role_permissions')
    expect(migration).not.toContain('insert into public.employee_access_roles')
    expect(migration).not.toContain('insert into public.employee_permission_overrides')
  })

  it('denies direct browser access and exposes reconciliation only to the service layer', () => {
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain('grant execute on function private.hris_core_reconciliation_report() to service_role')
    expect(migration).toContain('grant execute on function private.assert_hris_core_integrity() to service_role')
    expect(migration).toContain("'unresolvedEmployeeCount'")
    expect(migration).toContain("'duplicateEmployeeMappings'")
  })
})

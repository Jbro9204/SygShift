import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const contract = JSON.parse(readFileSync(resolve(process.cwd(), 'config/hris-stage-2-controlled-backfill.json'), 'utf8'))
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260830005500_hris_stage2_controlled_backfill.sql'), 'utf8')

describe('HRIS Stage 2 controlled backfill plane', () => {
  it('installs closed and records that no production backfill has run', () => {
    expect(contract.releaseState).toEqual({
      featureEnabled: false,
      productionBackfillGateEnabled: false,
      canaryExecuted: false,
      fullBackfillExecuted: false,
      roleMappingAllowed: false,
      browserDirectAccessAllowed: false,
    })
    expect(migration).toContain("values (true, false, 'Stage 2 protected backfill remains disabled.')")
    expect(migration).not.toMatch(/select\s+private\.execute_hris_stage2_identity_backfill\s*\(/i)
  })

  it('requires authoritative dates, recovery evidence, MFA, and HR management permission', () => {
    expect(contract.effectiveDates.guessingAllowed).toBe(false)
    expect(contract.recovery.productionEvidencePresent).toBe(false)
    expect(migration).toContain('Authoritative hire and separation dates are incomplete.')
    expect(migration).toContain('Current isolated recovery evidence is required.')
    expect(migration).toContain('if not public.has_mfa()')
    expect(migration).toContain("public.has_effective_permission('hr.people.manage')")
  })

  it('limits canaries, expires authorizations, and permits only service execution', () => {
    expect(contract.authorization.maximumCanaryEmployees).toBe(3)
    expect(contract.authorization.authorizationMinutes).toBe(15)
    expect(migration).toContain('cardinality(clean_employee_ids) not between 1 and 3')
    expect(migration).toContain("clock_timestamp() + interval '15 minutes'")
    expect(migration).toContain("coalesce(auth.role(), '') <> 'service_role'")
  })

  it('rejects stale snapshots and preserves operational row counts around execution', () => {
    expect(contract.authorization.staleSnapshotRejected).toBe(true)
    expect(migration).toContain('before_snapshot <> authorization_record.authorization_snapshot')
    expect(migration).toContain('if before_snapshot <> after_snapshot')
    for (const domain of contract.preservationDomains) expect(migration).toContain(`'${domain}'`)
  })

  it('does not alter employee access or duplicate personal identity fields', () => {
    expect(migration).not.toMatch(/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i)
    expect(migration).not.toMatch(/update\s+public\.employees/i)
    expect(migration).not.toMatch(/\b(first_name|last_name|preferred_name|personal_email|company_email|mobile_phone|auth_user_id)\b/i)
  })
})

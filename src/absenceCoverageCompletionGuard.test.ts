import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260914141934_absence_coverage_completion.sql', 'utf8')
const contractHardeningMigration = readFileSync('supabase/migrations/20260914145246_absence_coverage_contract_hardening.sql', 'utf8')
const requests = readFileSync('src/data/requests.ts', 'utf8')
const operations = readFileSync('src/time/TimeOperationsPage.tsx', 'utf8')
const accountability = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')

describe('absence coverage completion guardrails', () => {
  it('restores the manager permission contract instead of silently defaulting it away', () => {
    expect(migration).toContain("'permissions', jsonb_build_object(")
    expect(contractHardeningMigration).toContain("'canManage', public.has_effective_permission('requests.manage')")
    expect(requests).not.toContain(".optional().default({ canManage: false })")
  })

  it('does not reopen coverage when an absence is corrected to a non-absence', () => {
    expect(contractHardeningMigration).toContain("target_event_type not in ('called_in_sick', 'call_off', 'no_call_no_show')")
    expect(contractHardeningMigration).toContain("'coverageRequired', false")
    expect(accountability).toContain('result.coverageRequired ? result.callOffId : null')
  })

  it('routes every newly recorded call-off into a recoverable coverage workflow', () => {
    expect(migration).toContain("concat('/requests?callOff=', report.id)")
    expect(migration).toContain("'coverageRequired', report.replacement_needed")
    expect(operations).toContain('setRecordedCallOff({ id: result.id, replacementNeeded: input.replacementNeeded })')
    expect(operations).toContain('Finish coverage')
    expect(accountability).toContain('<option value="call_off">Absent / call-off</option>')
    expect(accountability).toContain('if (result.callOffId) setCoverageCallOffId(result.callOffId)')
    expect(migration).toContain('private.ensure_attendance_absence_call_off_report(')
  })

  it('does not auto-create or backfill a shift while repairing existing alerts', () => {
    const repair = migration.slice(migration.indexOf('-- Repair only active unresolved call-off alerts.'))
    expect(repair).toContain('update public.operational_alerts')
    expect(repair).not.toContain('insert into public.shifts')
    expect(repair).not.toContain('insert into public.shift_assignments')
  })
})

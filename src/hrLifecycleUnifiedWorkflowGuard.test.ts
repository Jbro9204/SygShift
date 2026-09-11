/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260912110000_guided_offboarding_workflow.sql', 'utf8')
const backfill = readFileSync('supabase/migrations/20260912111000_guided_offboarding_existing_case_backfill.sql', 'utf8')
const executionRepair = readFileSync('supabase/migrations/20260912170000_hr_lifecycle_effective_date_source_repair.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const page = readFileSync('src/pages/HrisStage9Page.tsx', 'utf8')
const wizard = readFileSync('src/components/HrLifecycleCaseWizard.tsx', 'utf8')
const dialog = readFileSync('src/components/HrLifecycleCaseDialog.tsx', 'utf8')
const data = readFileSync('src/data/hrOffboarding.ts', 'utf8')
const styles = readFileSync('src/App.css', 'utf8')

describe('unified guided HR lifecycle workflow', () => {
  it('keeps the browser behind Worker and database authorization', () => {
    expect(worker).toContain("url.pathname === '/api/v1/hr/offboarding/options'")
    expect(worker).toContain("url.pathname === '/api/v1/hr/offboarding/cases'")
    expect(worker).toContain("/^\\/api\\/v1\\/hr\\/offboarding\\/cases\\/([0-9a-f-]{36})\\/execute$/i")
    expect(migration).toContain("if (select auth.role()) <> 'service_role'")
    expect(migration).toContain("private.hr_stage9_require_actor_permission(target_actor_id, 'hr.offboarding.approve')")
    expect(migration).toContain("private.hr_stage9_require_actor_permission(target_actor_id, 'hr.people.manage')")
    expect(migration).toContain('private.hr_stage9_require_recent_mfa(')
    expect(migration).toContain('Only an Admin can complete an Admin separation.')
  })

  it('requires maker-checker approval, a complete checklist, and human confirmation', () => {
    expect(migration).toContain('A different qualified person must review this case.')
    expect(migration).toContain('Complete or formally waive every required checklist item before final execution.')
    expect(migration).toContain('Enter the employee username exactly to confirm final execution.')
    expect(migration).toContain("else 'approved_scheduled' end")
    expect(migration).toContain("set status = 'due'")
    expect(dialog).toContain('Independent approval required')
    expect(dialog).toContain('Final human-confirmed action')
    expect(dialog).toContain('Confirm employee username')
  })

  it('preserves historical records and prevents silent reactivation', () => {
    expect(migration).toContain('private.separate_employee_account_and_future_work(')
    expect(migration).toContain("update public.employees set status = 'onboarding'")
    expect(migration).toContain("'accessRestored', false")
    expect(migration).toContain('Account, role assignments, overrides, MFA devices, pay, licenses, and schedules remain inactive.')
    expect(migration).not.toMatch(/delete\s+from\s+public\.(employees|time_events|shifts|shift_assignments)/i)
    expect(backfill).toContain('on conflict(lifecycle_case_id, workstream) do nothing')
    expect(backfill).toContain('guided_workflow_backfilled')
    expect(backfill).not.toMatch(/update\s+public\.(employees|time_events|shifts|shift_assignments)/i)
    expect(backfill).not.toMatch(/delete\s+from/i)
  })

  it('allows the guided separation source in effective-date history without weakening prior sources', () => {
    expect(migration).toContain("'offboarding_case'")
    expect(executionRepair).toContain('drop constraint if exists hr_stage2_effective_dates_source')
    expect(executionRepair).toContain('add constraint hr_stage2_effective_dates_source check')
    expect(executionRepair).toContain('validate constraint hr_stage2_effective_dates_source')
    for (const source of ['hr_export', 'employee_file', 'verified_hr_record', 'verified_manual', 'offboarding_case']) {
      expect(executionRepair).toContain(`'${source}'`)
    }
    expect(executionRepair).not.toMatch(/delete\s+from/i)
  })

  it('provides the guided workspace, live readiness, linked forms, reminders, and audit timeline', () => {
    expect(page).toContain('HrLifecycleCaseWizard')
    expect(page).toContain('HrLifecycleCaseDialog')
    expect(page).toContain('Export view')
    for (const step of ['Employee & reason', 'Effective date', 'Checklist', 'Review']) {
      expect(wizard).toContain(step)
    }
    expect(dialog).toContain('Live readiness checks')
    expect(dialog).toContain('Approved HR documents')
    expect(dialog).toContain('Permanent case timeline')
    expect(migration).toContain('private.hr_lifecycle_document_links')
    expect(migration).toContain("'hr_offboarding'")
    expect(migration).toContain('action_required')
    expect(worker).toContain('service_refresh_hr_offboarding_due_cases')
    expect(data).toContain('lifecycleCaseDetailSchema')
    expect(styles).toContain('.hr-lifecycle-wizard')
    expect(styles).toContain('@media (max-width: 760px)')
  })
})

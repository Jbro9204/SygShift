/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260903191657_hris_operational_workflows.sql', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const actionPanel = readFileSync('src/components/HrOperationalActions.tsx', 'utf8')
const recruitingPanel = readFileSync('src/components/HrRecruitingActions.tsx', 'utf8')
const wrangler = readFileSync('wrangler.jsonc', 'utf8')

describe('HR Suite operational release', () => {
  it('uses one service-only, audited mutation boundary', () => {
    expect(migration).toContain('service_hr_operational_action')
    expect(migration).toContain('service_get_hr_operational_options')
    expect(migration).toMatch(/revoke all on function public\.service_hr_operational_action[\s\S]+from public,anon,authenticated/i)
    expect(migration).toContain('to service_role')
    for (const eventTable of ['hr_leave_events', 'hr_benefit_events', 'hr_talent_events', 'hr_learning_events', 'hr_case_events', 'hr_safety_events', 'hr_asset_events', 'hr_lifecycle_events', 'hr_service_request_events', 'hr_report_events']) {
      expect(migration).toContain(eventTable)
    }
  })

  it('repairs the released onboarding and recruiting runtime ambiguities', () => {
    expect(migration).toContain('onboarding template-version repair target')
    expect(migration).toContain('onboarding personal-email repair target')
    expect(migration).toContain('candidate-conversion applicant repair target')
    expect(migration).toContain('pg_get_functiondef')
  })

  it('preserves people, access, and every protected business record during release', () => {
    expect(migration).toContain('hris_operational_release_baseline')
    for (const count of ['employee_count', 'role_assignment_count', 'override_count', 'leave_count', 'benefit_count', 'talent_count', 'learning_count', 'case_count', 'safety_count', 'asset_count', 'lifecycle_count', 'request_count', 'report_count']) {
      expect(migration).toContain(count)
    }
  })

  it('enforces exact Worker permissions and recent MFA for restricted modules', () => {
    expect(worker).toContain('hrOperationalActionPermissions')
    expect(worker).toContain("'/api/v1/hr/operations/actions'")
    expect(worker).toContain("'/api/v1/hr/operations/options'")
    expect(worker).toContain('requireSessionPermission(session.context, permission)')
    expect(worker).toContain("module === 'cases' || module === 'safety' || module === 'offboarding' || module === 'reporting'")
    expect(worker).toContain('requireRecentDocumentMfa(request, session)')
  })

  it('provides real management controls instead of read-only staged pages', () => {
    for (const moduleName of ['leave', 'benefits', 'talent', 'learning', 'cases', 'safety', 'assets', 'offboarding', 'self_service', 'reporting']) {
      expect(actionPanel).toContain(`${moduleName}:`)
    }
    expect(recruitingPanel).toContain('Create requisition')
    expect(recruitingPanel).toContain('Add applicant')
  })

  it('activates only in-system HR modules and leaves external integration cutovers closed', () => {
    for (const moduleName of ['RECRUITING', 'ONBOARDING', 'LEAVE', 'BENEFITS', 'COMPENSATION', 'TALENT', 'LEARNING', 'CASES', 'SAFETY', 'ASSETS', 'OFFBOARDING', 'SELF_SERVICE', 'REPORTING']) {
      expect(wrangler).toContain(`"SYGSHIFT_HR_${moduleName}_ENABLED": "true"`)
    }
    for (const moduleName of ['AUTOMATION', 'PAYROLL_INTEGRATION', 'PAYROLL_WEBHOOKS', 'ENTERPRISE_CUTOVER']) {
      expect(wrangler).toContain(`"SYGSHIFT_HR_${moduleName}_ENABLED": "false"`)
    }
  })
})

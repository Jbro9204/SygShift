/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const wrangler = readFileSync('wrangler.jsonc', 'utf8')
const worker = readFileSync('worker/index.ts', 'utf8')
const page = readFileSync('src/pages/HrisOnboardingPage.tsx', 'utf8')
const provisioning = readFileSync('supabase/migrations/20260831230000_hris_onboarding_account_provisioning.sql', 'utf8')
const release = readFileSync('supabase/migrations/20260831233000_hris_onboarding_production_release.sql', 'utf8')

describe('HR onboarding production release', () => {
  it('enables only the approved onboarding surface', () => {
    expect(wrangler).toContain('"SYGSHIFT_HR_ONBOARDING_ENABLED": "true"')
    for (const gate of [
      'SYGSHIFT_HR_RECRUITING_ENABLED', 'SYGSHIFT_HR_LEAVE_ENABLED', 'SYGSHIFT_HR_BENEFITS_ENABLED',
      'SYGSHIFT_HR_COMPENSATION_ENABLED', 'SYGSHIFT_HR_TALENT_ENABLED', 'SYGSHIFT_HR_LEARNING_ENABLED',
      'SYGSHIFT_HR_CASES_ENABLED', 'SYGSHIFT_HR_SAFETY_ENABLED', 'SYGSHIFT_HR_ASSETS_ENABLED', 'SYGSHIFT_HR_OFFBOARDING_ENABLED',
      'SYGSHIFT_HR_SELF_SERVICE_ENABLED', 'SYGSHIFT_HR_REPORTING_ENABLED',
      'SYGSHIFT_HR_PAYROLL_INTEGRATION_ENABLED', 'SYGSHIFT_HR_PAYROLL_WEBHOOKS_ENABLED',
      'SYGSHIFT_HR_ENTERPRISE_CUTOVER_ENABLED',
    ]) expect(wrangler).toContain(`"${gate}": "false"`)
  })

  it('uses service-protected pre-hire, evidence, and delivery workflows', () => {
    expect(worker).toContain('/api/v1/hr/onboarding/prehires')
    expect(worker).toContain('\\/welcome-package')
    expect(worker).toContain("target_kind: deliveryKind")
    expect(worker).not.toContain('target_delivery_kind')
    expect(provisioning).toContain('service_hr_onboarding_create_prehire')
    expect(provisioning).toContain('service_hr_onboarding_record_delivery')
    expect(provisioning).toContain('documentRequired')
    expect(provisioning).toContain('requires_guard_license')
    expect(provisioning).toContain('requires_armed_credentials')
    expect(provisioning).not.toContain('private.generate_username')
  })

  it('keeps company welcome and account setup as separate audited deliveries', () => {
    expect(worker).toContain("recordOnboardingDelivery(session.config, session.context.employee_id, welcomeCaseId, 'welcome'")
    expect(worker).toContain("recordOnboardingDelivery(session.config, session.context.employee_id, welcomeCaseId, 'account_setup'")
    expect(worker).toContain('await sendWelcomeEmail(environment, target)')
    expect(worker).toContain('await sendLoginInstructions(environment, target, result.password)')
    expect(page).toContain('Separate communications')
    expect(page).toContain('Company welcome')
    expect(page).toContain('Account setup')
  })

  it('requires approval before final employment activation', () => {
    expect(provisioning).toContain("hr.onboarding.approve")
    expect(page).toContain('Approve and activate employment')
    expect(page).toContain('Final activation is protected.')
  })

  it('preserves every existing access and identity assignment during release', () => {
    for (const snapshot of [
      'role_permission_fingerprint', 'employee_role_fingerprint',
      'employee_override_fingerprint', 'employee_account_fingerprint',
    ]) expect(release).toContain(snapshot)
    expect(release).toContain('Onboarding release changed protected access or account state; the transaction was rolled back.')
    expect(release).toContain("'hr_onboarding_release_gate'")
    expect(release).toContain('private.audit_events')
    expect(release).not.toMatch(/(?:insert\s+into|update|delete\s+from)\s+(?:public\.(?:employee_access_roles|access_role_permissions|employee_permission_overrides|employees)|private\.employee_accounts)/i)
  })
})

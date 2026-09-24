import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('onboarding repair and account-activity report guardrails', () => {
  it('removes the ambiguous template filter and preserves an existing-employee recovery path', () => {
    const migration = read('supabase/migrations/20260924154218_onboarding_account_readiness_report.sql')
    const ambiguityRepair = read('supabase/migrations/20260924160323_onboarding_personal_email_ambiguity_repair.sql')
    const regression = read('supabase/tests/onboarding_account_activity_release_regression.sql')
    const data = read('src/data/hrOnboarding.ts')
    const page = read('src/pages/HrisOnboardingPage.tsx')
    expect(migration).toContain('step.template_id = selected_template_id')
    expect(migration).toContain('step.template_version = selected_template_version')
    expect(migration).not.toContain('step.template_id=template_id and step.template_version=template_version')
    expect(ambiguityRepair).toContain('personal_email_value text := lower')
    expect(ambiguityRepair).toContain('lower(contact.personal_email)=personal_email_value')
    expect(migration).toContain('service_hr_onboarding_launch_existing')
    expect(migration).toContain('This employee already has an onboarding case.')
    expect(data).toContain("onboardingApi('/api/v1/hr/onboarding/existing'")
    expect(page).toContain('Already in SygShift')
    expect(page).toContain('hr-onboarding-modal-feedback')
    expect(regression).toContain('service_hr_onboarding_create_prehire')
    expect(regression).toContain('Onboarding creation did not create applicable checklist tasks.')
    expect(regression.trimEnd()).toMatch(/rollback;$/)
  })

  it('protects the account report independently in navigation, Worker, and database', () => {
    const migration = read('supabase/migrations/20260924154218_onboarding_account_readiness_report.sql')
    const worker = read('worker/index.ts')
    expect(canAccessRoute('/reports/userAccountActivity', { permissions: ['reports.account_activity.view'] })).toBe(true)
    expect(canAccessRoute('/reports/userAccountActivity', { permissions: ['admin.users.view'] })).toBe(false)
    expect(migration).toContain("'reports.account_activity.view'")
    expect(migration).toContain("'reports.account_activity.export'")
    expect(migration).toContain("role.code in ('system_admin', 'human_resources')")
    expect(migration).toContain("perform private.hr_onboarding_require_actor_permission(target_actor_id,'reports.account_activity.view')")
    expect(migration).toContain("insert into private.audit_events")
    expect(migration).toContain("'EXPORT'")
    expect(migration).toContain('private.employee_sign_in_completions')
    expect(migration).toContain('revoke all on function public.service_get_user_account_activity_report')
    expect(worker).toContain("url.pathname === '/api/v1/reports/user-account-activity'")
    expect(worker).toContain("requireSessionPermission(session.context, 'reports.account_activity.view')")
    expect(worker).toContain("requireSessionPermission(session.context, 'reports.account_activity.export')")
    expect(worker).toContain('const session = await requireRecentHrSession(request, environment)')
  })

  it('keeps protected exports and the report interface professionally complete', () => {
    const workspace = read('src/reports/UserAccountActivityReportWorkspace.tsx')
    const exportBuilder = read('src/reports/userAccountActivityReport.ts')
    const styles = read('src/App.css')
    expect(workspace).toContain('Export Excel')
    expect(workspace).toContain('Export PDF')
    expect(workspace).toContain('Completed sign-ins only')
    expect(exportBuilder).toContain('userAccountActivityWorkbook')
    expect(exportBuilder).toContain('userAccountActivityPdf')
    expect(styles).toContain('.account-activity-filter-row')
    expect(styles).toContain('@media (max-width: 720px)')
    expect(styles).toContain('.hr-onboarding-steps')
  })
})

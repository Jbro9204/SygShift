import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const requireText = (source, text, label) => {
  if (!source.includes(text)) throw new Error(`Stage 6 validation failed: ${label}`)
}

const worker = read('worker/index.ts')
const wrangler = read('wrangler.jsonc')
const policy = read('src/app/accessPolicy.ts')
const router = read('src/app/router.tsx')
const navigation = read('src/app/navigation.ts')
const recruitingData = read('src/data/hrRecruiting.ts')
const onboardingData = read('src/data/hrOnboarding.ts')
const recruitingPage = read('src/pages/HrisRecruitingPage.tsx')
const onboardingPage = read('src/pages/HrisOnboardingPage.tsx')
const recruiting = read('supabase/migrations/20260831010000_hris_stage6_recruiting_foundation.sql')
const conversion = read('supabase/migrations/20260831020000_hris_stage6_candidate_conversion.sql')
const onboarding = read('supabase/migrations/20260831030000_hris_stage6_onboarding_foundation.sql')

requireText(wrangler, '"SYGSHIFT_HR_RECRUITING_ENABLED": "false"', 'Recruiting release flag must default off.')
requireText(wrangler, '"SYGSHIFT_HR_ONBOARDING_ENABLED": "false"', 'Onboarding release flag must default off.')
requireText(worker, "requireVerifiedOperationsSession(request, environment, 'hr_recruiting_mfa_required')", 'Recruiting must require a verified MFA session.')
requireText(worker, "requireVerifiedOperationsSession(request, environment, 'hr_onboarding_mfa_required')", 'Onboarding must require a verified MFA session.')
for (const permission of ['hr.recruiting.view', 'hr.recruiting.manage', 'hr.recruiting.approve']) {
  requireText(recruiting, `'${permission}'`, `Recruiting permission ${permission} is missing.`)
}
for (const permission of ['hr.onboarding.view', 'hr.onboarding.manage', 'hr.onboarding.approve']) {
  requireText(onboarding, `'${permission}'`, `Onboarding permission ${permission} is missing.`)
}

for (const [source, label] of [[recruiting, 'Recruiting'], [conversion, 'Candidate conversion'], [onboarding, 'Onboarding']]) {
  requireText(source, 'enable row level security', `${label} private tables are not protected by RLS.`)
  requireText(source, 'revoke all', `${label} service objects are not revoked from client roles.`)
  requireText(source, 'employee_access_roles', `${label} access-preservation check is missing.`)
  requireText(source, 'access_role_permissions', `${label} role-permission preservation check is missing.`)
  requireText(source, 'employee_permission_overrides', `${label} override preservation check is missing.`)
  if (/insert\s+into\s+public\.(employee_access_roles|access_role_permissions|employee_permission_overrides)/i.test(source)) {
    throw new Error(`Stage 6 validation failed: ${label} migration assigns protected access.`)
  }
}

requireText(recruiting, 'enabled boolean not null default false', 'Recruiting database release gate is missing.')
requireText(recruiting, 'service_get_hr_recruiting_workspace', 'Recruiting workspace service is missing.')
requireText(recruiting, 'service_hr_recruiting_action', 'Recruiting action service is missing.')
for (const relation of ['hr_requisitions', 'hr_applicants', 'hr_applications', 'hr_interviews', 'hr_interview_scorecards', 'hr_offers', 'hr_recruiting_events']) {
  requireText(recruiting, `private.${relation}`, `Recruiting relation ${relation} is missing.`)
}

requireText(conversion, 'private.hr_candidate_duplicate_matches', 'Candidate duplicate matching is missing.')
requireText(conversion, 'service_request_candidate_conversion', 'Candidate conversion request service is missing.')
requireText(conversion, 'service_review_candidate_conversion', 'Candidate conversion approval service is missing.')
requireText(conversion, "conversion.proposed_employment_type,'onboarding'", 'Conversion does not establish a controlled onboarding identity.')

requireText(onboarding, 'enabled boolean not null default false', 'Onboarding database release gate is missing.')
requireText(onboarding, 'service_get_hr_onboarding_workspace', 'Onboarding workspace service is missing.')
requireText(onboarding, 'service_get_hr_onboarding_case', 'Onboarding case service is missing.')
requireText(onboarding, 'service_hr_onboarding_action', 'Onboarding action service is missing.')
for (const relation of ['hr_onboarding_templates', 'hr_onboarding_template_steps', 'hr_onboarding_step_dependencies', 'hr_onboarding_cases', 'hr_onboarding_tasks', 'hr_onboarding_events', 'hr_onboarding_reminders']) {
  requireText(onboarding, `private.${relation}`, `Onboarding relation ${relation} is missing.`)
}

for (const path of ['/api/v1/hr/recruiting/workspace', '/api/v1/hr/recruiting/actions', '/api/v1/hr/recruiting/conversions', '/api/v1/hr/onboarding/workspace', '/api/v1/hr/onboarding/actions']) {
  requireText(worker, path, `Protected Worker route ${path} is missing.`)
}
requireText(worker, "requireAnySessionPermission(session.context, ['hr.recruiting.manage', 'hr.recruiting.approve'])", 'Recruiting mutation permissions are not enforced.')
requireText(worker, "requireAnySessionPermission(session.context, ['hr.onboarding.manage', 'hr.onboarding.approve'])", 'Onboarding mutation permissions are not enforced.')

requireText(policy, "'/hr/recruiting': { anyOf: ['hr.recruiting.view'] }", 'Recruiting route access policy is missing.')
requireText(policy, "'/hr/onboarding': { anyOf: ['hr.onboarding.view'] }", 'Onboarding route access policy is missing.')
requireText(router, "path: 'hr/recruiting'", 'Recruiting application route is missing.')
requireText(router, "path: 'hr/onboarding'", 'Onboarding application route is missing.')
requireText(navigation, "path: '/hr/recruiting'", 'Recruiting navigation entry is missing.')
requireText(navigation, "path: '/hr/onboarding'", 'Onboarding navigation entry is missing.')
requireText(recruitingData, '/api/v1/hr/recruiting/conversions/', 'Candidate conversion client is missing.')
requireText(onboardingData, '/api/v1/hr/onboarding/cases/', 'Onboarding case client is missing.')

for (const page of [recruitingPage, onboardingPage]) {
  for (const size of ['<option value="5">5</option>', '<option value="10">10</option>', '<option value="20">20</option>']) {
    requireText(page, size, 'Compact 5/10/20 list controls are missing.')
  }
  requireText(page, 'remains inactive until its controlled release is approved', 'Dormant release state is not explained safely.')
}

console.log('Stage 6 recruiting and onboarding validation passed.')

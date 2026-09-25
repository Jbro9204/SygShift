import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const onboardingStart = worker.indexOf("if (url.pathname === '/api/v1/hr/onboarding/prehires')")
const onboardingEnd = worker.indexOf("if (url.pathname === '/api/v1/hr/onboarding/options')", onboardingStart)
const recruitingStart = worker.indexOf("if (url.pathname === '/api/v1/hr/recruiting/actions')")
const conversionStart = worker.indexOf("if (url.pathname === '/api/v1/hr/recruiting/conversions')")
const conversionEnd = worker.indexOf('const conversionRequestId =', conversionStart)

describe('onboarding employee time-zone boundary', () => {
  it('requires a supported explicit zone only for pre-hire onboarding', () => {
    const onboardingRoute = worker.slice(onboardingStart, onboardingEnd)
    const recruitingActions = worker.slice(recruitingStart, conversionStart)

    expect(onboardingRoute).toContain("requiredText(payload.timeZone, 'Employee time zone', 64)")
    expect(onboardingRoute).toContain("'America/New_York'")
    expect(onboardingRoute).toContain('invalid_employee_time_zone')
    expect(recruitingActions).not.toContain('payload.timeZone')
    expect(recruitingActions).toContain("'service_hr_recruiting_action'")
  })

  it('requires and forwards a supported zone only at candidate employee conversion', () => {
    const conversionRoute = worker.slice(conversionStart, conversionEnd)

    expect(conversionRoute).toContain("requiredText(body.timeZone, 'Employee time zone', 64)")
    expect(conversionRoute).toContain('invalid_employee_time_zone')
    expect(conversionRoute).toContain('target_time_zone: employeeTimeZone')
  })
})

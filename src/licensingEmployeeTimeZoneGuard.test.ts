import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')

describe('Licensing Center employee time-zone UI guard', () => {
  it('requires a blank-first explicit zone only when creating an employee', () => {
    expect(source).toContain("timeZone: employee ? undefined : value('timeZone') as ContinentalUsTimeZone")
    expect(source).toContain('{!employee ? (')
    expect(source).toMatch(/<select defaultValue="" name="timeZone" required>/)
    expect(source).toContain('<option disabled value="">Choose the employee&apos;s time zone</option>')
    expect(source).toContain('continentalUsTimeZones.map')
  })
})

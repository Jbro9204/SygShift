import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const page = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src', 'App.css'), 'utf8')

describe('Licensing Center compact worklist', () => {
  it('defaults to active employees but preserves an explicit separated-history filter', () => {
    expect(page).toContain("useState<'all' | LicensingEmployee['employmentStatus']>('active')")
    expect(page).toContain('<option value="separated">Separated</option>')
    expect(page).toContain("setEmploymentStatusFilter('active')")
  })

  it('uses legal names in the worklist and focused licensing profile', () => {
    expect(page).toContain('function legalEmployeeName(employee: LicensingEmployee)')
    expect(page).toContain('<strong>{legalEmployeeName(employee)}</strong>')
    expect(page).toContain('aria-label={`Licensing profile for ${legalEmployeeName(employee)}`}')
  })

  it('provides compact priority filters and progressive profile disclosure', () => {
    expect(page).toContain('className="licensing-priority-grid"')
    expect(page).toContain('More status details')
    expect(page).toContain("['credentials', 'Credentials']")
    expect(page).toContain("['renewals', 'Renewals']")
    expect(page).toContain("['activity', 'Documents & Activity']")
    expect(page).toContain('aria-expanded={isExpanded}')
    expect(page).toContain("setExpandedCredentialTypeId(isExpanded ? '' : credential.credentialTypeId)")
  })

  it('keeps guard licenses grouped while retaining separate credential records', () => {
    expect(page).toContain('Guard license package')
    expect(page).toContain('Standard Guard License')
    expect(page).toContain('Armed Guard License / Endorsement')
  })

  it('has dedicated responsive styles for the worklist and full-page profile', () => {
    expect(styles).toContain('.licensing-profile-page')
    expect(styles).toContain('.licensing-credential-accordion__trigger')
    expect(styles).toContain('.licensing-row--employee-summary')
    expect(styles).toContain('@media (max-width: 680px)')
  })
})

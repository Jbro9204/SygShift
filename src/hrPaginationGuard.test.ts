import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const hrPages = [
  'src/pages/HrisAutomationPage.tsx',
  'src/pages/HrisOnboardingPage.tsx',
  'src/pages/HrisPayrollIntegrationPage.tsx',
  'src/pages/HrisRecruitingPage.tsx',
  'src/pages/HrisStage7Page.tsx',
  'src/pages/HrisStage8Page.tsx',
  'src/pages/HrisStage9Page.tsx',
]

describe('HR pagination guard', () => {
  it('uses the shared HR pagination instead of generic full-size panels', () => {
    for (const path of hrPages) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).toContain('<HrPagination')
      expect(source, path).not.toContain('compact-pagination panel')
    }
  })

  it('removes empty first-page controls at the shared boundary', () => {
    const pagination = readFileSync('src/components/HrPagination.tsx', 'utf8')
    expect(pagination).toContain('if (itemCount === 0 && offset === 0) return null')
  })
})

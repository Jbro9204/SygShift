import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('system status presentation guard', () => {
  it('keeps technical readiness details out of Home and inside System Operations', () => {
    const overview = readFileSync('src/pages/OverviewPage.tsx', 'utf8')
    const operations = readFileSync('src/pages/SystemOperationsPage.tsx', 'utf8')
    const shell = readFileSync('src/components/AppShell.tsx', 'utf8')

    expect(overview).not.toContain('Secure data connection configured')
    expect(overview).not.toContain('exact source reconciliation safeguards')
    expect(operations).toContain('Service health')
    expect(operations).toContain('Data & authentication')
    expect(shell).toContain('SystemStatusIndicator')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const appShellSource = readFileSync(join(sourceRoot, 'components', 'AppShell.tsx'), 'utf8')
const navigationSource = readFileSync(join(sourceRoot, 'app', 'navigation.ts'), 'utf8')
const overviewSource = readFileSync(join(sourceRoot, 'pages', 'OverviewPage.tsx'), 'utf8')
const cssSource = readFileSync(join(sourceRoot, 'App.css'), 'utf8')

describe('Home redesign guardrails', () => {
  it('keeps ordinary announcements on Home and reserves the global strip for urgent items', () => {
    expect(appShellSource).toContain("filter((banner) => banner.tone === 'urgent')")
    expect(overviewSource).toContain("filter((item) => item.tone !== 'urgent')")
    expect(overviewSource).toContain('boundedHomeItems')
  })

  it('keeps Time-Off Requests in HR & Finance instead of Workforce', () => {
    const workforceIndex = navigationSource.indexOf("label: 'Workforce'")
    const financeIndex = navigationSource.indexOf("label: 'HR & Finance'")
    const requestIndex = navigationSource.indexOf("label: 'Time-Off Requests'")
    expect(requestIndex).toBeGreaterThan(financeIndex)
    expect(requestIndex).toBeGreaterThan(workforceIndex)
  })

  it('uses separate employee and operations Home compositions', () => {
    expect(overviewSource).toContain('home-page--${homeMode}')
    expect(overviewSource).toContain('<EmployeeHome')
    expect(overviewSource).toContain('<OperationsHome')
    expect(overviewSource).toContain('availableWorkspaces.filter')
  })

  it('filters operational content through effective route permissions while preserving personal controls', () => {
    expect(overviewSource).toContain('workspaceLinks.filter((item) => canAccessRoute(item.path, session))')
    expect(overviewSource).toContain('operationsMetrics.filter((item) => canAccessRoute(item.path, session))')
    expect(overviewSource).toContain('showPersonalLinks={operationsHome}')
    expect(overviewSource).toContain('to="/schedule"')
    expect(overviewSource).toContain('to="/requests"')
    expect(overviewSource).toContain('to="/time/my-time?report=call-off"')
  })

  it('keeps every clock state and canonical time action on Home', () => {
    expect(overviewSource).toContain("state === 'working'")
    expect(overviewSource).toContain("state === 'on_break'")
    expect(overviewSource).toContain("timeAction === 'break_start'")
    expect(overviewSource).toContain("timeAction === 'break_end'")
    expect(overviewSource).toContain("timeAction === 'clock_out'")
    expect(overviewSource).toContain("timeAction === 'clock_in'")
    expect(overviewSource).toContain('recordTimeEvent')
  })

  it('keeps the Home responsive down to the supported mobile width without text effects', () => {
    expect(cssSource).toContain('@media (max-width: 540px)')
    expect(cssSource).toContain('grid-template-columns: 1fr')
    expect(cssSource).toContain('overflow-wrap: anywhere')
    expect(cssSource).not.toMatch(/\.home-[^{]+\{[^}]*text-shadow:/s)
  })
})

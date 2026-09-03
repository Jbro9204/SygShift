/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const shell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const header = readFileSync(join(root, 'src', 'components', 'OperationalTimeHeader.tsx'), 'utf8')
const time = readFileSync(join(root, 'src', 'lib', 'time.ts'), 'utf8')
const css = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const themeCss = readFileSync(join(root, 'src', 'theme.css'), 'utf8')
const index = readFileSync(join(root, 'index.html'), 'utf8')
const themeBootstrap = readFileSync(join(root, 'public', 'theme-init.js'), 'utf8')

describe('global operational time header guardrails', () => {
  it('extends the single authenticated shell and preserves its account and alert systems', () => {
    expect(shell).toContain('<OperationalTimeHeader')
    expect(shell).toContain('serverTimestamp={maintenanceStatusQuery.data?.serverTime}')
    expect(shell).toContain('WorkspaceAlertStrip entries={workspaceAlerts}')
    expect(shell).toContain('WORKSPACE_ALERT_ROTATE_MS')
    expect(shell).toContain('Open My Account for')
    expect(shell).toContain('aria-label="Sign Out"')
    expect(shell).toContain('aria-label="Use light mode"')
    expect(shell).toContain('aria-label="Use dark mode"')
    expect(shell.match(/<OperationalTimeHeader/g)).toHaveLength(1)
  })

  it('uses one cleaned-up timer and explicit IANA zones in the required order', () => {
    const eastern = header.indexOf('America/New_York')
    const central = header.indexOf('America/Chicago')
    const mountain = header.indexOf('America/Denver')
    const pacific = header.indexOf('America/Los_Angeles')
    expect(eastern).toBeLessThan(central)
    expect(central).toBeLessThan(mountain)
    expect(mountain).toBeLessThan(pacific)
    expect(header.match(/window\.setInterval/g)).toHaveLength(1)
    expect(header).toContain('window.clearInterval(interval)')
    expect(header).toContain('United States operational time zones')
    expect(header).toContain('SygShift system time')
    expect(header).toContain('<CalendarDays')
    expect(header).not.toContain('aria-live')
    expect(header).not.toMatch(/\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/)
  })

  it('initializes the saved or operating-system theme before React paints', () => {
    expect(index).toContain('<script src="/theme-init.js"></script>')
    expect(themeBootstrap).toContain("prefers-color-scheme: dark")
    expect(themeBootstrap).toContain("document.documentElement.dataset.theme = theme")
    expect(themeCss).toContain("html[data-theme='dark']")
    expect(themeCss).toContain('.user-profile-control')
    expect(themeCss).toContain('.theme-switcher__button')
  })

  it('caches formatters and keeps compact clock formatting separate from operational records', () => {
    expect(time).toContain('timeZoneClockFormatterCache')
    expect(time).toContain('hour24 === 0 || hour24 >= 13')
    expect(time).toContain('formatCompactDualTime')
    expect(time).toContain('formatDualTime(')
  })

  it('keeps four compact clocks in the integrated top bar and places an inset alert below', () => {
    expect(header).toContain('<section aria-label="United States operational time zones"')
    expect(header.indexOf('className="topbar"')).toBeLessThan(header.indexOf('operational-time-zone-strip'))
    expect(css).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))')
    expect(css).toContain('grid-template-columns: 30px minmax(0, 1fr)')
    expect(css).toContain('overflow-x: auto')
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(css).toContain('overflow-x: visible')
    expect(css).toContain('.workspace-alert-strip {')
    expect(css).toContain('margin: 14px clamp(24px, 4vw, 54px) 0')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('.operational-clock__hand--second')
  })
})

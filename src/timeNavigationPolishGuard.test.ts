/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const appShell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const nestedTimePages = [
  'DailyAttendanceReviewPage.tsx',
  'TimeCommandCenterPage.tsx',
  'TimeExceptionsPage.tsx',
  'TimePayrollPage.tsx',
  'TimeTeamAttendancePage.tsx',
].map((fileName) => readFileSync(join(root, 'src', 'time', fileName), 'utf8'))

function cssBlock(selector: string): string {
  const start = appCss.indexOf(selector)
  if (start === -1) return ''
  const open = appCss.indexOf('{', start)
  const close = appCss.indexOf('}', open)
  return appCss.slice(open + 1, close)
}

describe('time navigation polish guardrails', () => {
  it('keeps Back on the same visual navigation system as Home', () => {
    expect(appShell).toContain('className="navigation-link navigation-link--button"')
    expect(appShell).toContain("'navigation-link navigation-link--active' : 'navigation-link'")

    const backButtonBlock = cssBlock('.navigation-link--button')
    expect(backButtonBlock).toContain('appearance: none')
    expect(backButtonBlock).toContain('background: transparent')
    expect(backButtonBlock).toContain('cursor: pointer')
    expect(backButtonBlock).toContain('font: inherit')
  })

  it('wraps action groups instead of wrapping button labels', () => {
    expect(cssBlock('.time-page-header__actions')).toContain('flex-wrap: wrap')
    expect(cssBlock('.time-button')).toContain('white-space: nowrap')
    expect(cssBlock('.time-button > span:not(.time-button__spinner)')).toContain('white-space: nowrap')
  })

  it('uses the shared Time workspace tabs instead of repeating command-center links', () => {
    nestedTimePages.forEach((pageSource) => {
      expect(pageSource).not.toContain('<span>Back to Time Command Center</span>')
      expect(pageSource).not.toContain('<span>Time Command Center</span>')
    })
  })

  it('keeps the desktop sidebar control visible, accessible, and separate from mobile navigation', () => {
    expect(appShell).toContain("aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}")
    expect(appShell).toContain("title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}")

    expect(appCss).toMatch(/\.sidebar-collapse\s*\{\s*position: absolute;[\s\S]*?width: 44px;[\s\S]*?height: 44px;/)
    expect(appCss).toMatch(/\.sidebar-collapse\s*\{[\s\S]*?right: -22px;/)

    const mobileRules = appCss.slice(appCss.indexOf('@media (max-width: 900px)'))
    expect(mobileRules).toMatch(/\.sidebar-collapse\s*\{\s*display: none;/)
  })
})

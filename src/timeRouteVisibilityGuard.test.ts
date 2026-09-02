import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const appShellSource = readFileSync(join(sourceRoot, 'components', 'AppShell.tsx'), 'utf8')
const overviewSource = readFileSync(join(sourceRoot, 'pages', 'OverviewPage.tsx'), 'utf8')
const timeWorkspaceSource = readFileSync(join(sourceRoot, 'time', 'TimeWorkspace.tsx'), 'utf8')
const commandCenterSource = readFileSync(join(sourceRoot, 'time', 'TimeCommandCenterPage.tsx'), 'utf8')
const teamAttendanceSource = readFileSync(join(sourceRoot, 'time', 'TimeTeamAttendancePage.tsx'), 'utf8')
const reviewNavigationSource = readFileSync(join(sourceRoot, 'time', 'TimeReviewQueueNavigation.tsx'), 'utf8')

describe('permission-aware route visibility guardrails', () => {
  it('uses the canonical route policy for primary and time-workspace navigation', () => {
    expect(appShellSource).toContain('return canAccessRoute(routePathFromHref(item.path), sessionContext)')
    expect(timeWorkspaceSource).toContain("canAccessRoute('/time/review', session)")
    expect(timeWorkspaceSource).toContain("canAccessRoute('/time/team', session)")
    expect(timeWorkspaceSource).toContain("canAccessRoute('/time/operations', session)")
  })

  it('hides review controls unless the exact review route is authorized', () => {
    expect(commandCenterSource).toContain("canAccessRoute('/time/review', sessionQuery.data)")
    expect(teamAttendanceSource).toContain("canAccessRoute('/time/review', sessionQuery.data)")
    expect(reviewNavigationSource).toContain('canAccessExceptions')
    expect(reviewNavigationSource).toContain('canAccessDailyReview')
  })

  it('does not request or expose operational alerts to users who cannot open them', () => {
    expect(appShellSource).toContain("canAccessRoute('/time/operations', sessionContext)")
    expect(appShellSource).toContain('enabled: isSupabaseConfigured && canViewOperationalAlerts')
    expect(appShellSource).toContain('canAccessRoute(routePathFromHref(directPath), sessionContext)')
  })

  it('filters announcement actions on both the shell and Home page through route access', () => {
    expect(appShellSource).toContain('canAccessRoute(routePathFromHref(banner.ctaHref), sessionContext)')
    expect(overviewSource).toContain('canAccessRoute(routePathFromHref(item.ctaHref), session)')
  })
})

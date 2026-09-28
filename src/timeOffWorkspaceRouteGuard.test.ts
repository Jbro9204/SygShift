/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'
import { navigationGroups } from './app/navigation'

const root = process.cwd()
const router = readFileSync(join(root, 'src', 'app', 'router.tsx'), 'utf8')
const overview = readFileSync(join(root, 'src', 'pages', 'OverviewPage.tsx'), 'utf8')
const myAccount = readFileSync(join(root, 'src', 'pages', 'MyAccountPage.tsx'), 'utf8')
const employeeFile = readFileSync(join(root, 'src', 'pages', 'HrisEmployeeFilePage.tsx'), 'utf8')
const accountability = readFileSync(join(root, 'src', 'time', 'AccountabilityPage.tsx'), 'utf8')
const requestsPage = readFileSync(join(root, 'src', 'pages', 'RequestsPage.tsx'), 'utf8')

describe('canonical Time Off workspace routes', () => {
  it('publishes one universal canonical navigation item under Workforce', () => {
    const workforce = navigationGroups.find((group) => group.label === 'Workforce')
    const timeOffItems = navigationGroups.flatMap((group) => group.items).filter((item) => item.path === '/time-off')

    expect(workforce?.items.some((item) => item.label === 'Time Off' && item.path === '/time-off')).toBe(true)
    expect(timeOffItems).toHaveLength(1)
    expect(navigationGroups.flatMap((group) => group.items).some((item) => item.path === '/requests')).toBe(false)
    expect(canAccessRoute('/time-off', { permissions: [] })).toBe(true)
  })

  it('keeps the legacy requests URL as an intentional universal compatibility alias', () => {
    expect(router).toMatch(/path: 'time-off'[\s\S]*?<RequestsPageRoute \/>/)
    expect(router).toMatch(/path: 'requests'[\s\S]*?<RequestsPageRoute \/>/)
    expect(canAccessRoute('/requests', { permissions: [] })).toBe(true)
  })

  it('uses canonical record-aware links from current product surfaces', () => {
    expect(overview).toContain('requestHistoryPath="/time-off?tab=time-off"')
    expect(overview).toContain("path: '/time-off?tab=time-off'")
    expect(overview).toContain("path: '/time-off?tab=shift-requests'")
    expect(overview).toContain("path: '/time-off?tab=call-offs'")
    expect(myAccount).toContain("path: '/time-off'")
    expect(employeeFile).toContain("path: '/time-off'")
    expect(accountability).toContain('to={`/time-off?tab=time-off&request=${event.id}`}')
    expect(requestsPage).toContain('requestHistoryPath="/time-off?tab=time-off"')
  })
})

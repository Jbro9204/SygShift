import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canAccessRoute } from './app/accessPolicy'
import { getOperationalReportDefinition } from './reports/reportDefinitions'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('Workforce Activity report route guardrails', () => {
  it('keeps the existing protected route key while presenting the dedicated day-based workspace', () => {
    const definition = getOperationalReportDefinition('scheduledVsActual')
    const reportsPage = read('src/pages/ReportsPage.tsx')

    expect(definition).toMatchObject({
      key: 'scheduledVsActual',
      title: 'Workforce Activity',
      shortTitle: 'Workforce Activity',
    })
    expect(definition?.description).toContain('who worked and where')
    expect(reportsPage).toContain("definition?.key === 'scheduledVsActual'")
    expect(reportsPage).toContain('<WorkforceActivityReportWorkspace')
  })

  it('requires report-view permission for the nested workforce route', () => {
    expect(canAccessRoute('/reports/scheduledVsActual', { permissions: ['time.reports.view'] })).toBe(true)
    expect(canAccessRoute('/reports/scheduledVsActual', { permissions: ['time.view'] })).toBe(false)
  })
})

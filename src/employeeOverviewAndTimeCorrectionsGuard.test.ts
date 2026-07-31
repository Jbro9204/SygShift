import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const overviewSource = readFileSync(join(sourceRoot, 'pages', 'OverviewPage.tsx'), 'utf8')
const myTimeSource = readFileSync(join(sourceRoot, 'time', 'MyTimePage.tsx'), 'utf8')
const cssSource = readFileSync(join(sourceRoot, 'App.css'), 'utf8')

describe('employee overview and time correction guardrails', () => {
  it('keeps employee landing personal instead of exposing operations totals', () => {
    expect(overviewSource).toContain('employeeLanding')
    expect(overviewSource).toContain('overview-employee-grid')
    expect(overviewSource).toContain("employeeLanding ? (")
    expect(overviewSource).toContain('Operational totals')
    expect(overviewSource.indexOf('overview-employee-grid')).toBeLessThan(overviewSource.indexOf('Operational totals'))
  })

  it('keeps break controls next to the quick clock action on Overview', () => {
    expect(overviewSource).toContain("label: 'Start break'")
    expect(overviewSource).toContain("label: 'End break'")
    expect(overviewSource).toContain('overview-time-actions')
    expect(overviewSource).toContain('overview-break-action')
  })

  it('lets employees submit protected correction requests from My Time', () => {
    expect(myTimeSource).toContain('requestTimeEventCorrection')
    expect(myTimeSource).toContain('Request correction')
    expect(myTimeSource).toContain('TimeCorrectionRequestModal')
    expect(myTimeSource).toContain('Original punch remains protected')
  })

  it('keeps the new controls under dedicated layout classes', () => {
    expect(cssSource).toContain('.overview-employee-grid')
    expect(cssSource).toContain('.overview-time-actions')
    expect(cssSource).toContain('.time-correction-request-form')
    expect(cssSource).toContain('.time-event__correction-button')
  })
})

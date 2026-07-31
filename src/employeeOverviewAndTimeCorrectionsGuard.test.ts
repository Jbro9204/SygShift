import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const navigationSource = readFileSync(join(sourceRoot, 'app', 'navigation.ts'), 'utf8')
const overviewSource = readFileSync(join(sourceRoot, 'pages', 'OverviewPage.tsx'), 'utf8')
const scheduleSource = readFileSync(join(sourceRoot, 'pages', 'SchedulePage.tsx'), 'utf8')
const eventsSource = readFileSync(join(sourceRoot, 'pages', 'EventsPage.tsx'), 'utf8')
const opportunitiesSource = readFileSync(join(sourceRoot, 'data', 'opportunities.ts'), 'utf8')
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

  it('keeps employee updates visible on the Overview landing without exposing operations totals', () => {
    expect(overviewSource).toContain('getActiveAnnouncementBanners')
    expect(overviewSource).toContain('overview-employee-card--updates')
    expect(overviewSource).toContain('Updates')
    expect(overviewSource.indexOf('overview-employee-card--updates')).toBeLessThan(
      overviewSource.indexOf('Operational totals'),
    )
  })

  it('keeps employee request and shift-pool routes reachable from the landing card', () => {
    expect(overviewSource).toContain('Time off and shift pool')
    expect(overviewSource).toContain('overview-employee-card__actions')
    expect(overviewSource).toContain('to="/requests"')
    expect(overviewSource).toContain('to="/events"')
    expect(navigationSource).toContain("{ label: 'Events & Openings', path: '/events', icon: CalendarClock, roles: ALL_EMPLOYEE_ROLES")
    expect(navigationSource).toContain("{ label: 'Time-Off Requests', path: '/requests', icon: ClipboardCheck, roles: ALL_EMPLOYEE_ROLES")
  })

  it('keeps employee schedule personal while team summaries stay behind operations access', () => {
    expect(scheduleSource).toContain('employeeOnlySchedule')
    expect(scheduleSource).toContain('EmployeePersonalSchedulePanel')
    expect(scheduleSource).toContain('scheduleQuery.data && canViewTeamSchedule')
    expect(scheduleSource).toContain("setRange={setEmployeeScheduleRange}")
    expect(scheduleSource).toContain("['1w', '2w', 'month']")
  })

  it('lets employees submit protected correction requests from My Time', () => {
    expect(myTimeSource).toContain('requestTimeEventCorrection')
    expect(myTimeSource).toContain('Request correction')
    expect(myTimeSource).toContain('TimeCorrectionRequestModal')
    expect(myTimeSource).toContain('Original punch remains protected')
  })

  it('keeps My Time focused on employee actions before raw punch history', () => {
    expect(myTimeSource).toContain('Report sick / call-off')
    expect(myTimeSource).toContain('ClockStatePill')
    expect(myTimeSource).toContain('groupRecentPunchesByDay')
    expect(myTimeSource).toContain('recent-punch-day-tabs')
    expect(myTimeSource.indexOf('<MyTimeRows')).toBeLessThan(
      myTimeSource.indexOf('<section className="my-time-two-column">'),
    )
  })

  it('shows real work details on openings instead of bare shift cards', () => {
    expect(eventsSource).toContain('opportunity-card__details')
    expect(opportunitiesSource).toContain('opportunityCoverageLabel')
    expect(opportunitiesSource).toContain('opportunityDescription')
    expect(opportunitiesSource).toContain('opportunityPayLabel')
  })

  it('keeps the new controls under dedicated layout classes', () => {
    expect(cssSource).toContain('.overview-employee-grid')
    expect(cssSource).toContain('.overview-employee-card--updates')
    expect(cssSource).toContain('.overview-employee-card__actions')
    expect(cssSource).toContain('.overview-time-actions')
    expect(cssSource).toContain('.employee-schedule-panel')
    expect(cssSource).toContain('.opportunity-card__details')
    expect(cssSource).toContain('.time-correction-request-form')
    expect(cssSource).toContain('.time-event__correction-button')
    expect(cssSource).toContain('.my-time-clock-state')
    expect(cssSource).toContain('.recent-punch-day-tabs')
  })
})

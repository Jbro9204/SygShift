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
const timeWorkspaceSource = readFileSync(join(sourceRoot, 'time', 'TimeWorkspace.tsx'), 'utf8')
const cssSource = readFileSync(join(sourceRoot, 'App.css'), 'utf8')

describe('employee overview and time correction guardrails', () => {
  it('keeps employee landing personal instead of exposing operations totals', () => {
    expect(overviewSource).toContain('homeModeForRole(session.role)')
    expect(overviewSource).toContain("homeMode === 'operations'")
    expect(overviewSource).toContain('<EmployeeHome')
    expect(overviewSource).toContain('<OperationsHome')
    expect(overviewSource).toContain('home-card-grid')
  })

  it('keeps break controls next to the quick clock action on Home', () => {
    expect(overviewSource).toContain("'break_start'")
    expect(overviewSource).toContain("'break_end'")
    expect(overviewSource).toContain('home-time-strip__actions')
    expect(overviewSource).toContain('Start break')
  })

  it('keeps employee updates visible on the Home landing without exposing operations totals', () => {
    expect(overviewSource).toContain('getActiveAnnouncementBanners')
    expect(overviewSource).toContain("filter((item) => item.tone !== 'urgent')")
    expect(overviewSource).toContain('home-card--announcements')
    expect(overviewSource).toContain('Announcements')
  })

  it('keeps employee request and shift-pool routes reachable from the landing card', () => {
    expect(overviewSource).toContain('Request Time Off')
    expect(overviewSource).toContain('Available opportunity')
    expect(overviewSource).toContain('to="/requests"')
    expect(overviewSource).toContain('to="/events"')
    expect(navigationSource).toContain("{ label: 'Events & Openings', path: '/events', icon: CalendarClock, permissions:")
    expect(navigationSource).toContain("label: 'HR & Finance'")
    expect(navigationSource).toContain("label: 'Time-Off Requests'")
  })

  it('keeps sick and call-off reporting prominent and opens the protected form directly', () => {
    expect(overviewSource).toContain('home-quick-actions')
    expect(overviewSource).toContain('Report sick / call-off')
    expect(overviewSource).toContain('to="/time/my-time?report=call-off"')
    expect(myTimeSource).toContain("searchParams.get('report') !== 'call-off'")
    expect(myTimeSource).toContain('setAttendanceReportOpen(true)')
    expect(myTimeSource).toContain('Dispatch is notified immediately')
  })

  it('keeps employee schedule personal while team summaries stay behind operations access', () => {
    expect(scheduleSource).toContain('employeeOnlySchedule')
    expect(scheduleSource).toContain('EmployeePersonalSchedulePanel')
    expect(scheduleSource).toContain('scheduleQuery.data && canViewTeamSchedule')
    expect(scheduleSource).toContain("setRange={setEmployeeScheduleRange}")
    expect(scheduleSource).toContain("['1w', '2w', 'month']")
    expect(scheduleSource).toContain('employeeScheduleDisplayStart')
    expect(scheduleSource).toContain('employeeScheduleCoverageWeekKeys')
    expect(scheduleSource).toContain('return startOfWeek(weekStart, { weekStartsOn: 0 })')
  })

  it('lets employees submit protected correction requests from My Time', () => {
    expect(myTimeSource).toContain('requestTimeEventCorrection')
    expect(myTimeSource).toContain('Request correction')
    expect(myTimeSource).toContain('TimeCorrectionRequestModal')
    expect(myTimeSource).toContain('Original punch remains protected')
  })

  it('keeps My Time focused on employee actions before raw punch history', () => {
    expect(myTimeSource).toContain('Report sick / call-off')
    expect(timeWorkspaceSource).toContain('aria-label="Current time clock"')
    expect(timeWorkspaceSource).toContain('recordTimeEvent')
    expect(myTimeSource).not.toContain('ClockStatusPanel')
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
    expect(cssSource).toContain('.home-greeting')
    expect(cssSource).toContain('.home-card-grid')
    expect(cssSource).toContain('.home-card--announcements')
    expect(cssSource).toContain('.home-workspace-grid')
    expect(cssSource).toContain('min-height: 44px')
    expect(cssSource).toContain('.home-time-strip__actions')
    expect(cssSource).toContain('.home-quick-actions')
    expect(cssSource).toContain('.employee-schedule-panel')
    expect(cssSource).toContain('grid-template-columns: repeat(7, minmax(132px, 1fr))')
    expect(cssSource).toContain('.opportunity-card__details')
    expect(cssSource).toContain('.time-correction-request-form')
    expect(cssSource).toContain('.time-event__correction-button')
    expect(cssSource).toContain('.my-time-clock-state')
    expect(cssSource).toContain('.recent-punch-day-tabs')
  })
})

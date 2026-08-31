import { describe, expect, it } from 'vitest'
import {
  CLOCK_IN_EARLY_WINDOW_MINUTES,
  activeTimeState,
  applyRecordedTimeEventToDashboard,
  dedupeTimeMaintenanceShiftOptions,
  getClockableShiftChoices,
  clockInWindowOpensAt,
  minutesUntilClockInOpens,
  nextUpcomingClockInShift,
  nextTimeEventKinds,
  parsePayrollExportBatch,
  parsePayrollExportDetail,
  parsePayrollExportHistory,
  parseTeamAttendanceSummary,
  parseTimeMaintenance,
  parseTimekeepingDashboard,
  parseTimekeepingEvent,
  parseTimekeepingReview,
  payrollHours,
  reviewRowsToPayrollSummaryCsv,
  reviewRowsToPayrollCsv,
  sortTimeMaintenanceEmployees,
  summarizePayrollRowsByEmployee,
  type TimeMaintenanceShiftOption,
  type TimekeepingShift,
} from './timekeeping'

describe('timekeeping validation', () => {
  it('accepts the protected dashboard contract', () => {
    const dashboard = parseTimekeepingDashboard({
      serverTimestamp: '2026-07-04T15:00:00.000Z',
      operationalDate: '2026-07-04',
      operationalTimeZone: 'America/Denver',
      employee: {
        id: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        displayName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
      },
      lastEvent: null,
      eligibleShifts: [],
      recentEvents: [],
      pendingCorrectionCount: 0,
    })

    expect(dashboard.employee.username).toBe('jbrown')
    expect(activeTimeState(dashboard.lastEvent)).toBe('off_clock')
  })

  it('maps the last punch to the correct employee state', () => {
    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000002',
      kind: 'clock_in',
      shiftId: null,
      recordedAt: '2026-07-04T15:00:00.000Z',
      source: 'web',
    }))).toBe('working')

    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000003',
      kind: 'break_start',
      shiftId: null,
      recordedAt: '2026-07-04T17:00:00.000Z',
      source: 'web',
    }))).toBe('on_break')

    expect(activeTimeState(parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000004',
      kind: 'clock_out',
      shiftId: null,
      recordedAt: '2026-07-04T23:00:00.000Z',
      source: 'web',
    }))).toBe('off_clock')
  })

  it('limits next actions to valid punch sequences', () => {
    expect(nextTimeEventKinds('off_clock')).toEqual(['clock_in'])
    expect(nextTimeEventKinds('working')).toEqual(['break_start', 'clock_out'])
    expect(nextTimeEventKinds('on_break')).toEqual(['break_end'])
  })

  it('keeps employee clock-in shift choices focused on the active punch window', () => {
    const baseShift: TimekeepingShift = {
      assignmentId: '73000000-0000-4000-8000-000000000101',
      shiftId: '73000000-0000-4000-8000-000000000201',
      status: 'assigned',
      startsAt: '2026-07-30T14:00:00.000Z',
      endsAt: '2026-07-30T22:00:00.000Z',
      timeZone: 'America/Denver',
      requiresArmed: false,
      isOvertime: false,
      postName: 'Unarmed coverage',
      siteName: 'Neon Local Apt-Unarmed',
      siteCode: 'NLA',
      eventName: null,
      locationName: 'Neon Local Apt-Unarmed',
      workType: 'post',
    }
    const choices = getClockableShiftChoices([
      baseShift,
      {
        ...baseShift,
        assignmentId: '73000000-0000-4000-8000-000000000102',
        shiftId: '73000000-0000-4000-8000-000000000202',
      },
      {
        ...baseShift,
        assignmentId: '73000000-0000-4000-8000-000000000103',
        shiftId: '73000000-0000-4000-8000-000000000203',
        startsAt: '2026-08-20T14:00:00.000Z',
        endsAt: '2026-08-20T22:00:00.000Z',
      },
    ], '2026-07-30T13:55:00.000Z')

    expect(choices.shifts).toHaveLength(1)
    expect(choices.shifts[0]?.shiftId).toBe(baseShift.shiftId)
    expect(choices.duplicateCount).toBe(1)
    expect(choices.outsideWindowCount).toBe(1)
    expect(choices.hiddenCount).toBe(2)
  })

  it('opens assigned shifts exactly five minutes before start and not earlier', () => {
    const shift: TimekeepingShift = {
      assignmentId: '73000000-0000-4000-8000-000000000111',
      shiftId: '73000000-0000-4000-8000-000000000211',
      status: 'assigned',
      startsAt: '2026-08-30T14:00:00.000Z',
      endsAt: '2026-08-30T22:00:00.000Z',
      timeZone: 'America/Denver',
      requiresArmed: false,
      isOvertime: false,
      postName: 'Unarmed coverage',
      siteName: 'Market',
      siteCode: 'MARKET',
      eventName: null,
      locationName: 'Market',
      workType: 'post',
    }

    expect(CLOCK_IN_EARLY_WINDOW_MINUTES).toBe(5)
    expect(clockInWindowOpensAt(shift)).toBe('2026-08-30T13:55:00.000Z')
    expect(minutesUntilClockInOpens(shift, '2026-08-30T13:14:01.000Z')).toBe(41)
    expect(minutesUntilClockInOpens(shift, '2026-08-30T13:55:00.000Z')).toBe(0)
    expect(getClockableShiftChoices([shift], '2026-08-30T13:54:59.000Z').shifts).toHaveLength(0)
    expect(nextUpcomingClockInShift([shift], '2026-08-30T13:54:59.000Z')?.shiftId).toBe(shift.shiftId)
    expect(getClockableShiftChoices([shift], '2026-08-30T13:55:00.000Z').shifts).toHaveLength(1)
    expect(getClockableShiftChoices([shift], '2026-08-30T22:00:01.000Z').shifts).toHaveLength(0)
  })

  it('keeps an overnight assignment clockable through its scheduled end', () => {
    const overnightShift: TimekeepingShift = {
      assignmentId: '73000000-0000-4000-8000-000000000112',
      shiftId: '73000000-0000-4000-8000-000000000212',
      status: 'assigned',
      startsAt: '2026-08-31T05:00:00.000Z',
      endsAt: '2026-08-31T13:00:00.000Z',
      timeZone: 'America/Denver',
      requiresArmed: true,
      isOvertime: false,
      postName: 'Armed coverage',
      siteName: 'PERA Denver',
      siteCode: 'PERA',
      eventName: null,
      locationName: 'PERA Denver',
      workType: 'post',
    }

    expect(getClockableShiftChoices([overnightShift], '2026-08-31T12:59:59.000Z').shifts).toHaveLength(1)
    expect(getClockableShiftChoices([overnightShift], '2026-08-31T13:00:01.000Z').shifts).toHaveLength(0)
  })

  it('deduplicates time maintenance location options while preserving distinct posts', () => {
    const baseOption: TimeMaintenanceShiftOption = {
      assignedEmployees: [],
      endsAt: '2026-07-31T00:00:00.000Z',
      eventId: null,
      eventName: null,
      headcountRequired: 1,
      isOvertime: false,
      locationName: 'Neon Local Apt-Unarmed',
      operationalDate: '2026-07-30',
      postId: '73000000-0000-4000-8000-000000000302',
      postName: 'Unarmed coverage',
      requiresArmed: false,
      scheduleRevision: 4,
      scheduleStatus: 'published',
      selectedEmployeeAssigned: false,
      shiftId: '73000000-0000-4000-8000-000000000202',
      siteCode: 'NLA',
      siteId: '73000000-0000-4000-8000-000000000301',
      siteName: 'Neon Local Apt-Unarmed',
      startsAt: '2026-07-30T16:00:00.000Z',
      timeZone: 'America/Denver',
      workType: 'post',
    }

    const deduped = dedupeTimeMaintenanceShiftOptions([
      baseOption,
      {
        ...baseOption,
        scheduleRevision: 3,
        shiftId: '73000000-0000-4000-8000-000000000203',
      },
      {
        ...baseOption,
        postId: '73000000-0000-4000-8000-000000000303',
        postName: 'Patrol',
        shiftId: '73000000-0000-4000-8000-000000000204',
      },
    ])

    expect(deduped).toHaveLength(2)
    expect(deduped.map((option) => option.shiftId)).toContain(baseOption.shiftId)
    expect(deduped.map((option) => option.postName)).toEqual(['Patrol', 'Unarmed coverage'])
  })

  it('applies a saved punch to visible dashboard state immediately', () => {
    const dashboard = parseTimekeepingDashboard({
      serverTimestamp: '2026-07-30T14:00:00.000Z',
      operationalDate: '2026-07-30',
      operationalTimeZone: 'America/Denver',
      employee: {
        id: '73000000-0000-4000-8000-000000000001',
        username: 'zward',
        displayName: 'Zach Ward',
        role: 'guard',
        employmentType: 'flex',
      },
      lastEvent: null,
      eligibleShifts: [],
      recentEvents: [{
        id: '73000000-0000-4000-8000-000000000002',
        kind: 'clock_out',
        shiftId: null,
        recordedAt: '2026-07-30T13:00:00.000Z',
        source: 'web',
      }],
      pendingCorrectionCount: 0,
    })
    const event = parseTimekeepingEvent({
      id: '73000000-0000-4000-8000-000000000003',
      kind: 'clock_in',
      shiftId: null,
      recordedAt: '2026-07-30T15:00:00.000Z',
      effectiveAt: '2026-07-30T15:00:00.000Z',
      source: 'web',
    })

    const updated = applyRecordedTimeEventToDashboard(dashboard, event)

    expect(updated.lastEvent).toEqual({ ...event, voided: false })
    expect(updated.recentEvents.map((recentEvent) => recentEvent.id)).toEqual([
      event.id,
      '73000000-0000-4000-8000-000000000002',
    ])
    expect(updated.serverTimestamp).toBe('2026-07-30T15:00:00.000Z')
  })

  it('validates concise team attendance summaries by employee', () => {
    const summary = parseTeamAttendanceSummary({
      serverTimestamp: '2026-07-30T15:00:00.000Z',
      fromDate: '2026-07-30',
      throughDate: '2026-07-30',
      operationalTimeZone: 'America/Denver',
      rows: [{
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'fgomez',
        employeeName: 'Fernando Gomez',
        role: 'guard',
        employmentType: 'hourly',
        latestKind: 'clock_in',
        latestEffectiveAt: '2026-07-30T13:30:00.000Z',
        latestLocationName: 'Cobalt',
        latestSiteName: 'Cobalt',
        latestSiteCode: 'COB',
        latestPostName: 'Executive Protection',
        latestEventName: null,
        latestTimeZone: 'America/Denver',
        firstClockIn: '2026-07-30T13:30:00.000Z',
        lastClockOut: null,
        eventCount: 1,
        scheduledShiftCount: 1,
        scheduledStartsAt: '2026-07-30T13:30:00.000Z',
        scheduledEndsAt: '2026-07-30T23:30:00.000Z',
        scheduledLocationName: 'Cobalt',
        scheduledSiteName: 'Cobalt',
        scheduledSiteCode: 'COB',
        scheduledPostName: 'Executive Protection',
        scheduledEventName: null,
        scheduledTimeZone: 'America/Denver',
      }],
    })

    expect(summary.rows).toHaveLength(1)
    expect(summary.rows[0]?.employeeName).toBe('Fernando Gomez')
    expect(summary.rows[0]?.scheduledShiftCount).toBe(1)
  })

  it('validates supervisor review rows and exports payroll CSV safely', () => {
    const review = parseTimekeepingReview({
      serverTimestamp: '2026-07-04T15:00:00.000Z',
      fromDate: '2026-06-28',
      throughDate: '2026-07-04',
      operationalTimeZone: 'America/Denver',
      payrollRules: {
        timeZone: 'America/Denver',
        weekStartsOn: 0,
        weekStartsOnLabel: 'Sunday',
        payFrequency: 'biweekly',
        payDateAnchor: '2026-07-17',
        dailyOvertimeMinutes: 720,
        weeklyOvertimeMinutes: 2400,
        unpaidBreaks: true,
        defaultBreakMinutes: 30,
        salaryWeeklyDefaultMinutes: 2400,
        salaryTimeOffReducesDefault: true,
      },
      summary: {
        rowCount: 1,
        readyCount: 1,
        exceptionCount: 0,
        pendingCorrectionCount: 0,
        grossMinutes: 510,
        paidMinutes: 480,
        regularMinutes: 420,
        overtimeMinutes: 60,
        salaryDefaultMinutes: 0,
        timeOffMinutes: 0,
      },
      rows: [{
        rowKind: 'time_event',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: '73000000-0000-4000-8000-000000000010',
        operationalDate: '2026-07-04',
        weekStartsOn: '2026-06-28',
        weekEndsOn: '2026-07-04',
        siteName: 'Main Site',
        siteCode: 'MAIN',
        postName: 'Primary Post',
        eventName: null,
        locationName: 'Main Site',
        scheduledStartsAt: '2026-07-04T14:00:00.000Z',
        scheduledEndsAt: '2026-07-04T22:00:00.000Z',
        timeZone: 'America/Denver',
        firstClockIn: '2026-07-04T13:58:00.000Z',
        lastClockOut: '2026-07-04T22:28:00.000Z',
        grossMinutes: 510,
        breakMinutes: 30,
        paidMinutes: 480,
        regularMinutes: 420,
        overtimeMinutes: 60,
        salaryDefaultMinutes: 0,
        timeOffMinutes: 0,
        eventCount: 4,
        requiresArmed: false,
        isOvertime: false,
        payrollReady: true,
        exceptionCodes: [],
        payrollNotes: ['Daily OT: over 12 paid hours in one day.'],
      }],
      pendingCorrections: [],
    })

    expect(payrollHours(review.summary.paidMinutes)).toBe('8.00')
    expect(payrollHours(review.summary.overtimeMinutes)).toBe('1.00')
    expect(reviewRowsToPayrollCsv(review.rows)).toContain('time_event,Jordan Brown,jbrown,07/04/2026')
    expect(reviewRowsToPayrollCsv(review.rows)).toContain('07/04/2026, 7:58 AM (07:58)')
  })

  it('groups payroll review rows into one employee summary row per person', () => {
    const review = parseTimekeepingReview({
      serverTimestamp: '2026-07-16T15:00:00.000Z',
      fromDate: '2026-07-12',
      throughDate: '2026-07-18',
      operationalTimeZone: 'America/Denver',
      summary: {
        rowCount: 3,
        readyCount: 2,
        exceptionCount: 1,
        pendingCorrectionCount: 0,
        grossMinutes: 810,
        paidMinutes: 780,
        regularMinutes: 720,
        overtimeMinutes: 60,
        salaryDefaultMinutes: 0,
        timeOffMinutes: 0,
      },
      rows: [
        {
          rowKind: 'time_event',
          employeeId: '73000000-0000-4000-8000-000000000001',
          username: 'jbrown',
          employeeName: 'Jordan Brown',
          role: 'admin',
          employmentType: 'salary',
          shiftId: '73000000-0000-4000-8000-000000000010',
          operationalDate: '2026-07-12',
          weekStartsOn: '2026-07-12',
          weekEndsOn: '2026-07-18',
          siteName: 'Main Site',
          siteCode: 'MAIN',
          postName: 'Primary Post',
          eventName: null,
          locationName: 'Main Site',
          scheduledStartsAt: '2026-07-12T14:00:00.000Z',
          scheduledEndsAt: '2026-07-12T22:00:00.000Z',
          timeZone: 'America/Denver',
          firstClockIn: '2026-07-12T13:58:00.000Z',
          lastClockOut: '2026-07-12T22:28:00.000Z',
          grossMinutes: 510,
          breakMinutes: 30,
          paidMinutes: 480,
          regularMinutes: 420,
          overtimeMinutes: 60,
          salaryDefaultMinutes: 0,
          timeOffMinutes: 0,
          eventCount: 4,
          requiresArmed: false,
          isOvertime: false,
          payrollReady: true,
          exceptionCodes: [],
          payrollNotes: [],
        },
        {
          rowKind: 'time_event',
          employeeId: '73000000-0000-4000-8000-000000000001',
          username: 'jbrown',
          employeeName: 'Jordan Brown',
          role: 'admin',
          employmentType: 'salary',
          shiftId: '73000000-0000-4000-8000-000000000011',
          operationalDate: '2026-07-13',
          weekStartsOn: '2026-07-12',
          weekEndsOn: '2026-07-18',
          siteName: 'Main Site',
          siteCode: 'MAIN',
          postName: 'Primary Post',
          eventName: null,
          locationName: 'Main Site',
          scheduledStartsAt: '2026-07-13T14:00:00.000Z',
          scheduledEndsAt: '2026-07-13T22:00:00.000Z',
          timeZone: 'America/Denver',
          firstClockIn: '2026-07-13T14:00:00.000Z',
          lastClockOut: null,
          grossMinutes: 0,
          breakMinutes: 0,
          paidMinutes: 0,
          regularMinutes: 0,
          overtimeMinutes: 0,
          salaryDefaultMinutes: 0,
          timeOffMinutes: 0,
          eventCount: 1,
          requiresArmed: false,
          isOvertime: false,
          payrollReady: false,
          exceptionCodes: ['missing_clock_out'],
          payrollNotes: ['Missing clock out.'],
        },
        {
          rowKind: 'time_event',
          employeeId: '73000000-0000-4000-8000-000000000002',
          username: 'scaughlan',
          employeeName: 'Sandy Caughlan',
          role: 'supervisor',
          employmentType: 'hourly',
          shiftId: '73000000-0000-4000-8000-000000000012',
          operationalDate: '2026-07-14',
          weekStartsOn: '2026-07-12',
          weekEndsOn: '2026-07-18',
          siteName: 'Market',
          siteCode: 'MKT',
          postName: 'Unarmed coverage',
          eventName: null,
          locationName: 'Market',
          scheduledStartsAt: '2026-07-14T14:00:00.000Z',
          scheduledEndsAt: '2026-07-14T19:00:00.000Z',
          timeZone: 'America/Denver',
          firstClockIn: '2026-07-14T14:00:00.000Z',
          lastClockOut: '2026-07-14T19:00:00.000Z',
          grossMinutes: 300,
          breakMinutes: 0,
          paidMinutes: 300,
          regularMinutes: 300,
          overtimeMinutes: 0,
          salaryDefaultMinutes: 0,
          timeOffMinutes: 0,
          eventCount: 2,
          requiresArmed: false,
          isOvertime: false,
          payrollReady: true,
          exceptionCodes: [],
          payrollNotes: [],
        },
      ],
      pendingCorrections: [],
    })

    const summaries = summarizePayrollRowsByEmployee(review.rows)

    expect(summaries).toHaveLength(2)
    expect(summaries[0]?.employeeName).toBe('Jordan Brown')
    expect(summaries[0]?.workedShiftCount).toBe(2)
    expect(summaries[0]?.paidMinutes).toBe(480)
    expect(summaries[0]?.payrollReady).toBe(false)
    expect(summaries[0]?.exceptionCount).toBe(1)
    expect(reviewRowsToPayrollSummaryCsv(review.rows)).toContain('Jordan Brown,jbrown,admin,salary,07/12/2026,07/13/2026,2,1,8.50,30,0.00,8.00,7.00,1.00,no,1,1')
    expect(reviewRowsToPayrollCsv(review.rows)).toContain('Jordan Brown,jbrown,07/12/2026')
    expect(reviewRowsToPayrollCsv(review.rows)).not.toContain('07/13/2026')
  })

  it('validates salary default payroll rows reduced by approved time off', () => {
    const review = parseTimekeepingReview({
      serverTimestamp: '2026-07-16T15:00:00.000Z',
      fromDate: '2026-07-12',
      throughDate: '2026-07-18',
      operationalTimeZone: 'America/Denver',
      summary: {
        rowCount: 1,
        readyCount: 1,
        exceptionCount: 0,
        pendingCorrectionCount: 0,
        grossMinutes: 1920,
        paidMinutes: 1920,
        regularMinutes: 1920,
        overtimeMinutes: 0,
        salaryDefaultMinutes: 2400,
        timeOffMinutes: 480,
      },
      rows: [{
        rowKind: 'salary_default',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: null,
        operationalDate: '2026-07-12',
        weekStartsOn: '2026-07-12',
        weekEndsOn: '2026-07-18',
        siteName: null,
        siteCode: null,
        postName: null,
        eventName: null,
        locationName: 'Salary default',
        scheduledStartsAt: null,
        scheduledEndsAt: null,
        timeZone: 'America/Denver',
        firstClockIn: null,
        lastClockOut: null,
        grossMinutes: 1920,
        breakMinutes: 0,
        paidMinutes: 1920,
        regularMinutes: 1920,
        overtimeMinutes: 0,
        salaryDefaultMinutes: 2400,
        timeOffMinutes: 480,
        eventCount: 0,
        requiresArmed: false,
        isOvertime: false,
        payrollReady: true,
        exceptionCodes: [],
        payrollNotes: ['Approved time off reduced the salary default by 8.00 hours.'],
      }],
      pendingCorrections: [],
    })

    expect(review.rows[0]?.rowKind).toBe('salary_default')
    expect(reviewRowsToPayrollCsv(review.rows)).not.toContain('salary_default,Jordan Brown,jbrown,07/12/2026')
    expect(reviewRowsToPayrollCsv(review.rows)).not.toContain('Salary Default Hours')
  })

  it('validates locked payroll export batch records', () => {
    const batch = parsePayrollExportBatch({
      id: '73000000-0000-4000-8000-000000000020',
      fromDate: '2026-06-28',
      throughDate: '2026-07-04',
      createdAt: '2026-07-04T23:30:00.000Z',
      createdBy: '73000000-0000-4000-8000-000000000001',
      createdByName: 'Jordan Brown',
      rowCount: 14,
      grossMinutes: 7140,
      paidMinutes: 6720,
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      note: 'Reviewed and ready for payroll.',
      duplicate: false,
    })

    expect(batch.rowCount).toBe(14)
    expect(parsePayrollExportHistory([batch])).toHaveLength(1)
    expect(parsePayrollExportDetail({ batch, rows: [] }).batch.digest).toBe(batch.digest)
  })

  it('validates operations time maintenance events', () => {
    const maintenance = parseTimeMaintenance({
      serverTimestamp: '2026-07-16T15:00:00.000Z',
      fromDate: '2026-07-10',
      throughDate: '2026-07-16',
      operationalTimeZone: 'America/Denver',
      employees: [{
        id: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        displayName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        status: 'active',
      }],
      events: [{
        id: '73000000-0000-4000-8000-000000000030',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: null,
        occurrenceKey: 'unscheduled-session:73000000-0000-4000-8000-000000000030:employee:73000000-0000-4000-8000-000000000001',
        assignmentAnchor: '2026-07-16T14:00:00.000Z',
        operationalDate: '2026-07-16',
        kind: 'clock_out',
        recordedAt: '2026-07-16T22:00:00.000Z',
        effectiveAt: '2026-07-16T22:00:00.000Z',
        clientRecordedAt: null,
        source: 'supervisor',
        createdBy: '73000000-0000-4000-8000-000000000001',
        createdByName: 'Jordan Brown',
        voided: false,
        pendingCorrectionCount: 0,
        maintenanceNoteCount: 1,
        latestNote: 'Forgotten clock-out verified by supervisor.',
        latestAction: 'manual_add',
        siteName: null,
        siteCode: null,
        postName: null,
        eventName: null,
        locationName: 'Unscheduled',
        timeZone: 'America/Denver',
      }],
    })

    expect(maintenance.events[0]?.source).toBe('supervisor')
    expect(maintenance.events[0]?.latestAction).toBe('manual_add')
  })

  it('keeps Time Maintenance readable when the database adds an operational action', () => {
    const maintenance = parseTimeMaintenance({
      serverTimestamp: '2026-08-19T15:00:00.000Z',
      fromDate: '2026-08-09',
      throughDate: '2026-08-15',
      operationalTimeZone: 'America/Denver',
      employees: [],
      events: [{
        id: '73000000-0000-4000-8000-000000000031',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'jbrown',
        employeeName: 'Jordan Brown',
        role: 'admin',
        employmentType: 'salary',
        shiftId: null,
        occurrenceKey: 'unscheduled-session:73000000-0000-4000-8000-000000000031:employee:73000000-0000-4000-8000-000000000001',
        assignmentAnchor: '2026-08-19T14:00:00.000Z',
        operationalDate: '2026-08-19',
        kind: 'clock_out',
        recordedAt: '2026-08-19T22:00:00.000Z',
        effectiveAt: '2026-08-19T22:00:00.000Z',
        clientRecordedAt: null,
        source: 'system',
        createdBy: null,
        createdByName: null,
        voided: false,
        pendingCorrectionCount: 0,
        maintenanceNoteCount: 1,
        latestNote: 'Automatically closed at the scheduled end.',
        latestAction: 'automatic_clock_out',
        siteName: 'Administrative',
        siteCode: 'ADMIN',
        postName: 'Office',
        eventName: null,
        locationName: 'Administrative',
        timeZone: 'America/Denver',
      }],
    })

    expect(maintenance.events[0]?.latestAction).toBe('automatic_clock_out')
  })

  it('keeps an overnight clock-out assigned to the workday where the occurrence started', () => {
    const maintenance = parseTimeMaintenance({
      serverTimestamp: '2026-08-16T14:00:00.000Z',
      fromDate: '2026-08-15',
      throughDate: '2026-08-15',
      operationalTimeZone: 'America/Denver',
      employees: [],
      events: [{
        id: '73000000-0000-4000-8000-000000000032',
        employeeId: '73000000-0000-4000-8000-000000000001',
        username: 'djones',
        employeeName: 'Daron Jones',
        role: 'guard',
        employmentType: 'hourly',
        shiftId: null,
        occurrenceKey: 'unscheduled-session:73000000-0000-4000-8000-000000000033:employee:73000000-0000-4000-8000-000000000001',
        assignmentAnchor: '2026-08-16T05:00:00.000Z',
        operationalDate: '2026-08-15',
        kind: 'clock_out',
        recordedAt: '2026-08-16T13:00:00.000Z',
        effectiveAt: '2026-08-16T13:00:00.000Z',
        clientRecordedAt: null,
        source: 'supervisor',
        createdBy: null,
        createdByName: null,
        voided: false,
        pendingCorrectionCount: 0,
        maintenanceNoteCount: 0,
        latestNote: null,
        latestAction: null,
        siteName: 'PERA',
        siteCode: 'PERA',
        postName: 'Armed coverage',
        eventName: null,
        locationName: 'PERA-Denver - Armed',
        timeZone: 'America/Denver',
      }],
    })

    expect(maintenance.events[0]?.operationalDate).toBe('2026-08-15')
    expect(maintenance.events[0]?.effectiveAt).toBe('2026-08-16T13:00:00.000Z')
  })

  it('orders Time Maintenance employees by preferred or first display name', () => {
    const employees = sortTimeMaintenanceEmployees([
      { id: '73000000-0000-4000-8000-000000000003', username: 'zlee', displayName: 'Zara Lee', role: 'guard', employmentType: 'hourly', status: 'active' },
      { id: '73000000-0000-4000-8000-000000000002', username: 'ahall', displayName: 'Aaron Hall', role: 'guard', employmentType: 'hourly', status: 'active' },
    ])

    expect(employees.map((employee) => employee.displayName)).toEqual(['Aaron Hall', 'Zara Lee'])
  })
})

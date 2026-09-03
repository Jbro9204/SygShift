import type { ScheduledOvertimeForecast } from '../data/scheduledOvertimeForecast'
import { downloadXlsxWorkbook, type XlsxSheet } from '../lib/xlsxWorkbook'

function hours(minutes: number): number {
  return Number((minutes / 60).toFixed(2))
}

function generatedAtText(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Denver',
  }).format(new Date(value))
}

function localShiftTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

export function buildScheduledOvertimeForecastWorkbookSheets(
  forecast: ScheduledOvertimeForecast,
  generatedAt: string,
): XlsxSheet[] {
  const source = forecast.schedule
    ? `${forecast.schedule.status.replaceAll('_', ' ')} schedule · Revision ${forecast.schedule.revision}`
    : 'No schedule revision available'
  const summaryRows = [
    ['SygShift Scheduled Overtime Forecast'],
    ['Week', `${forecast.weekStartsOn} through ${forecast.weekEndsOn}`],
    ['Generated', generatedAtText(generatedAt)],
    ['Schedule source', source],
    ['Projected overtime employees', forecast.summary.overtimeEmployees],
    ['Armed overtime employees', forecast.summary.armedOvertimeEmployees],
    ['Total projected overtime hours', hours(forecast.summary.totalOvertimeMinutes)],
    ['Calculation', 'Assigned standard shifts above 40.00 hours. Supplemental Dispatch phone duty is excluded.'],
    [],
    ['Employee', 'Employee ID', 'Employment', 'Job title', 'Scheduled hours', 'Projected OT hours', 'Armed hours', 'Unarmed hours', 'Shifts', 'Sites / Posts', 'Overtime approval notes'],
    ...forecast.employees.map((employee) => [
      employee.employeeName,
      employee.employeeNumber ?? 'Not recorded',
      [employee.employmentType, employee.workClassification].filter(Boolean).join(' · '),
      employee.jobTitle ?? 'Not recorded',
      hours(employee.scheduledMinutes),
      hours(employee.overtimeMinutes),
      hours(employee.armedMinutes),
      hours(employee.unarmedMinutes),
      employee.shiftCount,
      employee.sites,
      employee.approvalNotes ?? 'No approval note recorded',
    ]),
  ]

  const shiftRows = forecast.employees.flatMap((employee) => employee.shifts.map((shift) => [
    employee.employeeName,
    employee.employeeNumber ?? 'Not recorded',
    shift.date,
    localShiftTime(shift.startsAt, shift.timeZone),
    localShiftTime(shift.endsAt, shift.timeZone),
    shift.timeZone,
    shift.requiresArmed ? 'Armed' : 'Unarmed',
    shift.sitePost,
    hours(shift.scheduledMinutes),
    shift.approvalNote ?? 'None',
  ]))

  const candidateRows = forecast.armedFlexCandidates.map((candidate) => [
    candidate.employeeName,
    candidate.employeeNumber ?? 'Not recorded',
    candidate.jobTitle ?? 'Not recorded',
    hours(candidate.scheduledMinutes),
    hours(candidate.remainingMinutesBeforeOvertime),
    candidate.credentialValidThrough,
    'Management must verify availability and assignment suitability before scheduling.',
  ])

  return [
    {
      centerColumns: [1, 4, 5, 6, 7, 8],
      columnWidths: [26, 15, 20, 24, 18, 20, 16, 17, 12, 38, 38],
      filterRowIndex: 9,
      freezeRows: 10,
      headerRows: [9],
      integerColumns: [8],
      metadataRows: [1, 2, 3, 4, 5, 6, 7],
      mergedCells: ['A1:K1'],
      name: 'Overtime Forecast',
      rows: summaryRows,
      titleRows: [0],
      wrapColumns: [2, 3, 9, 10],
    },
    {
      centerColumns: [1, 2, 5, 6, 8],
      columnWidths: [26, 15, 14, 24, 24, 25, 13, 38, 18, 38],
      filterRowIndex: 4,
      freezeRows: 5,
      headerRows: [4],
      metadataRows: [1, 2],
      mergedCells: ['A1:J1'],
      name: 'Shift Detail',
      rows: [
        ['SygShift Scheduled Overtime — Shift Detail'],
        ['Week', `${forecast.weekStartsOn} through ${forecast.weekEndsOn}`],
        ['Generated', generatedAtText(generatedAt)],
        [],
        ['Employee', 'Employee ID', 'Work date', 'Starts', 'Ends', 'Time zone', 'Coverage', 'Site / Post', 'Scheduled hours', 'Approval note'],
        ...shiftRows,
      ],
      titleRows: [0],
      wrapColumns: [3, 4, 5, 7, 9],
    },
    {
      centerColumns: [1, 3, 4, 5],
      columnWidths: [26, 15, 24, 20, 28, 22, 54],
      filterRowIndex: 5,
      freezeRows: 6,
      headerRows: [5],
      metadataRows: [1, 2, 3],
      mergedCells: ['A1:G1'],
      name: 'Armed Flex Capacity',
      rows: [
        ['SygShift Armed Flex Capacity Candidates'],
        ['Week', `${forecast.weekStartsOn} through ${forecast.weekEndsOn}`],
        ['Generated', generatedAtText(generatedAt)],
        ['Important', 'This is a credential-and-capacity planning aid, not an availability confirmation.'],
        [],
        ['Employee', 'Employee ID', 'Job title', 'Scheduled hours', 'Hours before overtime', 'Armed credential checked through', 'Management review'],
        ...candidateRows,
      ],
      titleRows: [0],
      wrapColumns: [2, 6],
    },
  ]
}

export function scheduledOvertimeForecastFileName(weekStartsOn: string): string {
  return `sygshift-scheduled-overtime-${weekStartsOn}.xlsx`
}

export function downloadScheduledOvertimeForecastWorkbook(
  forecast: ScheduledOvertimeForecast,
  generatedAt: string,
): { fileName: string; size: number } {
  const fileName = scheduledOvertimeForecastFileName(forecast.weekStartsOn)
  return downloadXlsxWorkbook(buildScheduledOvertimeForecastWorkbookSheets(forecast, generatedAt), fileName)
}

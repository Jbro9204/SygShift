import { describe, expect, it } from 'vitest'
import {
  assignmentName,
  compareScheduleBuilderEmployeesByFirstName,
  importedScheduleRows,
  scheduleRows,
  shiftOperationalDate,
  type ImportedSchedulePreview,
  type ScheduleBuilderEmployee,
  type ScheduleShift,
  type WeeklySchedule,
} from './schedule'

const siteShift: ScheduleShift = {
  id: '10000000-0000-0000-0000-000000000001',
  starts_at: '2026-07-06T05:30:00.000Z',
  ends_at: '2026-07-06T13:30:00.000Z',
  time_zone: 'America/Denver',
  headcount_required: 1,
  requires_armed: true,
  is_open: false,
  is_overtime: false,
  notes: null,
  post: {
    id: '20000000-0000-0000-0000-000000000001',
    name: 'Main entrance',
    site: {
      id: '30000000-0000-0000-0000-000000000001',
      code: 'NORTH',
      name: 'North Campus',
    },
  },
  event: null,
  assignments: [{
    id: '40000000-0000-0000-0000-000000000001',
    status: 'confirmed',
    employee: {
      id: '50000000-0000-0000-0000-000000000001',
      first_name: 'Alexandra',
      last_name: 'Rivera',
      preferred_name: 'Alex',
      employee_number: 'SYG-1001',
    },
  }],
}

const eventShift: ScheduleShift = {
  ...siteShift,
  id: '10000000-0000-0000-0000-000000000002',
  starts_at: '2026-07-07T16:00:00.000Z',
  ends_at: '2026-07-08T00:00:00.000Z',
  requires_armed: false,
  post: null,
  event: {
    id: '60000000-0000-0000-0000-000000000001',
    name: 'Community event',
    location_name: 'Civic Center',
    site: null,
  },
  assignments: [],
}

const schedule: WeeklySchedule = {
  id: '70000000-0000-0000-0000-000000000001',
  week_starts_on: '2026-07-05',
  revision: 1,
  status: 'published',
  published_at: '2026-07-03T12:00:00.000Z',
  shifts: [siteShift, eventShift],
}

describe('schedule presentation', () => {
  it('sorts scheduling employees by preferred or first name, then last name', () => {
    const employees: ScheduleBuilderEmployee[] = [
      {
        id: '00000000-0000-4000-8000-000000000003',
        first_name: 'Michael',
        last_name: 'Hinz',
        preferred_name: null,
        employee_number: 'SYG-1002',
        role: 'scheduler',
        employment_type: 'hourly',
        has_armed_guard_credential: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000001',
        first_name: 'Zachary',
        last_name: 'Ward',
        preferred_name: 'Zach',
        employee_number: 'SYG-1003',
        role: 'recruiting_licensing',
        employment_type: 'hourly',
        has_armed_guard_credential: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        first_name: 'Jordan',
        last_name: 'Brown',
        preferred_name: null,
        employee_number: 'SYG-1004',
        role: 'admin',
        employment_type: 'salary',
        has_armed_guard_credential: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        first_name: 'Jordan',
        last_name: 'Adams',
        preferred_name: null,
        employee_number: 'SYG-1005',
        role: 'guard',
        employment_type: 'flex',
        has_armed_guard_credential: true,
      },
    ]

    expect([...employees].sort(compareScheduleBuilderEmployeesByFirstName).map((employee) => (
      `${employee.preferred_name || employee.first_name} ${employee.last_name}`
    ))).toEqual([
      'Jordan Adams',
      'Jordan Brown',
      'Michael Hinz',
      'Zach Ward',
    ])
  })

  it('groups site and standalone event coverage without losing shifts', () => {
    const rows = scheduleRows(schedule)

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.name)).toEqual(['Civic Center', 'North Campus'])
    expect(rows.flatMap((row) => row.shifts)).toHaveLength(2)
  })

  it('uses each shift time zone to determine its operational day', () => {
    expect(shiftOperationalDate(siteShift)).toBe('2026-07-05')
  })

  it('uses a preferred name when one is recorded', () => {
    expect(assignmentName(siteShift.assignments[0])).toBe('Alex Rivera')
  })

  it('expands a one-letter preferred name in live schedule assignments', () => {
    expect(assignmentName({
      ...siteShift.assignments[0],
      employee: {
        ...siteShift.assignments[0].employee,
        first_name: 'Jainique',
        last_name: 'Lee',
        preferred_name: 'J',
      },
    })).toBe('Jainique (J) Lee')
  })

  it('groups imported source shifts by workbook context label', () => {
    const sourceSchedule: ImportedSchedulePreview = {
      importRunId: '80000000-0000-4000-8000-000000000001',
      weekStartsOn: '2026-06-28',
      weekEndsOn: '2026-07-04',
      sourceSheetName: 'June 28th to July 4th',
      sourceSheetIndex: 145,
      blockingIssueCount: 0,
      warningIssueCount: 0,
      shifts: [{
        id: '90000000-0000-4000-8000-000000000001',
        candidateKey: 'cell:145:C12',
        reviewStatus: 'pending',
        localDate: '2026-06-28',
        startTime: '08:00',
        endTime: '16:00',
        crossesMidnight: false,
        contextLabel: '4400 Syracuse Apt-Unarmed',
        siteKeyCandidate: '4400-syracuse-apt',
        assigneeLabel: 'Jordan Brown',
        openCandidate: false,
        qualificationCandidate: 'unarmed',
        confidence: 'review',
        sourceTimeAddress: 'C12',
        sourceAssignmentAddress: 'C13',
      }],
    }

    expect(importedScheduleRows(sourceSchedule)).toEqual([{
      id: '4400-syracuse-apt',
      name: '4400 Syracuse Apt-Unarmed',
      qualification: 'unarmed',
      shifts: sourceSchedule.shifts,
    }])
  })
})

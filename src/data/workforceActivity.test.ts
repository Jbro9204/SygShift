import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkforceActivityRow } from '../reports/workforceActivityTypes'
import {
  exportWorkforceActivityReport,
  getWorkforceActivityReportEmployeeOptions,
  getWorkforceActivityReportPage,
} from './workforceActivity'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

const employeeId = '10000000-0000-4000-8000-000000000001'
const eventId = '20000000-0000-4000-8000-000000000001'

function workforceRow(overrides: Partial<WorkforceActivityRow> = {}): WorkforceActivityRow {
  return {
    id: 'assignment:30000000-0000-4000-8000-000000000001',
    operationalDate: '2026-09-28',
    employeeId,
    employeeName: 'Alex Morgan',
    employeeNumber: 'SYG-1001',
    employmentType: 'hourly',
    shiftId: '40000000-0000-4000-8000-000000000001',
    assignmentId: '30000000-0000-4000-8000-000000000001',
    clientId: '50000000-0000-4000-8000-000000000001',
    clientName: 'Crow Events',
    eventId,
    eventName: 'Jason Crow Event',
    siteId: '60000000-0000-4000-8000-000000000001',
    siteCode: 'JC-01',
    siteName: 'Convention Hall',
    postId: '70000000-0000-4000-8000-000000000001',
    postName: 'Main Entrance',
    locationLabel: 'Jason Crow Event',
    locationDetail: 'Convention Hall · Main Entrance',
    timeZone: 'America/Denver',
    scheduledStartAt: '2026-09-28T15:00:00Z',
    scheduledEndAt: '2026-09-28T23:00:00Z',
    scheduledMinutes: 480,
    actualStartAt: '2026-09-28T15:03:00Z',
    actualEndAt: '2026-09-28T23:01:00Z',
    workedMinutes: 478,
    unpaidBreakMinutes: 30,
    outcome: 'worked_as_scheduled',
    payrollReady: true,
    notes: [],
    ...overrides,
  }
}

function reportPayload(rows = [workforceRow()]) {
  return {
    reportKey: 'workforceActivity',
    generatedAt: '2026-09-29T14:30:00Z',
    fromDate: '2026-09-28',
    throughDate: '2026-09-28',
    view: 'worked',
    groupBy: 'location',
    page: 1,
    pageSize: 25,
    totalCount: rows.length,
    totalPages: rows.length ? 1 : 0,
    summary: {
      scheduledAssignments: rows.length,
      actualWorkers: rows.length,
      scheduledMinutes: 480,
      workedMinutes: 478,
      callOffs: 0,
      replacements: 0,
      openPositions: 0,
      salaryConfirmed: 0,
      needsReview: 0,
    },
    filterOptions: {
      views: [{ value: 'worked', label: 'Worked' }],
      groupings: [{ value: 'location', label: 'Location' }],
      employees: [{ id: employeeId, label: 'Alex Morgan', employeeNumber: 'SYG-1001' }],
      clients: [{ id: '50000000-0000-4000-8000-000000000001', label: 'Crow Events' }],
      sites: [{ id: '60000000-0000-4000-8000-000000000001', label: 'Convention Hall' }],
      events: [{ id: eventId, label: 'Jason Crow Event' }],
      outcomes: [{ value: 'worked_as_scheduled', label: 'Worked as scheduled', count: rows.length }],
    },
    rows,
  }
}

describe('workforce activity data boundary', () => {
  beforeEach(() => rpc.mockReset())

  it('sends every page filter through the explicit RPC contract', async () => {
    rpc.mockResolvedValue({ data: reportPayload(), error: null })

    await getWorkforceActivityReportPage({
      fromDate: '2026-09-28',
      throughDate: '2026-09-28',
      view: 'exceptions',
      groupBy: 'employee',
      employeeId,
      eventId,
      outcome: 'needs_time_correction',
      search: '  Alex  ',
      page: 2,
      pageSize: 25,
    })

    expect(rpc).toHaveBeenCalledWith('get_workforce_activity_report_page', {
      target_from_date: '2026-09-28',
      target_through_date: '2026-09-28',
      target_view: 'exceptions',
      target_group_by: 'employee',
      target_employee_id: employeeId,
      target_client_id: null,
      target_site_id: null,
      target_event_id: eventId,
      target_outcome: 'needs_time_correction',
      target_search: 'Alex',
      target_page: 2,
      target_page_size: 25,
    })
  })

  it('loads the protected employee picker independently of the current report rows', async () => {
    const zeroWorkEmployeeId = '10000000-0000-4000-8000-000000000002'
    rpc.mockResolvedValue({
      data: [
        { id: employeeId, label: 'Alex Morgan', employeeNumber: 'SYG-1001' },
        { id: zeroWorkEmployeeId, label: 'Bailey Scheduled Only', employeeNumber: 'SYG-1002' },
      ],
      error: null,
    })

    await expect(getWorkforceActivityReportEmployeeOptions()).resolves.toEqual([
      { id: employeeId, label: 'Alex Morgan', employeeNumber: 'SYG-1001' },
      { id: zeroWorkEmployeeId, label: 'Bailey Scheduled Only', employeeNumber: 'SYG-1002' },
    ])
    expect(rpc).toHaveBeenCalledWith('get_workforce_activity_report_employee_options')
  })

  it('uses the audited export RPC and accepts its complete unpaged result', async () => {
    const rows = Array.from({ length: 75 }, (_, index) => workforceRow({ id: `row:${index}` }))
    rpc.mockResolvedValue({
      data: { ...reportPayload(rows), exportId: '80000000-0000-4000-8000-000000000001', mode: 'export', pageSize: rows.length },
      error: null,
    })

    const result = await exportWorkforceActivityReport({
      fromDate: '2026-09-28',
      throughDate: '2026-09-28',
      view: 'worked',
      groupBy: 'location',
      eventId,
    })

    expect(rpc).toHaveBeenCalledWith('export_workforce_activity_report', {
      target_from_date: '2026-09-28',
      target_through_date: '2026-09-28',
      target_view: 'worked',
      target_group_by: 'location',
      target_employee_id: null,
      target_client_id: null,
      target_site_id: null,
      target_event_id: eventId,
      target_outcome: null,
      target_search: null,
    })
    expect(result.rows).toHaveLength(75)
    expect(result.mode).toBe('export')
  })

  it('rejects unexpected outcomes instead of leaking a loose record into the UI', async () => {
    const malformed = reportPayload()
    malformed.rows[0] = { ...malformed.rows[0], outcome: 'mystery_status' } as never
    rpc.mockResolvedValue({ data: malformed, error: null })

    await expect(getWorkforceActivityReportPage({
      fromDate: '2026-09-28',
      throughDate: '2026-09-28',
      view: 'worked',
      groupBy: 'location',
      page: 1,
      pageSize: 25,
    })).rejects.toThrow()
  })

  it('rejects malformed employee options instead of treating an invalid roster as no choices', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'not-a-uuid', employeeNumber: 'SYG-1001' }], error: null })

    await expect(getWorkforceActivityReportEmployeeOptions()).rejects.toThrow()
  })

  it('surfaces the server error without attempting to parse an absent payload', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Report permission is required.' } })
    await expect(getWorkforceActivityReportPage({
      fromDate: '2026-09-28', throughDate: '2026-09-28', view: 'worked', groupBy: 'location', page: 1, pageSize: 25,
    })).rejects.toThrow('Report permission is required.')
  })

  it('surfaces employee-picker authorization errors instead of silently emptying the selector', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Report permission is required.' } })

    await expect(getWorkforceActivityReportEmployeeOptions()).rejects.toThrow('Report permission is required.')
  })
})

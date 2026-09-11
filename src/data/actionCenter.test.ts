import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeEmployeeAction,
  getEmployeeActionCenter,
  getEmployeeActionHistory,
  getRequiredActionCheckpoint,
  getRequiredActionCheckpointReport,
  publishTrainingVersion,
  trainingComplianceCsv,
} from './actionCenter'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

const actionCenter = {
  announcements: [{
    acknowledgedAt: null,
    announcementId: '10000000-0000-4000-8000-000000000002',
    assignedAt: '2026-08-10T12:00:00Z',
    body: 'Review the new operating instructions.',
    dueAt: '2026-08-12T12:00:00Z',
    id: '10000000-0000-4000-8000-000000000001',
    status: 'pending',
    title: 'Required update',
    version: 2,
    viewedAt: null,
  }],
  schedules: [{
    acknowledgedAt: null,
    id: '30000000-0000-4000-8000-000000000001',
    publishedAt: '2026-08-10T12:00:00Z',
    scheduleId: '30000000-0000-4000-8000-000000000002',
    scheduleRevision: 8,
    shifts: [{
      endsAt: '2026-08-11T22:00:00Z',
      eventName: null,
      isOvertime: false,
      postName: 'Front Desk',
      requiresArmed: false,
      shiftId: '30000000-0000-4000-8000-000000000003',
      siteCode: 'ADMIN',
      siteName: 'Administrative',
      startsAt: '2026-08-11T14:00:00Z',
      timeZone: 'America/Denver',
    }],
    status: 'pending',
    viewedAt: null,
    weekStartsOn: '2026-08-09',
  }],
  serverTimestamp: '2026-08-10T13:00:00Z',
  summary: { announcementCount: 1, scheduleCount: 1, trainingCount: 1 },
  training: [{
    assignedAt: '2026-08-10T12:00:00Z',
    completedAt: null,
    contentType: 'written',
    contentUrl: null,
    courseId: '20000000-0000-4000-8000-000000000002',
    description: 'Annual review',
    dueAt: '2026-08-15T12:00:00Z',
    effectiveOn: '2026-08-10',
    id: '20000000-0000-4000-8000-000000000001',
    instructions: 'Read and confirm.',
    status: 'assigned',
    title: 'Annual Safety',
    version: 3,
    versionId: '20000000-0000-4000-8000-000000000003',
    viewedAt: null,
  }],
}

describe('employee action-center data contracts', () => {
  beforeEach(() => rpc.mockReset())

  it('parses the combined employee action queue without mixing record types', async () => {
    rpc.mockResolvedValue({ data: actionCenter, error: null })

    const result = await getEmployeeActionCenter()

    expect(result.summary).toEqual({ announcementCount: 1, scheduleCount: 1, trainingCount: 1 })
    expect(result.schedules[0].shifts[0].siteCode).toBe('ADMIN')
    expect(result.training[0].version).toBe(3)
  })

  it('sends an explicit attestation when completing training', async () => {
    rpc.mockResolvedValue({ data: actionCenter, error: null })

    await completeEmployeeAction('training', actionCenter.training[0].id, 'I completed and reviewed this training.')

    expect(rpc).toHaveBeenCalledWith('complete_employee_action', {
      target_action_id: actionCenter.training[0].id,
      target_action_type: 'training',
      target_attestation: 'I completed and reviewed this training.',
    })
  })

  it('parses one ordered required-action checkpoint with urgent access preserved', async () => {
    rpc.mockResolvedValue({
      data: {
        blocking: true,
        items: [{
          actionLabel: 'Confirm schedule',
          actionType: 'schedule',
          assignedAt: '2026-09-11T12:00:00Z',
          authoritativeVersion: 'Schedule revision 4',
          description: 'Review the published schedule.',
          dueAt: null,
          id: '70000000-0000-4000-8000-000000000001',
          metadata: { shiftsDigest: 'a'.repeat(64) },
          position: 1,
          priority: 'critical',
          responseKind: 'confirmation',
          route: '/actions?checkpoint=required',
          status: 'pending',
          title: 'Schedule for week of 09/13/2026',
          viewedAt: null,
        }],
        serverTimestamp: '2026-09-11T12:01:00Z',
        rollout: { enabled: true, enrolled: true, mode: 'canary' },
        summary: { announcements: 0, critical: 1, documents: 0, hrTasks: 0, overdue: 0, schedules: 1, signatures: 0, training: 0 },
        total: 1,
        urgentAccess: [
          { id: 'time-clock', label: 'Clock in or out', route: '/' },
          { id: 'call-off', label: 'Report sick / call-off', route: '/time/my-time?report=call-off' },
          { id: 'emergency', label: 'Emergency information', route: null },
        ],
      },
      error: null,
    })

    const checkpoint = await getRequiredActionCheckpoint()

    expect(checkpoint.blocking).toBe(true)
    expect(checkpoint.rollout).toEqual({ enabled: true, enrolled: true, mode: 'canary' })
    expect(checkpoint.items[0]).toMatchObject({ actionType: 'schedule', position: 1, responseKind: 'confirmation' })
    expect(checkpoint.urgentAccess.map((item) => item.id)).toEqual(['time-clock', 'call-off', 'emergency'])
    expect(rpc).toHaveBeenCalledWith('get_required_action_checkpoint')
  })

  it('loads compact manager reporting without requesting unrelated employee records', async () => {
    rpc.mockResolvedValue({
      data: {
        items: [{
          actionType: 'document',
          assignedAt: '2026-09-11T12:00:00Z',
          authoritativeVersion: 'Document version 2',
          contactState: 'available',
          dueAt: '2026-09-12T06:00:00Z',
          employeeId: '70000000-0000-4000-8000-000000000002',
          employeeName: 'Zach Employee',
          employeeNumber: 'GS-1002',
          id: '70000000-0000-4000-8000-000000000003',
          priority: 'high',
          responseKind: 'acknowledgment',
          status: 'pending',
          title: 'Updated post orders',
        }],
        page: { number: 1, size: 10, total: 1, totalPages: 1 },
        serverTimestamp: '2026-09-11T12:01:00Z',
        summary: { critical: 0, overdue: 0, pending: 1, unreachable: 0 },
      },
      error: null,
    })

    const report = await getRequiredActionCheckpointReport({ page: 1, pageSize: 10, search: 'Zach' })

    expect(report.items[0]).toMatchObject({ employeeName: 'Zach Employee', actionType: 'document' })
    expect(rpc).toHaveBeenCalledWith('get_required_action_checkpoint_report', {
      target_page: 1,
      target_page_size: 10,
      target_search: 'Zach',
    })
  })

  it('loads compact immutable history with explicit scope and filters', async () => {
    rpc.mockResolvedValue({
      data: {
        canViewTeam: true,
        items: [{
          actionType: 'training',
          assignedAt: '2026-08-10T12:00:00Z',
          contextLabel: 'Training version 3',
          description: 'Annual review',
          dueAt: '2026-08-15T12:00:00Z',
          employeeId: '60000000-0000-4000-8000-000000000001',
          employeeName: 'Jordan Brown',
          id: '60000000-0000-4000-8000-000000000002',
          metadata: { version: 3 },
          resolutionNote: 'I completed and reviewed this training.',
          resolutionSource: 'employee',
          resolvedAt: '2026-08-12T14:00:00Z',
          resolvedById: '60000000-0000-4000-8000-000000000001',
          resolvedByName: 'Jordan Brown',
          status: 'completed',
          title: 'Annual Safety',
          viewedAt: '2026-08-11T13:00:00Z',
        }],
        page: { number: 2, size: 10, total: 14, totalPages: 2 },
        scope: 'team',
        serverTimestamp: '2026-08-12T15:00:00Z',
      },
      error: null,
    })

    const result = await getEmployeeActionHistory({
      actionType: 'training',
      fromDate: '2026-08-01',
      page: 2,
      pageSize: 10,
      scope: 'team',
      search: 'Jordan',
      status: 'completed',
      throughDate: '2026-08-31',
    })

    expect(result.items[0].resolutionSource).toBe('employee')
    expect(result.page).toEqual({ number: 2, size: 10, total: 14, totalPages: 2 })
    expect(rpc).toHaveBeenCalledWith('get_employee_action_history', {
      target_action_type: 'training',
      target_from_date: '2026-08-01',
      target_page: 2,
      target_page_size: 10,
      target_scope: 'team',
      target_search: 'Jordan',
      target_status: 'completed',
      target_through_date: '2026-08-31',
    })
  })

  it('publishes a training version with every supported audience dimension', async () => {
    rpc.mockResolvedValue({
      data: {
        assignmentCount: 12,
        courseId: '40000000-0000-4000-8000-000000000001',
        versionId: '40000000-0000-4000-8000-000000000002',
        versionNumber: 1,
      },
      error: null,
    })

    await publishTrainingVersion({
      code: 'CO_SAFETY',
      contentType: 'document',
      contentUrl: 'https://example.com/training.pdf',
      dueAt: '2026-08-20T12:00:00Z',
      effectiveOn: '2026-08-10',
      employeeIds: ['50000000-0000-4000-8000-000000000001'],
      roles: ['guard'],
      siteIds: ['50000000-0000-4000-8000-000000000002'],
      states: ['CO'],
      title: 'Colorado Safety',
    })

    expect(rpc).toHaveBeenCalledWith('publish_training_version', expect.objectContaining({
      target_employee_ids: ['50000000-0000-4000-8000-000000000001'],
      target_roles: ['guard'],
      target_site_ids: ['50000000-0000-4000-8000-000000000002'],
      target_states: ['CO'],
    }))
  })

  it('exports readable, escaped compliance rows', () => {
    const csv = trainingComplianceCsv({
      announcements: [],
      schedules: [],
      serverTimestamp: '2026-08-10T13:00:00Z',
      training: [{
        attestation: 'Read, reviewed, and completed',
        completedAt: '2026-08-10T13:00:00Z',
        employeeId: '60000000-0000-4000-8000-000000000001',
        employeeName: 'Jordan Brown',
        id: '60000000-0000-4000-8000-000000000002',
        status: 'completed',
        title: 'Safety, Annual',
        version: 2,
      }],
    })

    expect(csv).toContain('Employee,Training,Version')
    expect(csv).toContain('"Safety, Annual"')
    expect(csv).toContain('"Read, reviewed, and completed"')
  })
})

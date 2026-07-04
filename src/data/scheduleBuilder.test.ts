import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupervisorOpenShift, getScheduleBuilderOptions, resolveScheduleReviewShift } from './schedule'

const rpc = vi.fn()

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ rpc }),
}))

describe('schedule builder data contract', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it('loads supervisor builder options from the guarded RPC', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        posts: [{
          id: '10000000-0000-4000-8000-000000000001',
          name: 'Main entrance',
          requires_armed: true,
          site: {
            id: '20000000-0000-4000-8000-000000000001',
            code: 'HQ',
            name: 'Headquarters',
            time_zone: 'America/Denver',
          },
        }],
        employees: [{
          id: '70000000-0000-4000-8000-000000000001',
          first_name: 'Jordan',
          last_name: 'Brown',
          preferred_name: null,
          role: 'admin',
          employment_type: 'salary',
          has_armed_guard_credential: true,
        }],
      },
      error: null,
    })

    await expect(getScheduleBuilderOptions()).resolves.toEqual({
      posts: [{
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Main entrance',
        requires_armed: true,
        site: {
          id: '20000000-0000-4000-8000-000000000001',
          code: 'HQ',
          name: 'Headquarters',
          time_zone: 'America/Denver',
        },
      }],
      employees: [{
        id: '70000000-0000-4000-8000-000000000001',
        first_name: 'Jordan',
        last_name: 'Brown',
        preferred_name: null,
        role: 'admin',
        employment_type: 'salary',
        has_armed_guard_credential: true,
      }],
    })
    expect(rpc).toHaveBeenCalledWith('get_schedule_builder_options')
  })

  it('normalizes event shift input before creating a published opening', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        schedule_id: '30000000-0000-4000-8000-000000000001',
        schedule_revision: 2,
        shift_id: '40000000-0000-4000-8000-000000000001',
        event_id: '50000000-0000-4000-8000-000000000001',
        announcement_id: '60000000-0000-4000-8000-000000000001',
        starts_at: '2026-07-08T14:00:00.000Z',
        ends_at: '2026-07-08T22:00:00.000Z',
        time_zone: 'America/Denver',
      },
      error: null,
    })

    await createSupervisorOpenShift({
      weekStartsOn: '2026-07-05',
      mode: 'event',
      eventName: '  Concert coverage  ',
      eventLocationName: '  Ball Arena  ',
      eventTimeZone: '',
      eventRequiresArmed: true,
      shiftDate: '2026-07-08',
      startTime: '08:00',
      endTime: '16:00',
      headcount: 4,
      isOvertime: true,
      notes: '  North gate  ',
      publishAnnouncement: true,
    })

    expect(rpc).toHaveBeenCalledWith('create_supervisor_open_shift', {
      target_week_starts_on: '2026-07-05',
      target_post_id: null,
      event_name: 'Concert coverage',
      event_location_name: 'Ball Arena',
      event_site_id: null,
      event_time_zone: 'America/Denver',
      event_requires_armed: true,
      shift_operational_date: '2026-07-08',
      shift_start_time: '08:00',
      shift_end_time: '16:00',
      target_headcount: 4,
      target_is_overtime: true,
      target_notes: 'North gate',
      publish_announcement: true,
    })
  })

  it('sends supervisor review resolutions through the guarded revision RPC', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        schedule_id: '30000000-0000-4000-8000-000000000001',
        schedule_revision: 3,
        shift_id: '40000000-0000-4000-8000-000000000001',
        employee_id: '70000000-0000-4000-8000-000000000001',
      },
      error: null,
    })

    await expect(resolveScheduleReviewShift({
      shiftId: '90000000-0000-4000-8000-000000000001',
      employeeId: '70000000-0000-4000-8000-000000000001',
      note: '  Confirmed with supervisor  ',
    })).resolves.toEqual({
      schedule_id: '30000000-0000-4000-8000-000000000001',
      schedule_revision: 3,
      shift_id: '40000000-0000-4000-8000-000000000001',
      employee_id: '70000000-0000-4000-8000-000000000001',
    })

    expect(rpc).toHaveBeenCalledWith('resolve_schedule_review_shift', {
      target_shift_id: '90000000-0000-4000-8000-000000000001',
      target_employee_id: '70000000-0000-4000-8000-000000000001',
      resolution_note: 'Confirmed with supervisor',
    })
  })
})

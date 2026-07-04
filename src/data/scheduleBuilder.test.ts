import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupervisorOpenShift, getScheduleBuilderOptions } from './schedule'

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
})

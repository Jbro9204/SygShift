import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupervisorOpenShift, getScheduleBuilderOptions, removeScheduleDraftShift, resolveScheduleReviewShift, updateScheduleDraftShift } from './schedule'

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
        employees: [
          {
            id: '70000000-0000-4000-8000-000000000002',
            first_name: 'Michael',
            last_name: 'Adams',
            preferred_name: null,
            employee_number: 'SYG-1002',
            role: 'scheduler',
            employment_type: 'hourly',
            has_armed_guard_credential: false,
          },
          {
            id: '70000000-0000-4000-8000-000000000001',
            first_name: 'Jordan',
            last_name: 'Brown',
            preferred_name: null,
            employee_number: 'SYG-1001',
            role: 'admin',
            employment_type: 'salary',
            has_armed_guard_credential: true,
          },
        ],
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
      employees: [
        {
          id: '70000000-0000-4000-8000-000000000001',
          first_name: 'Jordan',
          last_name: 'Brown',
          preferred_name: null,
          employee_number: 'SYG-1001',
          role: 'admin',
          employment_type: 'salary',
          has_armed_guard_credential: true,
        },
        {
          id: '70000000-0000-4000-8000-000000000002',
          first_name: 'Michael',
          last_name: 'Adams',
          preferred_name: null,
          employee_number: 'SYG-1002',
          role: 'scheduler',
          employment_type: 'hourly',
          has_armed_guard_credential: false,
        },
      ],
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

    expect(rpc).toHaveBeenCalledWith('scheduler_create_typed_open_shift', {
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
      target_employee_id: null,
      target_availability_override_note: null,
      target_credential_override_note: null,
      target_work_type: 'post',
    })
  })

  it('can create a directly assigned shift without publishing an opening announcement', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        schedule_id: '30000000-0000-4000-8000-000000000001',
        schedule_revision: 2,
        shift_id: '40000000-0000-4000-8000-000000000001',
        assignment_id: '80000000-0000-4000-8000-000000000001',
        event_id: null,
        announcement_id: null,
        starts_at: '2026-07-08T14:00:00.000Z',
        ends_at: '2026-07-08T22:00:00.000Z',
        time_zone: 'America/Denver',
      },
      error: null,
    })

    await expect(createSupervisorOpenShift({
      weekStartsOn: '2026-07-05',
      mode: 'post',
      postId: '10000000-0000-4000-8000-000000000001',
      shiftDate: '2026-07-08',
      startTime: '08:00',
      endTime: '16:00',
      headcount: 1,
      employeeId: '70000000-0000-4000-8000-000000000001',
      isOvertime: false,
      notes: '',
      publishAnnouncement: false,
    })).resolves.toMatchObject({
      assignment_id: '80000000-0000-4000-8000-000000000001',
    })

    expect(rpc).toHaveBeenCalledWith('scheduler_create_typed_open_shift', {
      target_week_starts_on: '2026-07-05',
      target_post_id: '10000000-0000-4000-8000-000000000001',
      event_name: null,
      event_location_name: null,
      event_site_id: null,
      event_time_zone: null,
      event_requires_armed: false,
      shift_operational_date: '2026-07-08',
      shift_start_time: '08:00',
      shift_end_time: '16:00',
      target_headcount: 1,
      target_is_overtime: false,
      target_notes: null,
      publish_announcement: false,
      target_employee_id: '70000000-0000-4000-8000-000000000001',
      target_availability_override_note: null,
      target_credential_override_note: null,
      target_work_type: 'post',
    })
  })

  it('accepts permanent post creation responses when the database omits event_id', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        schedule_id: '30000000-0000-4000-8000-000000000001',
        schedule_revision: 3,
        shift_id: '40000000-0000-4000-8000-000000000002',
        assignment_id: '80000000-0000-4000-8000-000000000002',
        announcement_id: null,
        starts_at: '2026-07-31T13:30:00.000Z',
        ends_at: '2026-08-01T00:00:00.000Z',
        time_zone: 'America/Denver',
      },
      error: null,
    })

    await expect(createSupervisorOpenShift({
      weekStartsOn: '2026-07-26',
      mode: 'post',
      postId: '10000000-0000-4000-8000-000000000001',
      shiftDate: '2026-07-31',
      startTime: '07:30',
      endTime: '18:00',
      headcount: 2,
      employeeId: '70000000-0000-4000-8000-000000000001',
      isOvertime: false,
      notes: 'Cobalt EP coverage',
      publishAnnouncement: false,
    })).resolves.toMatchObject({
      assignment_id: '80000000-0000-4000-8000-000000000002',
      shift_id: '40000000-0000-4000-8000-000000000002',
    })
  })

  it('passes armed credential override notes only when a scheduler intentionally records one', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        schedule_id: '30000000-0000-4000-8000-000000000001',
        schedule_revision: 2,
        shift_id: '40000000-0000-4000-8000-000000000001',
        assignment_id: '80000000-0000-4000-8000-000000000001',
        event_id: null,
        announcement_id: null,
        starts_at: '2026-07-08T14:00:00.000Z',
        ends_at: '2026-07-08T22:00:00.000Z',
        time_zone: 'America/Denver',
      },
      error: null,
    })

    await createSupervisorOpenShift({
      weekStartsOn: '2026-07-05',
      mode: 'post',
      postId: '10000000-0000-4000-8000-000000000001',
      shiftDate: '2026-07-08',
      startTime: '08:00',
      endTime: '16:00',
      headcount: 1,
      employeeId: '70000000-0000-4000-8000-000000000001',
      isOvertime: false,
      notes: '',
      publishAnnouncement: false,
      credentialOverrideNote: '  License verified outside SygShift; upload pending.  ',
    })

    expect(rpc).toHaveBeenCalledWith('scheduler_create_typed_open_shift', expect.objectContaining({
      target_employee_id: '70000000-0000-4000-8000-000000000001',
      target_credential_override_note: 'License verified outside SygShift; upload pending.',
    }))
  })

  it('updates draft shift assignments through the unambiguous scheduler RPC', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        id: '30000000-0000-4000-8000-000000000001',
        week_starts_on: '2026-07-26',
        revision: 4,
        status: 'draft',
        published_at: null,
        shifts: [],
      },
      error: null,
    })

    await expect(updateScheduleDraftShift({
      shiftId: '40000000-0000-4000-8000-000000000001',
      shiftDate: '2026-07-29',
      startTime: '08:00',
      endTime: '16:00',
      headcount: 1,
      isOpen: false,
      isOvertime: false,
      notes: '  Armed coverage  ',
      employeeId: '70000000-0000-4000-8000-000000000001',
      credentialOverrideNote: '  Pending upload  ',
    })).resolves.toMatchObject({
      id: '30000000-0000-4000-8000-000000000001',
      status: 'draft',
    })

    expect(rpc).toHaveBeenCalledWith('scheduler_update_typed_draft_shift', {
      target_shift_id: '40000000-0000-4000-8000-000000000001',
      shift_operational_date: '2026-07-29',
      shift_start_time: '08:00',
      shift_end_time: '16:00',
      target_headcount: 1,
      target_is_open: false,
      target_is_overtime: false,
      target_notes: 'Armed coverage',
      target_employee_id: '70000000-0000-4000-8000-000000000001',
      target_availability_override_note: null,
      target_credential_override_note: 'Pending upload',
      target_work_type: 'post',
    })
  })

  it('sends supervisor review resolutions through the guarded revision RPC', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        schedule_id: '30000000-0000-4000-8000-000000000001',
        schedule_revision: 3,
        shift_id: '40000000-0000-4000-8000-000000000001',
        employee_id: '70000000-0000-4000-8000-000000000001',
        retained_current_assignment: true,
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
      retained_current_assignment: true,
    })

    expect(rpc).toHaveBeenCalledWith('scheduler_resolve_review_shift', {
      target_shift_id: '90000000-0000-4000-8000-000000000001',
      target_employee_id: '70000000-0000-4000-8000-000000000001',
      resolution_note: 'Confirmed with supervisor',
      target_credential_override_note: null,
    })
  })

  it('removes duplicate draft shifts through the guarded removal RPC', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        id: '30000000-0000-4000-8000-000000000001',
        week_starts_on: '2026-07-26',
        revision: 4,
        status: 'draft',
        published_at: null,
        shifts: [],
      },
      error: null,
    })

    await expect(removeScheduleDraftShift({
      shiftId: '40000000-0000-4000-8000-000000000001',
      note: '  Duplicate Neon Local open shift  ',
    })).resolves.toMatchObject({
      id: '30000000-0000-4000-8000-000000000001',
      shifts: [],
      status: 'draft',
    })

    expect(rpc).toHaveBeenCalledWith('remove_schedule_draft_shift', {
      target_shift_id: '40000000-0000-4000-8000-000000000001',
      removal_note: 'Duplicate Neon Local open shift',
    })
  })
})

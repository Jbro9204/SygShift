import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveAnnouncementBanners } from './announcements'

const supabase = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => supabase,
}))

describe('employee-facing announcement banner payload', () => {
  beforeEach(() => {
    supabase.rpc.mockReset()
  })

  it('accepts a mixed dedicated-banner and ordinary-announcement feed with one lifecycle contract', async () => {
    supabase.rpc.mockResolvedValue({
      data: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          title: 'System maintenance',
          message: 'Maintenance is in progress.',
          tone: 'urgent',
          ctaLabel: null,
          ctaHref: null,
          audience: 'all',
          audienceRoles: [],
          active: true,
          lifecycleStatus: 'active',
          startsAt: '2026-10-27T13:00:00.000Z',
          expiresAt: '2026-10-28T13:00:00.000Z',
          canceledAt: null,
          createdAt: '2026-10-27T13:00:00.000Z',
          updatedAt: '2026-10-27T13:00:00.000Z',
        },
        {
          id: '20000000-0000-4000-8000-000000000002',
          title: 'Published employee announcement',
          message: 'An ordinary announcement shares the banner feed.',
          tone: 'info',
          ctaLabel: 'Open SygShift',
          ctaHref: '/',
          audience: 'roles',
          audienceRoles: ['guard'],
          active: true,
          lifecycleStatus: 'active',
          startsAt: '2026-10-27T12:00:00.000Z',
          expiresAt: '2026-11-10T12:00:00.000Z',
          canceledAt: null,
          createdAt: '2026-10-27T12:00:00.000Z',
          updatedAt: '2026-10-27T12:00:00.000Z',
        },
      ],
      error: null,
    })

    await expect(getActiveAnnouncementBanners()).resolves.toMatchObject([
      { lifecycleStatus: 'active', tone: 'urgent' },
      { lifecycleStatus: 'active', tone: 'info' },
    ])
    expect(supabase.rpc).toHaveBeenCalledWith('get_active_announcement_banners')
  })
})

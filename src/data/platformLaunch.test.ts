import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseClient } from '../lib/supabase'
import { launchSygilantPlatform, SYGILANT_LAUNCH_ENDPOINT } from './platformLaunch'

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: vi.fn(),
}))

const getSupabaseClientMock = vi.mocked(getSupabaseClient)

describe('Sygilant platform launch boundary', () => {
  beforeEach(() => {
    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'test-access-token' } },
          error: null,
        }),
      },
    } as unknown as ReturnType<typeof getSupabaseClient>)
  })

  it('requests a launch from the same-origin protected endpoint without placing credentials in the URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      launchUrl: 'https://sygilant.us/auth/continue?request=opaque',
    }), { status: 200 }))

    await expect(launchSygilantPlatform()).resolves.toBe('https://sygilant.us/auth/continue?request=opaque')
    expect(SYGILANT_LAUNCH_ENDPOINT).toBe('/api/v1/apps/sygilant/launch')
    expect(fetchMock).toHaveBeenCalledWith(SYGILANT_LAUNCH_ENDPOINT, expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }))
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('test-access-token')
  })

  it('rejects any launch destination outside the official HTTPS Sygilant domain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      launchUrl: 'https://example.com/impersonate',
    }), { status: 200 }))

    await expect(launchSygilantPlatform()).rejects.toThrow('invalid launch destination')
  })

  it('fails closed when the employee session or protected endpoint is unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    getSupabaseClientMock.mockReturnValue({
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) },
    } as unknown as ReturnType<typeof getSupabaseClient>)

    await expect(launchSygilantPlatform()).rejects.toThrow('secure SygShift session')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

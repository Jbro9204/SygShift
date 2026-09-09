import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseClient } from '../lib/supabase'
import { clearSharedIdentitySession, setSharedIdentitySession } from '../lib/sharedIdentitySession'
import { launchSygilantPlatform, submitSygilantPlatformLaunch, SYGILANT_LAUNCH_ENDPOINT } from './platformLaunch'

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: vi.fn(),
}))

const getSupabaseClientMock = vi.mocked(getSupabaseClient)

describe('Sygilant platform launch boundary', () => {
  beforeEach(() => {
    clearSharedIdentitySession()
    window.localStorage.clear()
    window.sessionStorage.clear()
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
    const requestId = crypto.randomUUID()
    const assertion = `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      launch: {
        applicationId: 'sygilant',
        applicationUrl: 'https://sygilant.us',
        assertion,
        destination: '/dashboard',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestId,
      },
    }), { status: 201 }))

    await expect(launchSygilantPlatform()).resolves.toMatchObject({ applicationUrl: 'https://sygilant.us', assertion, destination: '/dashboard' })
    expect(SYGILANT_LAUNCH_ENDPOINT).toBe('/api/v1/apps/sygilant/launch')
    expect(fetchMock).toHaveBeenCalledWith(SYGILANT_LAUNCH_ENDPOINT, expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }))
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('test-access-token')
  })

  it('forwards the protected session assurance without forwarding shared SygSphere assurance', async () => {
    window.localStorage.setItem('sygshift:trusted-device-token:v1', 'trusted-device-proof')
    window.sessionStorage.setItem('sygshift:security-key-session-token:v1', 'security-key-proof')
    window.sessionStorage.setItem('sygshift:security-key-session-expiry:v1', new Date(Date.now() + 60_000).toISOString())
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      launch: {
        applicationId: 'sygilant',
        applicationUrl: 'https://sygilant.us',
        assertion: `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`,
        destination: '/dashboard',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestId: crypto.randomUUID(),
      },
    }), { status: 201 }))

    await launchSygilantPlatform()
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]
    const headers = new Headers(request?.headers)
    expect(headers.get('x-sygshift-trusted-device')).toBe('trusted-device-proof')
    expect(headers.get('x-sygshift-security-key')).toBe('security-key-proof')
    expect(headers.has('x-sygshift-shared-identity')).toBe(false)
  })

  it('forwards platform assurance when returning from SygShift to Sygilant', async () => {
    setSharedIdentitySession(
      'shared-token'.repeat(5),
      new Date(Date.now() + 60_000).toISOString(),
      false,
      'platform',
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      launch: {
        applicationId: 'sygilant',
        applicationUrl: 'https://sygilant.us',
        assertion: `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`,
        destination: '/dashboard',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestId: crypto.randomUUID(),
      },
    }), { status: 201 }))

    await launchSygilantPlatform()

    const headers = new Headers(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-sygshift-shared-identity')).toBe('shared-token'.repeat(5))
  })

  it('rejects any launch destination outside the official HTTPS Sygilant domain', async () => {
    const assertion = `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      launch: {
        applicationId: 'sygilant',
        applicationUrl: 'https://example.com',
        assertion,
        destination: '/dashboard',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestId: crypto.randomUUID(),
      },
    }), { status: 201 }))

    await expect(launchSygilantPlatform()).rejects.toThrow('invalid launch destination')
  })

  it('posts the short-lived assertion to the exact allowlisted Sygilant consumer without putting it in a URL', () => {
    const assertion = `ssli_v1.${'a'.repeat(80)}.${'b'.repeat(64)}`
    const nativeSubmit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined)
    submitSygilantPlatformLaunch({
      applicationId: 'sygilant',
      applicationUrl: 'https://sygilant.us',
      assertion,
      destination: '/dashboard',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestId: crypto.randomUUID(),
    })

    expect(nativeSubmit).toHaveBeenCalledOnce()
    const form = nativeSubmit.mock.instances[0] as HTMLFormElement
    expect(form.action).toBe('https://sygilant.us/api/auth/shared-identity/launch')
    expect(form.method).toBe('post')
    expect(form.action).not.toContain(assertion)
    expect(new FormData(form).get('assertion')).toBe(assertion)
    expect(new FormData(form).get('destination')).toBe('/dashboard')
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

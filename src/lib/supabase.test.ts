import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSharedIdentitySession, setSharedIdentitySession } from './sharedIdentitySession'
import {
  attachTrustedDeviceHeader,
  createMemoryOnlyAuthStorage,
  deactivateSharedIdentitySupabaseSession,
  resolveSupabaseConfig,
} from './supabase'

afterEach(() => {
  clearSharedIdentitySession()
  deactivateSharedIdentitySupabaseSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('supabase browser configuration', () => {
  it('uses the public fallback when Vite env vars are absent from the build host', () => {
    expect(resolveSupabaseConfig({}).isConfigured).toBe(true)
  })

  it('uses the public fallback when the release environment supplies blank values', () => {
    const config = resolveSupabaseConfig({
      PROD: true,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    })

    expect(config.isConfigured).toBe(true)
    expect(config.supabaseUrl).toBe('https://eqkdfrbwtioiqtjsyglg.supabase.co')
    expect(config.supabasePublishableKey).toBe('sb_publishable_-uU9fD3XIeZ58r815-fl_Q_g4IIRPQ5')
  })

  it('keeps explicit blank local configuration available for disconnected-state tests', () => {
    expect(resolveSupabaseConfig({
      PROD: false,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    }).isConfigured).toBe(false)
  })

  it('sends inherited assurance only to SygSphere data surfaces', () => {
    setSharedIdentitySession('shared-token'.repeat(5), new Date(Date.now() + 60_000).toISOString(), false)

    const sphere = attachTrustedDeviceHeader('https://project.supabase.co/rest/v1/rpc/sygsphere_request')
    const avatar = attachTrustedDeviceHeader('https://project.supabase.co/storage/v1/object/authenticated/employee-photos/user/photo.webp')
    const payroll = attachTrustedDeviceHeader('https://project.supabase.co/rest/v1/rpc/get_payroll_workspace')

    expect(new Headers(sphere?.headers).has('x-sygshift-shared-identity')).toBe(true)
    expect(new Headers(avatar?.headers).has('x-sygshift-shared-identity')).toBe(true)
    expect(new Headers(payroll?.headers).has('x-sygshift-shared-identity')).toBe(false)
  })

  it('keeps a cross-platform Supabase session in memory instead of Web Storage', () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    const accessToken = 'shared-access-token-value'
    const refreshToken = 'shared-refresh-token-value'
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    const memoryStorage = createMemoryOnlyAuthStorage()

    memoryStorage.setItem('session', JSON.stringify({ accessToken, refreshToken }))

    expect(memoryStorage.getItem('session')).toContain(accessToken)
    expect(localSet.mock.calls.some(([, value]) => value.includes(accessToken) || value.includes(refreshToken))).toBe(false)
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })
})

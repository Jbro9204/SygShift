import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const nativeClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'native-access-token' } }, error: null })),
      setSession: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
      stopAutoRefresh: vi.fn(),
    },
    kind: 'native',
  }
  const candidateClient = {
    auth: {
      getSession: vi.fn(),
      setSession: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
      stopAutoRefresh: vi.fn(),
    },
    kind: 'candidate',
  }
  return {
    candidateClient,
    createClient: vi.fn(),
    nativeClient,
  }
})

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'test-publishable-key')
  mocks.createClient.mockReset()
  mocks.nativeClient.auth.getSession.mockClear()
  mocks.nativeClient.auth.setSession.mockReset()
  mocks.nativeClient.auth.signOut.mockClear()
  mocks.nativeClient.auth.stopAutoRefresh.mockClear()
  mocks.candidateClient.auth.getSession.mockReset()
  mocks.candidateClient.auth.setSession.mockReset()
  mocks.candidateClient.auth.signOut.mockClear()
  mocks.candidateClient.auth.stopAutoRefresh.mockClear()
  mocks.createClient
    .mockReturnValueOnce(mocks.nativeClient)
    .mockReturnValue(mocks.candidateClient)
})

describe('shared Supabase activation isolation', () => {
  it('keeps the persistent native client selected when an aborted candidate resolves late', async () => {
    const supabase = await import('./supabase')
    const sharedSession = await import('./sharedIdentitySession')
    const nativeClient = supabase.getSupabaseClient()
    sharedSession.setSharedIdentitySession(
      'shared-token'.repeat(5),
      new Date(Date.now() + 60_000).toISOString(),
      false,
      'platform',
    )

    let resolveSetSession: ((result: { error: null }) => void) | undefined
    const lateSetSession = new Promise<{ error: null }>((resolve) => {
      resolveSetSession = resolve
    })
    mocks.candidateClient.auth.setSession.mockReturnValueOnce(lateSetSession)
    const controller = new AbortController()
    const activation = supabase.activateSharedIdentitySupabaseSession(
      'shared-access-token',
      'shared-refresh-token',
      controller.signal,
    )
    await vi.waitFor(() => expect(mocks.candidateClient.auth.setSession).toHaveBeenCalledOnce())

    controller.abort()
    await expect(activation).rejects.toMatchObject({ kind: 'transient' })

    expect(supabase.getSupabaseClient()).toBe(nativeClient)
    expect(supabase.getSupabaseClient()).toBe(mocks.nativeClient)
    expect(sharedSession.getSharedIdentitySessionScope()).toBe('platform')
    expect(mocks.nativeClient.auth.signOut).not.toHaveBeenCalled()
    expect(mocks.candidateClient.auth.stopAutoRefresh).toHaveBeenCalledOnce()
    expect(mocks.candidateClient.auth.signOut).toHaveBeenCalledOnce()
    const nativeOptions = mocks.createClient.mock.calls[0]?.[2] as {
      auth?: { persistSession?: boolean, storage?: unknown }
    }
    expect(nativeOptions.auth).toMatchObject({ persistSession: true })
    expect(nativeOptions.auth?.storage).toBeUndefined()

    resolveSetSession?.({ error: null })
    await lateSetSession
    await vi.waitFor(() => expect(mocks.candidateClient.auth.signOut).toHaveBeenCalledTimes(2))
    expect(supabase.getSupabaseClient()).toBe(mocks.nativeClient)
    expect(sharedSession.getSharedIdentitySessionScope()).toBe('platform')
  })

  it('disposes a terminally rejected candidate without replacing or signing out the native client', async () => {
    const supabase = await import('./supabase')
    const sharedSession = await import('./sharedIdentitySession')
    const nativeClient = supabase.getSupabaseClient()
    sharedSession.setSharedIdentitySession(
      'shared-token'.repeat(5),
      new Date(Date.now() + 60_000).toISOString(),
      false,
      'platform',
    )
    mocks.candidateClient.auth.setSession.mockResolvedValueOnce({
      error: {
        code: 'unexpected_auth_response',
        message: 'The auth response was not usable.',
        status: 400,
      },
    })

    await expect(supabase.activateSharedIdentitySupabaseSession(
      'shared-access-token',
      'shared-refresh-token',
    )).rejects.toMatchObject({ kind: 'terminal' })

    expect(supabase.getSupabaseClient()).toBe(nativeClient)
    expect(supabase.getSupabaseClient()).toBe(mocks.nativeClient)
    expect(sharedSession.getSharedIdentitySessionScope()).toBe('platform')
    expect(mocks.nativeClient.auth.signOut).not.toHaveBeenCalled()
    expect(mocks.candidateClient.auth.stopAutoRefresh).toHaveBeenCalledOnce()
    expect(mocks.candidateClient.auth.signOut).toHaveBeenCalledOnce()
  })

  it('commits a validated shared client before stalled native-session cleanup', async () => {
    const supabase = await import('./supabase')
    const sharedSession = await import('./sharedIdentitySession')
    const nativeClient = supabase.getSupabaseClient()
    sharedSession.setSharedIdentitySession(
      'shared-token'.repeat(5),
      new Date(Date.now() + 60_000).toISOString(),
      false,
      'platform',
    )
    mocks.candidateClient.auth.setSession.mockResolvedValueOnce({ error: null })
    let resolveNativeSignOut: ((result: { error: null }) => void) | undefined
    const stalledNativeSignOut = new Promise<{ error: null }>((resolve) => {
      resolveNativeSignOut = resolve
    })
    mocks.nativeClient.auth.signOut.mockReturnValueOnce(stalledNativeSignOut)

    await supabase.activateSharedIdentitySupabaseSession(
      'shared-access-token',
      'shared-refresh-token',
    )

    expect(mocks.nativeClient.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(supabase.getSupabaseClient()).toBe(mocks.candidateClient)
    expect(supabase.isActiveSupabaseClient(mocks.candidateClient as never)).toBe(true)
    expect(supabase.isActiveSupabaseClient(nativeClient)).toBe(false)
    expect(sharedSession.getSharedIdentitySessionScope()).toBe('platform')
    expect(mocks.candidateClient.auth.signOut).not.toHaveBeenCalled()

    resolveNativeSignOut?.({ error: null })
    await stalledNativeSignOut
    expect(supabase.getSupabaseClient()).toBe(mocks.candidateClient)
    expect(sharedSession.getSharedIdentitySessionScope()).toBe('platform')
  })
})

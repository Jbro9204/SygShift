import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelIdentityVerification, captureIdentityVerificationActor, clearIdentityVerificationSession,
  completeIdentityVerification, fetchWithIdentityVerification, identityVerificationActorIsCurrent,
  monitorIdentityVerificationSession, responseRequiresIdentityVerification, setIdentityVerificationAccessGeneration,
  setIdentityVerificationSurface, subscribeToIdentityVerification, supabaseWithIdentityVerification,
} from './identityVerificationCoordinator'

const selected = vi.hoisted(() => ({ client: null as unknown as SupabaseClient, kind: null as 'platform' | 'sygsphere' | null }))
vi.mock('./supabase', () => ({ getSupabaseClient: () => selected.client }))
vi.mock('./sharedIdentitySession', () => ({ getSharedIdentitySessionScope: () => selected.kind }))

const userA = '10000000-0000-4000-8000-000000000001'
const userB = '10000000-0000-4000-8000-000000000002'
const cleanups: (() => void)[] = []

function session(user = userA, id: string = crypto.randomUUID(), aal = 'aal1'): Session {
  return { access_token: `header.${btoa(JSON.stringify({ sub: user, session_id: id, aal }))}.signature`,
    user: { id: user, factors: [], app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-02T12:00:00.000Z' },
    refresh_token: 'local-test-refresh', token_type: 'bearer', expires_in: 3600 }
}

function client(initial: Session | null) {
  let current = initial
  const listeners = new Set<(event: AuthChangeEvent, value: Session | null) => void>()
  const getSession = vi.fn(async () => ({ data: { session: current }, error: null }))
  const value = { auth: { getSession, onAuthStateChange: vi.fn((listener: (event: AuthChangeEvent, value: Session | null) => void) => {
    listeners.add(listener)
    return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }
  }) } } as unknown as SupabaseClient
  return { value, getSession, emit(event: AuthChangeEvent, next: Session | null) {
    current = next
    listeners.forEach((listener) => listener(event, next))
  }, current: () => current }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function jsonResponse(status = 403, error = 'recent_document_mfa_required'): Response { return Response.json({ error }, { status }) }
function prompts() {
  const calls: { context: string; id: string }[] = []
  cleanups.push(subscribeToIdentityVerification((required, context, id) => { if (required && id) calls.push({ context, id }) }))
  return calls
}
async function promptId(calls: ReturnType<typeof prompts>) {
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
  return calls.at(-1)!.id
}

let active: ReturnType<typeof client>
beforeEach(() => {
  active = client(session())
  selected.client = active.value
  selected.kind = null
  setIdentityVerificationSurface('/time/review', `?test=${crypto.randomUUID()}`)
})
afterEach(() => {
  cancelIdentityVerification()
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

describe('identity verification coordinator', () => {
  it.each(['hr_compensation_mfa_required', 'recent_document_mfa_required', 'recent_hr_mfa_required'])(
    'recognizes genuine explicit protected code %s', async (code) => {
      await expect(responseRequiresIdentityVerification(jsonResponse(403, code))).resolves.toBe(true)
    },
  )
  it.each(['permission_required', 'admin_users_permission_required', 'notifications_permission_required'])(
    'does not classify permission denial %s as verification', async (code) => {
      await expect(responseRequiresIdentityVerification(jsonResponse(403, code))).resolves.toBe(false)
    },
  )
  it('preserves genuine protected MFA and retries exactly once after this request is verified', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse(200))
    const result = fetchWithIdentityVerification(request)
    await completeIdentityVerification('security_key', await promptId(calls))
    await expect(result).resolves.toMatchObject({ status: 200 })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('returns the original denial on cancellation without an automatic second attempt', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const result = fetchWithIdentityVerification(request)
    cancelIdentityVerification(await promptId(calls))
    await expect(result).resolves.toMatchObject({ status: 403 })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('retains HR and licensing context and deduplicates concurrent same-session prompts', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValue(jsonResponse(403, 'recent_hr_mfa_required'))
    const first = fetchWithIdentityVerification(request)
    const second = fetchWithIdentityVerification(request)
    const id = await promptId(calls)
    expect(calls).toEqual([{ context: 'hr', id }])
    cancelIdentityVerification(id)
    await Promise.all([first, second])
    const licensing = fetchWithIdentityVerification(() => Promise.resolve(jsonResponse(403, 'licensing_document_mfa_required')))
    await vi.waitFor(() => expect(calls.at(-1)?.context).toBe('licensing'))
    cancelIdentityVerification(calls.at(-1)!.id)
    await licensing
  })
  it.each([
    'Accountability workspace permission with MFA is required.',
    'Operations access with MFA is required.',
    'The required role and MFA are required.',
  ])('preserves legacy combined SQL verification without granting access: %s', async (message) => {
    const calls = prompts()
    const denied = { data: null, error: { code: '42501', message } }
    const request = vi.fn().mockResolvedValue(denied)
    const result = supabaseWithIdentityVerification(request)
    cancelIdentityVerification(await promptId(calls))
    await expect(result).resolves.toBe(denied)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not turn an ordinary permission denial into a verification challenge', async () => {
    const calls = prompts()
    const denied = { data: null, error: { code: '42501', message: 'You do not have permission to view this workspace.' } }
    await expect(supabaseWithIdentityVerification(async () => denied)).resolves.toBe(denied)
    expect(calls).toEqual([])
  })
  it('preserves explicit MFA-only payroll verification for authorized operations', async () => {
    const calls = prompts()
    const request = vi.fn()
      .mockResolvedValueOnce({ error: { code: '42501', message: 'MFA verification is required to load payroll review details.' } })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
    const result = supabaseWithIdentityVerification(request)
    await completeIdentityVerification('authenticator', await promptId(calls))
    await expect(result).resolves.toEqual({ data: { ok: true }, error: null })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it.each(['missing', 'failure'] as const)('does not autochallenge or retry with %s session identity', async (mode) => {
    const calls = prompts()
    if (mode === 'missing') active.emit('SIGNED_OUT', null)
    else active.getSession.mockRejectedValue(new Error('Local identity unavailable'))
    const request = vi.fn().mockResolvedValue(jsonResponse())
    await expect(fetchWithIdentityVerification(request)).resolves.toMatchObject({ status: 403 })
    expect(request).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })
  it('discards a delayed initial identity bootstrap after account change without sending the original action', async () => {
    const calls = prompts()
    const old = deferred<Awaited<ReturnType<typeof active.getSession>>>()
    active.getSession.mockReturnValueOnce(old.promise)
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const result = fetchWithIdentityVerification(request)
    const observedResult = expect(result).rejects.toThrow('signed-in session or page changed')
    active.emit('SIGNED_IN', session(userB))
    old.resolve({ data: { session: active.current() }, error: null })
    await observedResult
    expect(request).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
  it('allows INITIAL_SESSION to initialize the same actor during its first identity read', async () => {
    const calls = prompts()
    const initial = active.current()
    const read = deferred<Awaited<ReturnType<typeof active.getSession>>>()
    active.getSession.mockReturnValueOnce(read.promise)
    const request = vi.fn().mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse(200))
    const result = fetchWithIdentityVerification(request)
    active.emit('INITIAL_SESSION', initial)
    read.resolve({ data: { session: initial }, error: null })
    await completeIdentityVerification('authenticator', await promptId(calls))
    await expect(result).resolves.toMatchObject({ status: 200 })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects a delayed initial bootstrap after navigation rather than adopting the new route', async () => {
    const old = deferred<Awaited<ReturnType<typeof active.getSession>>>()
    active.getSession.mockReturnValueOnce(old.promise)
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const result = fetchWithIdentityVerification(request)
    const observedResult = expect(result).rejects.toThrow('signed-in session or page changed')
    setIdentityVerificationSurface('/schedule', '?week=2026-11-01')
    old.resolve({ data: { session: active.current() }, error: null })
    await observedResult
    expect(request).not.toHaveBeenCalled()
  })
  it('does not open an old-account prompt when its response arrives after switching accounts', async () => {
    const calls = prompts()
    const response = deferred<Response>()
    const request = vi.fn().mockReturnValue(response.promise)
    const result = fetchWithIdentityVerification(request)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    active.emit('SIGNED_IN', session(userB))
    response.resolve(jsonResponse())
    await result
    expect(calls).toEqual([])
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['/schedule?week=2026-11-01', '/time/review?week=2026-10-25'])(
    'does not carry a late protected response onto %s', async (surface) => {
      const calls = prompts()
      const response = deferred<Response>()
      const request = vi.fn().mockReturnValue(response.promise)
      const result = fetchWithIdentityVerification(request)
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
      const url = new URL(surface, 'https://local.invalid')
      setIdentityVerificationSurface(url.pathname, url.search)
      response.resolve(jsonResponse())
      await result
      expect(calls).toEqual([])
    },
  )
  it('checks ownership again after asynchronously parsing the error payload', async () => {
    const calls = prompts()
    const parsed = deferred<{ error: string }>()
    const response = jsonResponse()
    vi.spyOn(response, 'clone').mockReturnValue({ json: () => parsed.promise } as Response)
    const result = fetchWithIdentityVerification(async () => response)
    await vi.waitFor(() => expect(response.clone).toHaveBeenCalled())
    active.emit('SIGNED_IN', session(userB))
    parsed.resolve({ error: 'recent_document_mfa_required' })
    await result
    expect(calls).toEqual([])
  })
  it('clears pending verification immediately on sign-out and blocks cached old-session resurrection', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const result = fetchWithIdentityVerification(request)
    await promptId(calls)
    clearIdentityVerificationSession()
    await expect(result).resolves.toMatchObject({ status: 403 })
    expect(await captureIdentityVerificationActor()).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('preserves a genuine prompt across same-session token refresh and MFA assurance upgrade', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse(200))
    const result = fetchWithIdentityVerification(request)
    const id = await promptId(calls)
    const claims = JSON.parse(atob(active.current()!.access_token.split('.')[1])) as { session_id: string }
    active.emit('TOKEN_REFRESHED', session(userA, claims.session_id, 'aal2'))
    await completeIdentityVerification('authenticator', id)
    await expect(result).resolves.toMatchObject({ status: 200 })
    expect(calls).toHaveLength(1)
  })
  it('invalidates a prompt when the same user receives a different provider session', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const result = fetchWithIdentityVerification(request)
    await promptId(calls)
    active.emit('SIGNED_IN', session())
    await result
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not let old completion or cancellation resolve a new request after A to B to A', async () => {
    const calls = prompts()
    const original = active.current()
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const first = fetchWithIdentityVerification(request)
    const oldId = await promptId(calls)
    active.emit('SIGNED_IN', session(userB))
    active.emit('SIGNED_IN', original)
    await first
    const second = fetchWithIdentityVerification(request)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    const newId = calls.at(-1)!.id
    await completeIdentityVerification('authenticator', oldId)
    cancelIdentityVerification(oldId)
    expect(request).toHaveBeenCalledTimes(2)
    cancelIdentityVerification(newId)
    await second
  })
  it('cancels a native prompt on shared-client replacement and ignores the old client events', async () => {
    const calls = prompts()
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const first = fetchWithIdentityVerification(request)
    await promptId(calls)
    const shared = client(active.current())
    selected.client = shared.value
    selected.kind = 'platform'
    const actor = await captureIdentityVerificationActor()
    await first
    expect(actor?.clientKind).toBe('platform')
    active.emit('SIGNED_OUT', null)
    expect(await identityVerificationActorIsCurrent(actor)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('cancels pending verification when central access generation changes', async () => {
    const calls = prompts()
    setIdentityVerificationAccessGeneration(userA, 1)
    const request = vi.fn().mockResolvedValue(jsonResponse())
    const result = fetchWithIdentityVerification(request)
    await promptId(calls)
    setIdentityVerificationAccessGeneration(userA, 2)
    await result
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not open queued Web Lock work after the actor signs out', async () => {
    const calls = prompts()
    let callback: (() => Promise<unknown>) | undefined
    let signal: AbortSignal | undefined
    vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, options, work) => {
      signal = options.signal
      callback = work
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }) } })
    const result = fetchWithIdentityVerification(async () => jsonResponse())
    await vi.waitFor(() => expect(callback).toBeDefined())
    active.emit('SIGNED_OUT', null)
    expect(signal?.aborted).toBe(true)
    await result
    await expect(callback!()).rejects.toThrow('signed-in session changed')
    expect(calls).toEqual([])
  })
  it('unmount cleanup does not leave a global prompt attached to the next Host', async () => {
    const stop = monitorIdentityVerificationSession()
    await captureIdentityVerificationActor()
    const calls = prompts()
    const result = fetchWithIdentityVerification(async () => jsonResponse())
    await promptId(calls)
    stop()
    await result
    const next = prompts()
    expect(next).toEqual([])
  })
  it.each([false, true])('accepts only a valid same-session cross-tab resolution (valid=%s)', async (valid) => {
    const calls = prompts()
    const actor = await captureIdentityVerificationActor()
    const channels: FakeChannel[] = []
    class FakeChannel {
      readonly name: string
      handler: ((event: MessageEvent<unknown>) => void) | null = null
      close = vi.fn()
      postMessage = vi.fn()
      constructor(name: string) { this.name = name; channels.push(this) }
      addEventListener(_type: string, handler: (event: MessageEvent<unknown>) => void) { this.handler = handler }
      send(data: unknown) { this.handler?.({ data } as MessageEvent<unknown>) }
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    let grant: (() => void) | undefined
    const lock = vi.fn((_name, options, work: () => Promise<unknown>) => new Promise((resolve, reject) => {
      grant = () => { void work().then(resolve, reject) }
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    vi.stubGlobal('navigator', { locks: { request: lock } })
    const request = vi.fn().mockResolvedValueOnce(jsonResponse()).mockResolvedValueOnce(jsonResponse(200))
    const result = fetchWithIdentityVerification(request)
    await vi.waitFor(() => expect(grant).toBeDefined())
    expect(lock.mock.calls[0]?.[0]).toContain(actor!.scope)
    expect(channels[0].name).toContain(actor!.scope)
    const resolution = { actor: actor!.scope, canceled: false, completedAt: Date.now(), method: 'authenticator', requestId: crypto.randomUUID() }
    if (valid) channels[0].send(resolution)
    else {
      channels[0].send({ ...resolution, actor: `native:${userB}:${crypto.randomUUID()}` })
      channels[0].send({ ...resolution, method: 'password' })
      channels[0].send({ ...resolution, completedAt: Date.now() + 60_000 })
      channels[0].send({ ...resolution, completedAt: Date.now() - 120_000 })
      channels[0].send({ ...resolution, requestId: 'not-a-request-id' })
      channels[0].send(null)
    }
    grant!()
    if (!valid) cancelIdentityVerification(await promptId(calls))
    await expect(result).resolves.toMatchObject({ status: valid ? 200 : 403 })
    expect(request).toHaveBeenCalledTimes(valid ? 2 : 1)
    expect(calls).toHaveLength(valid ? 0 : 1)
  })
})

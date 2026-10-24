import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeClient: null as TestClient | null,
}))

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => {
    if (!state.activeClient) throw new Error('No test Supabase client selected.')
    return state.activeClient
  },
}))

vi.mock('../lib/notificationSounds', () => ({
  getSoundPreferences: () => ({ muted: false, notification: true, volume: 1 }),
}))

vi.mock('../lib/pwaInstall', () => ({
  ensureSygShiftServiceWorker: vi.fn(async () => undefined),
}))

type PushModule = typeof import('./pushNotifications')
type Identity = { employeeId: string; authUserId: string; authSessionId: string }
type ServerOwner = Identity & { enabled: boolean; operationId: string | null }
type StoredOperation = Identity & { enabled: boolean; endpoint: string; expectedOwnerOperationId: string | null; changed: boolean }
type RpcResult = { data: unknown; error: { message: string } | null }
type TestClient = {
  auth: { getSession: ReturnType<typeof vi.fn> }
  rpc: ReturnType<typeof vi.fn>
}

const employeeA = '73000000-0000-4000-8000-000000000010'
const authUserA = '74000000-0000-4000-8000-000000000010'
const sessionA = '75000000-0000-4000-8000-000000000010'
const employeeB = '73000000-0000-4000-8000-000000000020'
const authUserB = '74000000-0000-4000-8000-000000000020'
const sessionB = '75000000-0000-4000-8000-000000000020'
const endpoint = 'https://fcm.googleapis.com/fcm/send/push-ownership-test'

function token(sessionId: string): string {
  return `header.${btoa(JSON.stringify({ session_id: sessionId }))}.signature`
}

function session(identity: Identity) {
  return { access_token: token(identity.authSessionId), user: { id: identity.authUserId } }
}

class OriginLockManager {
  private tails = new Map<string, Promise<void>>()

  request<T>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    this.tails.set(name, previous.then(() => pending))
    return previous.then(callback).finally(release)
  }
}

class OriginBroadcastChannel {
  static channels = new Map<string, Set<OriginBroadcastChannel>>()
  readonly name: string
  private listeners = new Set<(event: MessageEvent) => void>()

  constructor(name: string) {
    this.name = name
    const channels = OriginBroadcastChannel.channels.get(name) ?? new Set()
    channels.add(this)
    OriginBroadcastChannel.channels.set(name, channels)
  }

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.add(listener as (event: MessageEvent) => void)
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.delete(listener as (event: MessageEvent) => void)
  }

  postMessage(data: unknown): void {
    for (const channel of OriginBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel === this) continue
      queueMicrotask(() => channel.listeners.forEach((listener) => listener({ data } as MessageEvent)))
    }
  }

  close(): void {
    OriginBroadcastChannel.channels.get(this.name)?.delete(this)
  }

  static reset(): void {
    OriginBroadcastChannel.channels.clear()
  }
}

function makeServer(initialOwner: ServerOwner | null = null) {
  let owner = initialOwner
  const operations = new Map<string, StoredOperation>()
  const evidence = (actor: Identity, operationId: string | null, confirmed = true, changed = false) => ({
    ...(() => {
      const sameOwner = owner?.employeeId === actor.employeeId
        && owner.authUserId === actor.authUserId
        && owner.authSessionId === actor.authSessionId
      return {
        ownerEmployeeId: sameOwner ? owner?.employeeId ?? null : null,
        ownerAuthUserId: sameOwner ? owner?.authUserId ?? null : null,
        ownerAuthSessionId: sameOwner ? owner?.authSessionId ?? null : null,
      }
    })(),
    confirmed,
    changed,
    enabled: Boolean(owner?.enabled && owner.employeeId === actor.employeeId && owner.authUserId === actor.authUserId && owner.authSessionId === actor.authSessionId),
    endpoint,
    operationId,
    ownerOperationId: owner?.operationId ?? null,
    actorEmployeeId: actor.employeeId,
    actorAuthUserId: actor.authUserId,
    actorAuthSessionId: actor.authSessionId,
  })
  return {
    evidence,
    operations,
    get owner() { return owner },
    set owner(value: ServerOwner | null) { owner = value },
  }
}

function makeClient(identity: Identity, server: ReturnType<typeof makeServer>): TestClient {
  let currentIdentity = identity
  const client: TestClient & { setIdentity: (next: Identity) => void } = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: session(currentIdentity) }, error: null })),
    },
    rpc: vi.fn(async (name: string, input: Record<string, unknown>): Promise<RpcResult> => {
      if (input.target_expected_auth_user_id !== currentIdentity.authUserId
        || input.target_expected_auth_session_id !== currentIdentity.authSessionId) {
        return { data: null, error: { message: 'identity changed' } }
      }
      if (name === 'get_my_push_subscription_guarded') {
        return { data: server.evidence(currentIdentity, null), error: null }
      }
      if (name !== 'set_my_push_subscription_guarded') throw new Error(`Unexpected RPC ${name}`)
      if (input.target_expected_employee_id !== currentIdentity.employeeId) {
        return { data: null, error: { message: 'employee changed' } }
      }
      const enabled = input.target_enabled === true
      const operationId = String(input.target_operation_id)
      const expectedOwnerOperationId = input.target_expected_owner_operation_id === null
        ? null
        : String(input.target_expected_owner_operation_id)
      const existingOperation = server.operations.get(operationId)
      if (existingOperation) {
        if (existingOperation.endpoint !== endpoint
          || existingOperation.enabled !== enabled
          || existingOperation.expectedOwnerOperationId !== expectedOwnerOperationId
          || existingOperation.employeeId !== currentIdentity.employeeId
          || existingOperation.authUserId !== currentIdentity.authUserId
          || existingOperation.authSessionId !== currentIdentity.authSessionId) {
          return { data: null, error: { message: 'operation binding changed' } }
        }
        const stillCurrent = server.owner?.operationId === operationId
          && server.owner.enabled === enabled
          && server.owner.employeeId === currentIdentity.employeeId
          && server.owner.authUserId === currentIdentity.authUserId
          && server.owner.authSessionId === currentIdentity.authSessionId
        return { data: server.evidence(currentIdentity, operationId, stillCurrent, stillCurrent && existingOperation.changed), error: null }
      }
      if ((server.owner?.operationId ?? null) !== expectedOwnerOperationId) {
        server.operations.set(operationId, { ...currentIdentity, enabled, endpoint, expectedOwnerOperationId, changed: false })
        return { data: server.evidence(currentIdentity, operationId, false, false), error: null }
      }
      if (enabled) {
        const changed = !server.owner?.enabled
          || server.owner.employeeId !== currentIdentity.employeeId
          || server.owner.authSessionId !== currentIdentity.authSessionId
        server.owner = { ...currentIdentity, enabled: true, operationId }
        server.operations.set(operationId, { ...currentIdentity, enabled, endpoint, expectedOwnerOperationId, changed })
        return { data: server.evidence(currentIdentity, operationId, true, changed), error: null }
      }
      const matches = server.owner?.employeeId === currentIdentity.employeeId
        && server.owner.authUserId === currentIdentity.authUserId
        && server.owner.authSessionId === currentIdentity.authSessionId
      if (matches) {
        const changed = server.owner!.enabled
        server.owner = { ...currentIdentity, enabled: false, operationId }
        server.operations.set(operationId, { ...currentIdentity, enabled, endpoint, expectedOwnerOperationId, changed })
        return { data: server.evidence(currentIdentity, operationId, true, changed), error: null }
      }
      server.operations.set(operationId, { ...currentIdentity, enabled, endpoint, expectedOwnerOperationId, changed: false })
      return { data: server.evidence(currentIdentity, operationId, false, false), error: null }
    }),
    setIdentity(next) { currentIdentity = next },
  }
  return client
}

function installBrowser(subscription: {
  endpoint: string
  toJSON: () => PushSubscriptionJSON
  unsubscribe: ReturnType<typeof vi.fn>
}) {
  const postedOwners: Array<string | null> = []
  const registration = {
    active: {
      postMessage: (message: { employeeId: string | null }, ports: MessagePort[]) => {
        postedOwners.push(message.employeeId)
        ports[0]?.postMessage({ saved: true })
      },
    },
    pushManager: {
      getSubscription: vi.fn(async (): Promise<typeof subscription | null> => subscription),
      subscribe: vi.fn(async () => subscription),
    },
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  })
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} })
  return { postedOwners, registration }
}

async function loadSeparateTabs(): Promise<[PushModule, PushModule]> {
  vi.resetModules()
  const first = await import('./pushNotifications')
  vi.resetModules()
  const second = await import('./pushNotifications')
  return [first, second]
}

beforeEach(() => {
  window.localStorage.clear()
  OriginBroadcastChannel.reset()
  vi.stubGlobal('BroadcastChannel', OriginBroadcastChannel)
  Object.defineProperty(navigator, 'locks', { configurable: true, value: new OriginLockManager() })
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') })
})

afterEach(() => {
  state.activeClient = null
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('origin-wide push ownership', () => {
  it('fails closed when the browser cannot provide an origin-wide lock', async () => {
    const [tab] = await loadSeparateTabs()
    const server = makeServer()
    state.activeClient = makeClient({ employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }, server)
    const subscription = { endpoint, toJSON: () => ({ endpoint }), unsubscribe: vi.fn(async () => true) }
    installBrowser(subscription)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })

    await expect(tab.enableDevicePush(employeeA)).rejects.toThrow('cannot safely coordinate')
    await expect(tab.disableDevicePush(employeeA)).rejects.toThrow('cannot safely coordinate')
    expect(state.activeClient.rpc).not.toHaveBeenCalled()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('fails closed when BroadcastChannel coordination is unavailable', async () => {
    const [tab] = await loadSeparateTabs()
    const server = makeServer()
    state.activeClient = makeClient({ employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }, server)
    const subscription = { endpoint, toJSON: () => ({ endpoint }), unsubscribe: vi.fn(async () => true) }
    installBrowser(subscription)
    vi.stubGlobal('BroadcastChannel', undefined)

    await expect(tab.disableDevicePush(employeeA)).rejects.toThrow('cannot safely coordinate')
    expect(state.activeClient.rpc).not.toHaveBeenCalled()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('fails closed when the ownership epoch cannot be persisted', async () => {
    const [tab] = await loadSeparateTabs()
    const server = makeServer()
    state.activeClient = makeClient({ employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }, server)
    const subscription = { endpoint, toJSON: () => ({ endpoint }), unsubscribe: vi.fn(async () => true) }
    installBrowser(subscription)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })

    await expect(tab.disableDevicePush(employeeA)).rejects.toThrow('secure browser storage is unavailable')
    expect(state.activeClient.rpc).not.toHaveBeenCalled()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('uses separate tab runtimes to fence a delayed disable before a newer account restore', async () => {
    const [tabA, tabB] = await loadSeparateTabs()
    const identityA = { employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }
    const identityB = { employeeId: employeeB, authUserId: authUserB, authSessionId: sessionB }
    const server = makeServer({ ...identityA, enabled: true, operationId: crypto.randomUUID() })
    const clientA = makeClient(identityA, server)
    const clientB = makeClient(identityB, server)
    const subscription = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'A', auth: 'B' } }), unsubscribe: vi.fn(async () => true) }
    const { postedOwners } = installBrowser(subscription)
    window.localStorage.setItem(`sygshift.push-enabled:${employeeB}`, 'true')

    let releaseDisable!: () => void
    const disableResponse = new Promise<void>((resolve) => { releaseDisable = resolve })
    const baseRpc = clientA.rpc.getMockImplementation() as (name: string, input: Record<string, unknown>) => Promise<RpcResult>
    clientA.rpc.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      const result = await baseRpc(name, input)
      if (name === 'set_my_push_subscription_guarded' && input.target_enabled === false) await disableResponse
      return result
    })

    state.activeClient = clientA
    const staleDisable = tabA.disableDevicePush(employeeA)
    await vi.waitFor(() => expect(clientA.rpc).toHaveBeenCalledWith('set_my_push_subscription_guarded', expect.objectContaining({ target_enabled: false })))

    state.activeClient = clientB
    const newerRestore = tabB.restorePushSession(employeeB)
    releaseDisable()
    await expect(staleDisable).rejects.toThrow('signed-in account changed')
    await newerRestore

    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(server.owner).toMatchObject({ ...identityB, enabled: true })
    expect(postedOwners).toEqual([employeeB])
  })

  it('does not unsubscribe after a lost disable response and safely confirms a retry', async () => {
    const [tab] = await loadSeparateTabs()
    const identityA = { employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }
    const server = makeServer({ ...identityA, enabled: true, operationId: crypto.randomUUID() })
    const client = makeClient(identityA, server)
    const subscription = { endpoint, toJSON: () => ({ endpoint }), unsubscribe: vi.fn(async () => true) }
    const { postedOwners } = installBrowser(subscription)
    window.localStorage.setItem(`sygshift.push-enabled:${employeeA}`, 'true')
    const baseRpc = client.rpc.getMockImplementation() as (name: string, input: Record<string, unknown>) => Promise<RpcResult>
    let loseNextDisableResponse = true
    client.rpc.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      const response = await baseRpc(name, input)
      if (name === 'set_my_push_subscription_guarded' && input.target_enabled === false && loseNextDisableResponse) {
        loseNextDisableResponse = false
        return { data: null, error: { message: 'response lost' } }
      }
      return response
    })
    state.activeClient = client

    await expect(tab.disableDevicePush(employeeA)).rejects.toThrow('response lost')
    expect(server.owner).toMatchObject({ ...identityA, enabled: false })
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(postedOwners).toEqual([])
    expect(window.localStorage.getItem(`sygshift.push-enabled:${employeeA}`)).toBe('true')

    await tab.disableDevicePush(employeeA)
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(postedOwners).toEqual([null])
    expect(window.localStorage.getItem(`sygshift.push-enabled:${employeeA}`)).toBeNull()
  })

  it('recreates availability when a newer restore claims its epoch at the unsubscribe boundary', async () => {
    const [tabA, tabB] = await loadSeparateTabs()
    const identityA = { employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }
    const identityB = { employeeId: employeeB, authUserId: authUserB, authSessionId: sessionB }
    const server = makeServer({ ...identityA, enabled: true, operationId: crypto.randomUUID() })
    const clientA = makeClient(identityA, server)
    const clientB = makeClient(identityB, server)
    let available = true
    let newerRestore: Promise<void> | undefined
    const subscription = {
      endpoint,
      toJSON: () => ({ endpoint, keys: { p256dh: 'A', auth: 'B' } }),
      unsubscribe: vi.fn(async () => {
        available = false
        state.activeClient = clientB
        newerRestore = tabB.restorePushSession(employeeB)
        return true
      }),
    }
    const { postedOwners, registration } = installBrowser(subscription)
    registration.pushManager.getSubscription.mockImplementation(async () => available ? subscription : null)
    registration.pushManager.subscribe.mockImplementation(async () => {
      available = true
      return subscription
    })
    window.localStorage.setItem(`sygshift.push-enabled:${employeeB}`, 'true')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configured: true, publicKey: 'AA' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    state.activeClient = clientA

    await expect(tabA.disableDevicePush(employeeA)).rejects.toThrow('signed-in account changed')
    await vi.waitFor(() => expect(newerRestore).toBeDefined())
    await newerRestore!

    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(registration.pushManager.subscribe).toHaveBeenCalledOnce()
    expect(available).toBe(true)
    expect(server.owner).toMatchObject({ ...identityB, enabled: true })
    expect(postedOwners).toEqual([employeeB])
  })

  it('rejects status from the prior ambient session after an account switch', async () => {
    const [tab] = await loadSeparateTabs()
    const identityA = { employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }
    const identityB = { employeeId: employeeB, authUserId: authUserB, authSessionId: sessionB }
    const server = makeServer({ ...identityA, enabled: true, operationId: crypto.randomUUID() })
    const client = makeClient(identityA, server) as TestClient & { setIdentity: (next: Identity) => void }
    const subscription = { endpoint, toJSON: () => ({ endpoint }), unsubscribe: vi.fn(async () => true) }
    installBrowser(subscription)
    let releaseStatus!: () => void
    const statusResponse = new Promise<void>((resolve) => { releaseStatus = resolve })
    const baseRpc = client.rpc.getMockImplementation() as (name: string, input: Record<string, unknown>) => Promise<RpcResult>
    client.rpc.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      const result = await baseRpc(name, input)
      if (name === 'get_my_push_subscription_guarded') await statusResponse
      return result
    })
    state.activeClient = client

    const status = tab.getDevicePushEnabled()
    await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledWith('get_my_push_subscription_guarded', expect.anything()))
    client.setIdentity(identityB)
    releaseStatus()

    await expect(status).rejects.toThrow('signed-in account changed')
  })

  it('never unsubscribes without matching confirmed owner evidence', async () => {
    const [tab] = await loadSeparateTabs()
    const identityA = { employeeId: employeeA, authUserId: authUserA, authSessionId: sessionA }
    const identityB = { employeeId: employeeB, authUserId: authUserB, authSessionId: sessionB }
    const server = makeServer({ ...identityB, enabled: true, operationId: crypto.randomUUID() })
    const client = makeClient(identityA, server)
    const subscription = { endpoint, toJSON: () => ({ endpoint }), unsubscribe: vi.fn(async () => true) }
    installBrowser(subscription)
    state.activeClient = client

    await expect(tab.disableDevicePush(employeeA)).rejects.toThrow('now owned by another')
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(server.owner).toMatchObject({ ...identityB, enabled: true })
  })
})

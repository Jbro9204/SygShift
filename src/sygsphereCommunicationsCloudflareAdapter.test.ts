import { describe, expect, it, vi } from 'vitest'
import {
  CloudflareRealtimeHttpAdapter,
  createCloudflareRealtimeRuntimeAdapter,
} from '../worker/comms/cloudflareRealtimeAdapter'
import {
  activateProviderSession,
  createProviderSession,
  registerProviderTrack,
} from '../worker/comms/providerSessionRegistry'

const offer = { sdp: 'v=0\r\na=group:BUNDLE 0\r\n', type: 'offer' as const }
const answer = { sdp: 'v=0\r\na=group:BUNDLE 0\r\n', type: 'answer' as const }
const session = () => activateProviderSession(createProviderSession('session-1', 'tenant-1'))
const sessionWithAudio = () => registerProviderTrack(session(), { id: 'audio-1', kind: 'audio', mid: '0', state: 'active' })

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
})

const asRequest = (value: unknown): Request => {
  expect(value).toBeInstanceOf(Request)
  return value as Request
}

const requestJson = async (request: Request): Promise<unknown> => JSON.parse(await request.clone().text())

const testAdapter = (fetchImplementation: typeof fetch): CloudflareRealtimeHttpAdapter => new CloudflareRealtimeHttpAdapter({
  appId: 'app-1',
  appSecret: 'server-only-app-secret',
  fetchImplementation,
  mayCallProvider: true,
  turnApiToken: 'server-only-turn-token',
  turnKeyId: 'turn-key-1',
})

describe('SygSphere Communications Cloudflare Realtime adapter', () => {
  it('constructs the concrete adapter only when the independent runtime and release gates agree', async () => {
    const runtime = createCloudflareRealtimeRuntimeAdapter({
      appId: 'app-1',
      appSecret: 'server-only-app-secret',
      coordinatorReleaseMayDispatch: true,
      runtimeEnabled: true,
    })
    expect(runtime).toBeInstanceOf(CloudflareRealtimeHttpAdapter)
    await expect(runtime.execute({ operation: 'create_session', requestId: 'request-1', roomId: 'room-1', tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'provider_unavailable', requestId: 'request-1' })
  })

  it('does not call a provider without the explicit internal test/release allowance', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const adapter = new CloudflareRealtimeHttpAdapter({
      appId: 'app-1', appSecret: 'server-only-app-secret', fetchImplementation, mayCallProvider: false,
    })
    await expect(adapter.createSession({ tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('creates sessions only from server-owned input and calls the documented provider endpoint', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ sessionDescription: answer, sessionId: 'provider-session-1' }))
    const result = await testAdapter(fetchImplementation).createSession({ sessionDescription: offer, tenantId: 'tenant-1' })

    expect(result).toEqual({ outcome: 'accepted', value: { sessionDescription: answer, sessionId: 'provider-session-1' } })
    const request = asRequest(fetchImplementation.mock.calls[0]?.[0])
    expect(request.url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/new')
    expect(request.method).toBe('POST')
    expect(request.redirect).toBe('error')
    expect(request.headers.get('authorization')).toBe('Bearer server-only-app-secret')
    await expect(requestJson(request)).resolves.toEqual({ sessionDescription: offer })
  })

  it('requires an active tenant-owned registry session and validates every returned track binding', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      requiresImmediateRenegotiation: true,
      sessionDescription: answer,
      tracks: [{ mid: '0', trackName: 'audio-1' }],
    }))
    const adapter = testAdapter(fetchImplementation)
    const rejected = await adapter.publishTracks({
      session: session(), tenantId: 'other-tenant', tracks: [{ kind: 'audio', location: 'local', trackName: 'audio-1' }],
    })
    expect(rejected).toEqual({ outcome: 'provider_rejected', reconciliationRequired: false })
    expect(fetchImplementation).not.toHaveBeenCalled()

    const accepted = await adapter.publishTracks({
      session: session(), sessionDescription: offer, tenantId: 'tenant-1', tracks: [{ kind: 'audio', location: 'local', trackName: 'audio-1' }],
    })
    expect(accepted).toMatchObject({ outcome: 'accepted', value: { requiresImmediateRenegotiation: true, tracks: [{ mid: '0', trackName: 'audio-1' }] } })
    expect(asRequest(fetchImplementation.mock.calls[0]?.[0]).url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/tracks/new')

    fetchImplementation.mockResolvedValueOnce(jsonResponse({ tracks: [{ location: 'local', trackName: 'audio-1' }] }))
    await expect(adapter.updateTracks({
      session: session(), tenantId: 'tenant-1', tracks: [{ kind: 'audio', location: 'local', trackName: 'audio-1' }],
    })).resolves.toEqual({ outcome: 'provider_rejected', reconciliationRequired: false })
  })

  it('uses the server-owned remote source for subscriptions and requires an explicit renegotiation response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        requiresImmediateRenegotiation: true,
        sessionDescription: offer,
        tracks: [{ mid: '1', sessionId: 'publisher-session-1', trackName: 'remote-audio-1' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ sessionDescription: answer }))
    const adapter = testAdapter(fetchImplementation)
    await expect(adapter.subscribeTracks({
      session: session(), tenantId: 'tenant-1', tracks: [{ kind: 'audio', location: 'remote', sessionId: 'publisher-session-1', trackName: 'remote-audio-1' }],
    })).resolves.toMatchObject({
      outcome: 'accepted',
      value: {
        requiresImmediateRenegotiation: true,
        sessionDescription: offer,
        tracks: [{ mid: '1', trackName: 'remote-audio-1' }],
      },
    })
    await expect(requestJson(asRequest(fetchImplementation.mock.calls[0]?.[0]))).resolves.toEqual({
      tracks: [{ kind: 'audio', location: 'remote', sessionId: 'publisher-session-1', trackName: 'remote-audio-1' }],
    })
    await expect(adapter.renegotiate({ session: session(), sessionDescription: answer, tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'accepted', value: { sessionDescription: answer } })
    expect(asRequest(fetchImplementation.mock.calls[1]?.[0]).url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/renegotiate')
  })

  it('updates and inspects only the coordinator-owned provider session', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        requiresImmediateRenegotiation: false,
        tracks: [{ mid: '0', trackName: 'audio-1' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        tracks: [{ mid: '0', trackName: 'audio-1' }],
      }))
    const adapter = testAdapter(fetchImplementation)
    await expect(adapter.updateTracks({
      session: sessionWithAudio(), tenantId: 'tenant-1', tracks: [{ kind: 'audio', location: 'local', mid: '0', trackName: 'audio-1' }],
    })).resolves.toMatchObject({ outcome: 'accepted', value: { tracks: [{ mid: '0', trackName: 'audio-1' }] } })
    expect(asRequest(fetchImplementation.mock.calls[0]?.[0]).url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/tracks/update')

    await expect(adapter.inspectSession({ session: sessionWithAudio(), tenantId: 'tenant-1' }))
      .resolves.toMatchObject({ outcome: 'accepted', value: { tracks: [{ mid: '0', trackName: 'audio-1' }] } })
    const inspectRequest = asRequest(fetchImplementation.mock.calls[1]?.[0])
    expect(inspectRequest.url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1')
    expect(inspectRequest.method).toBe('GET')
  })

  it('fails closed before calling the provider when location-less responses could make track matching ambiguous', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const adapter = testAdapter(fetchImplementation)
    await expect(adapter.updateTracks({
      session: sessionWithAudio(),
      tenantId: 'tenant-1',
      tracks: [
        { kind: 'audio', location: 'local', mid: '0', trackName: 'shared-audio' },
        { kind: 'audio', location: 'remote', mid: '1', sessionId: 'publisher-session-1', trackName: 'shared-audio' },
      ],
    })).resolves.toEqual({ outcome: 'provider_rejected', reconciliationRequired: false })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('force-closes only registered active track/MID pairs through the provider endpoint', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ requiresImmediateRenegotiation: false, tracks: [{ mid: '0' }] }))
    const adapter = testAdapter(fetchImplementation)
    await expect(adapter.forceCloseTracks({ session: sessionWithAudio(), tenantId: 'tenant-1', tracks: [{ mid: 'different', trackId: 'audio-1' }] }))
      .resolves.toEqual({ outcome: 'provider_rejected', reconciliationRequired: false })
    expect(fetchImplementation).not.toHaveBeenCalled()

    await expect(adapter.forceCloseTracks({ session: sessionWithAudio(), tenantId: 'tenant-1', tracks: [{ mid: '0', trackId: 'audio-1' }] }))
      .resolves.toEqual({ outcome: 'accepted', value: { requiresImmediateRenegotiation: false } })
    const request = asRequest(fetchImplementation.mock.calls[0]?.[0])
    expect(request.url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/tracks/close')
    await expect(requestJson(request)).resolves.toEqual({ force: true, tracks: [{ mid: '0' }] })
  })

  it('returns an ambiguous outcome after a timeout so the coordinator must inspect before retrying', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(timeout)
    await expect(testAdapter(fetchImplementation).renegotiate({ session: session(), sessionDescription: answer, tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'ambiguous_timeout', reconciliationRequired: true })
  })

  it('keeps request construction failures separate from transport failures without logging request data', async () => {
    const diagnosticLogger = vi.fn()
    const unsafeOnlyForRequestConstructionTest = 'server-only-app-secret\u0000must-not-leak'
    const fetchImplementation = vi.fn<typeof fetch>()
    const adapter = new CloudflareRealtimeHttpAdapter({
      appId: 'app-1',
      appSecret: unsafeOnlyForRequestConstructionTest,
      diagnosticLogger,
      fetchImplementation,
      mayCallProvider: true,
    })

    await expect(adapter.createSession({ tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(diagnosticLogger).toHaveBeenCalledWith({
      event: 'sygsphere_communications_provider_failure',
      failureClass: 'request_initialization',
      operation: 'session_create',
      outcome: 'provider_unavailable',
      requestInitializationCause: 'authorization_header',
    })
    const logged = JSON.stringify(diagnosticLogger.mock.calls)
    expect(logged).not.toContain('must-not-leak')
    expect(logged).not.toContain('tenant-1')
    expect(logged).not.toContain('rtc.live.cloudflare.com')
  })

  it('classifies a timeout-signal construction failure without retaining error details', async () => {
    const diagnosticLogger = vi.fn()
    const fetchImplementation = vi.fn<typeof fetch>()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      throw new Error('timeout implementation detail must not leak')
    })
    try {
      const adapter = new CloudflareRealtimeHttpAdapter({
        appId: 'app-1',
        appSecret: 'server-only-app-secret',
        diagnosticLogger,
        fetchImplementation,
        mayCallProvider: true,
      })

      await expect(adapter.createSession({ tenantId: 'tenant-1' }))
        .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
      expect(fetchImplementation).not.toHaveBeenCalled()
      expect(diagnosticLogger).toHaveBeenCalledWith({
        event: 'sygsphere_communications_provider_failure',
        failureClass: 'request_initialization',
        operation: 'session_create',
        outcome: 'provider_unavailable',
        requestInitializationCause: 'abort_signal',
      })
      const logged = JSON.stringify(diagnosticLogger.mock.calls)
      expect(logged).not.toContain('timeout implementation detail')
      expect(logged).not.toContain('server-only-app-secret')
      expect(logged).not.toContain('tenant-1')
    } finally {
      timeout.mockRestore()
    }
  })

  it('classifies a malformed TURN authorization token without retaining token content', async () => {
    const diagnosticLogger = vi.fn()
    const fetchImplementation = vi.fn<typeof fetch>()
    const unsafeOnlyForTurnHeaderTest = 'server-only-turn-token\u0000must-not-leak'
    const adapter = new CloudflareRealtimeHttpAdapter({
      appId: 'app-1',
      appSecret: 'server-only-app-secret',
      diagnosticLogger,
      fetchImplementation,
      mayCallProvider: true,
      turnApiToken: unsafeOnlyForTurnHeaderTest,
      turnKeyId: 'turn-key-1',
    })

    await expect(adapter.generateIceServers(60))
      .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(diagnosticLogger).toHaveBeenCalledWith({
      event: 'sygsphere_communications_provider_failure',
      failureClass: 'request_initialization',
      operation: 'turn_credentials',
      outcome: 'provider_unavailable',
      requestInitializationCause: 'authorization_header',
    })
    const logged = JSON.stringify(diagnosticLogger.mock.calls)
    expect(logged).not.toContain('must-not-leak')
    expect(logged).not.toContain('server-only-turn-token')
    expect(logged).not.toContain('turn-key-1')
    expect(logged).not.toContain('rtc.live.cloudflare.com')
  })

  it('classifies a Request constructor failure without retaining request data', async () => {
    const diagnosticLogger = vi.fn()
    const fetchImplementation = vi.fn<typeof fetch>()
    vi.stubGlobal('Request', class {
      constructor() {
        throw new Error('request implementation detail must not leak')
      }
    })
    try {
      const adapter = new CloudflareRealtimeHttpAdapter({
        appId: 'app-1',
        appSecret: 'server-only-app-secret',
        diagnosticLogger,
        fetchImplementation,
        mayCallProvider: true,
      })

      await expect(adapter.createSession({ tenantId: 'tenant-1' }))
        .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
      expect(fetchImplementation).not.toHaveBeenCalled()
      expect(diagnosticLogger).toHaveBeenCalledWith({
        event: 'sygsphere_communications_provider_failure',
        failureClass: 'request_initialization',
        operation: 'session_create',
        outcome: 'provider_unavailable',
        requestInitializationCause: 'request_constructor',
      })
      const logged = JSON.stringify(diagnosticLogger.mock.calls)
      expect(logged).not.toContain('request implementation detail')
      expect(logged).not.toContain('server-only-app-secret')
      expect(logged).not.toContain('tenant-1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('maps known Worker subrequest failures to a fixed diagnostic value without exposing exception data', async () => {
    const diagnosticLogger = vi.fn()
    const rawFailure = new Error('Worker cannot make a subrequest to a Cloudflare-owned IP address; url=https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/provider-session-9 Authorization: Bearer confidential-token body={"employee":"employee-123"}')
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(rawFailure)
    const adapter = new CloudflareRealtimeHttpAdapter({
      appId: 'app-1',
      appSecret: 'server-only-app-secret',
      diagnosticLogger,
      fetchImplementation,
      mayCallProvider: true,
    })

    await expect(adapter.createSession({ tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
    expect(diagnosticLogger).toHaveBeenCalledWith({
      event: 'sygsphere_communications_provider_failure',
      failureClass: 'transport',
      operation: 'session_create',
      outcome: 'provider_unavailable',
      transportCause: 'cloudflare_subrequest',
    })
    const logged = JSON.stringify(diagnosticLogger.mock.calls)
    expect(logged).not.toContain('confidential-token')
    expect(logged).not.toContain('employee-123')
    expect(logged).not.toContain('provider-session-9')
    expect(logged).not.toContain('Authorization')
    expect(logged).not.toContain('rtc.live.cloudflare.com')
    expect(logged).not.toContain('tenant-1')
    expect(logged).not.toContain('Cloudflare-owned IP')
  })

  it('emits only sanitized server-side failure diagnostics', async () => {
    const diagnosticLogger = vi.fn()
    const adapter = new CloudflareRealtimeHttpAdapter({
      appId: 'app-1',
      appSecret: 'server-only-app-secret',
      diagnosticLogger,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ errorCode: 'provider-detail-must-not-leak' }, 401)),
      mayCallProvider: true,
      turnApiToken: 'server-only-turn-token',
      turnKeyId: 'turn-key-1',
    })

    await expect(adapter.createSession({ tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'provider_rejected', reconciliationRequired: false })
    expect(diagnosticLogger).toHaveBeenCalledWith({
      event: 'sygsphere_communications_provider_failure',
      failureClass: 'http',
      httpStatus: 401,
      operation: 'session_create',
      outcome: 'provider_rejected',
    })
    const logged = JSON.stringify(diagnosticLogger.mock.calls)
    expect(logged).not.toContain('server-only-app-secret')
    expect(logged).not.toContain('server-only-turn-token')
    expect(logged).not.toContain('provider-detail-must-not-leak')
    expect(logged).not.toContain('tenant-1')

    const unavailable = new CloudflareRealtimeHttpAdapter({
      appId: 'app-1', appSecret: 'server-only-app-secret', diagnosticLogger, mayCallProvider: true,
    })
    await expect(unavailable.generateIceServers(300))
      .resolves.toEqual({ outcome: 'provider_unavailable', reconciliationRequired: false })
    expect(diagnosticLogger).toHaveBeenLastCalledWith({
      event: 'sygsphere_communications_provider_failure',
      failureClass: 'configuration',
      operation: 'turn_credentials',
      outcome: 'provider_unavailable',
    })
  })

  it('generates short-lived TURN credentials server-side and filters browser-blocked port 53 URLs', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      iceServers: [{
        credential: 'short-lived-client-credential',
        urls: ['turn:turn.cloudflare.com:53?transport=tcp', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'short-lived-client-name',
      }],
    }, 201))
    const result = await testAdapter(fetchImplementation).generateIceServers(3_600)
    expect(result).toEqual({
      outcome: 'accepted',
      value: {
        iceServers: [{
          credential: 'short-lived-client-credential',
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'short-lived-client-name',
        }],
      },
    })
    const request = asRequest(fetchImplementation.mock.calls[0]?.[0])
    expect(request.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-1/credentials/generate-ice-servers')
    expect(request.headers.get('authorization')).toBe('Bearer server-only-turn-token')
    expect(request.url).not.toContain('server-only-turn-token')
  })
})

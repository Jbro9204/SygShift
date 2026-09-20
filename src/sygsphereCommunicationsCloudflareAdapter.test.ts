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
    const [url, init] = fetchImplementation.mock.calls[0] ?? []
    expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/new')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-only-app-secret')
    expect(JSON.parse(String(init?.body))).toEqual({ sessionDescription: offer })
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
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/tracks/new')

    fetchImplementation.mockResolvedValueOnce(jsonResponse({ tracks: [{ location: 'local', trackName: 'audio-1' }] }))
    await expect(adapter.updateTracks({
      session: session(), tenantId: 'tenant-1', tracks: [{ kind: 'audio', location: 'local', trackName: 'audio-1' }],
    })).resolves.toEqual({ outcome: 'provider_rejected', reconciliationRequired: false })
  })

  it('uses the server-owned remote source for subscriptions and requires an explicit renegotiation response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ tracks: [{ mid: '1', sessionId: 'publisher-session-1', trackName: 'remote-audio-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ sessionDescription: answer }))
    const adapter = testAdapter(fetchImplementation)
    await expect(adapter.subscribeTracks({
      session: session(), tenantId: 'tenant-1', tracks: [{ location: 'remote', sessionId: 'publisher-session-1', trackName: 'remote-audio-1' }],
    })).resolves.toMatchObject({ outcome: 'accepted', value: { tracks: [{ mid: '1', trackName: 'remote-audio-1' }] } })
    await expect(adapter.renegotiate({ session: session(), sessionDescription: answer, tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'accepted', value: { sessionDescription: answer } })
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/renegotiate')
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
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/tracks/update')

    await expect(adapter.inspectSession({ session: sessionWithAudio(), tenantId: 'tenant-1' }))
      .resolves.toMatchObject({ outcome: 'accepted', value: { tracks: [{ mid: '0', trackName: 'audio-1' }] } })
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1')
    expect(fetchImplementation.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' })
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
    const [url, init] = fetchImplementation.mock.calls[0] ?? []
    expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/apps/app-1/sessions/session-1/tracks/close')
    expect(JSON.parse(String(init?.body))).toEqual({ force: true, tracks: [{ mid: '0' }] })
  })

  it('returns an ambiguous outcome after a timeout so the coordinator must inspect before retrying', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(timeout)
    await expect(testAdapter(fetchImplementation).renegotiate({ session: session(), sessionDescription: answer, tenantId: 'tenant-1' }))
      .resolves.toEqual({ outcome: 'ambiguous_timeout', reconciliationRequired: true })
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
    const [url, init] = fetchImplementation.mock.calls[0] ?? []
    expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-1/credentials/generate-ice-servers')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-only-turn-token')
    expect(String(url)).not.toContain('server-only-turn-token')
  })
})

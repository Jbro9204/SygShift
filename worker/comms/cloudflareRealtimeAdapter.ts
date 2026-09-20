import {
  providerSessionMayMutate,
  providerTrackMayMutate,
  type ProviderSession,
} from './providerSessionRegistry'

/**
 * This constant is a source-controlled release brake. Environment variables
 * cannot override it. A reviewed source change plus all existing release
 * evidence is required before this adapter may make a provider request.
 */
/* The source boundary is now reviewed. Runtime use still requires the
 * independently-verified release gate plus configured server-only secrets. */
export const SYGSPHERE_COMMS_CLOUDFLARE_REALTIME_ADAPTER_RELEASED = true as const

const realtimeApiOrigin = 'https://rtc.live.cloudflare.com/v1'
// Cloudflare SFU operations may wait up to five seconds for a peer to reach a
// connected state. Allow network and Worker overhead around that provider wait.
const providerRequestTimeoutMs = 15_000
const maximumProviderResponseBytes = 131_072
const minimumTurnCredentialTtlSeconds = 60
const maximumTurnCredentialTtlSeconds = 86_400

export type SygSphereCommsProviderOperation =
  | 'create_session'
  | 'publish_track'
  | 'subscribe_track'
  | 'force_close_track'
  | 'close_session'

export type SygSphereCommsProviderRequest = Readonly<{
  operation: SygSphereCommsProviderOperation
  requestId: string
  roomId: string
  tenantId: string
}>

export type SygSphereCommsProviderResult = Readonly<{
  outcome: 'provider_unavailable'
  requestId: string
}>

export interface SygSphereCommsProviderAdapter {
  /**
   * Generic dispatch is deliberately closed. Browser commands never select a
   * Cloudflare operation. A future coordinator must use one of the typed,
   * server-owned methods below after authorization and scope resolution.
   */
  execute(request: SygSphereCommsProviderRequest): Promise<SygSphereCommsProviderResult>
}

/** A closed adapter is the only runtime adapter that may be constructed today. */
export const closedCloudflareRealtimeAdapter: SygSphereCommsProviderAdapter = Object.freeze({
  async execute(request: SygSphereCommsProviderRequest): Promise<SygSphereCommsProviderResult> {
    return { outcome: 'provider_unavailable' as const, requestId: request.requestId }
  },
})

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ProviderSessionDescription = Readonly<{
  sdp: string
  type: 'answer' | 'offer'
}>

export type CloudflareRealtimeTrack = Readonly<{
  bidirectionalMediaStream?: boolean
  kind?: 'audio' | 'video'
  location: 'local' | 'remote'
  mid?: string
  /** Required for remote tracks and issued by a prior provider response. */
  sessionId?: string
  trackName: string
}>

export type CloudflareRealtimeTrackResponse = Readonly<{
  location: 'local' | 'remote'
  mid: string
  sessionId?: string
  trackName: string
}>

export type CloudflareIceServer = Readonly<{
  credential?: string
  urls: readonly string[]
  username?: string
}>

export type CloudflareProviderFailure = Readonly<{
  outcome: 'ambiguous_timeout' | 'provider_rejected' | 'provider_unavailable'
  reconciliationRequired: boolean
}>

export type CloudflareProviderSuccess<T> = Readonly<{
  outcome: 'accepted'
  value: T
}>

export type CloudflareProviderResult<T> = CloudflareProviderFailure | CloudflareProviderSuccess<T>

export type CloudflareRealtimeAdapterConfiguration = Readonly<{
  appId: string
  /** Server-only App secret. It is never returned, logged, or persisted. */
  appSecret: string
  fetchImplementation?: ProviderFetch
  /** Allows isolated mock tests only; runtime construction is separately gated. */
  mayCallProvider: boolean
  turnApiToken?: string
  turnKeyId?: string
}>

export type CloudflareRealtimeRuntimeConfiguration = Readonly<{
  appId?: string
  appSecret?: string
  coordinatorReleaseMayDispatch: boolean
  runtimeEnabled: boolean
  turnApiToken?: string
  turnKeyId?: string
}>

export type CloudflareCreateSessionRequest = Readonly<{
  /** Resolved by the coordinator, not transported from the browser. */
  tenantId: string
  sessionDescription?: ProviderSessionDescription
}>

export type CloudflareTracksRequest = Readonly<{
  session: ProviderSession
  sessionDescription?: ProviderSessionDescription
  tenantId: string
  tracks: readonly CloudflareRealtimeTrack[]
}>

export type CloudflareCloseTracksRequest = Readonly<{
  session: ProviderSession
  tenantId: string
  tracks: readonly Readonly<{ mid: string, trackId: string }>[]
}>

export type CloudflareRenegotiateRequest = Readonly<{
  session: ProviderSession
  sessionDescription: ProviderSessionDescription
  tenantId: string
}>

export type CloudflareSessionInspection = Readonly<{
  session: ProviderSession
  tenantId: string
}>

const hasText = (value: string, maximum = 128): boolean => value.trim().length > 0 && value.length <= maximum

const isSafeReference = (value: string, maximum = 128): boolean =>
  hasText(value, maximum) && /^[A-Za-z0-9._:-]+$/.test(value)

const isSessionDescription = (value: unknown): value is ProviderSessionDescription => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ProviderSessionDescription>
  return (candidate.type === 'offer' || candidate.type === 'answer')
    && typeof candidate.sdp === 'string'
    && candidate.sdp.length > 0
    && candidate.sdp.length <= 65_536
}

const isCloudflareTrack = (value: unknown): value is CloudflareRealtimeTrack => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CloudflareRealtimeTrack>
  return (candidate.location === 'local' || candidate.location === 'remote')
    && typeof candidate.trackName === 'string'
    && isSafeReference(candidate.trackName)
    && (candidate.mid === undefined || (typeof candidate.mid === 'string' && isSafeReference(candidate.mid, 64)))
    && (candidate.sessionId === undefined || (typeof candidate.sessionId === 'string' && isSafeReference(candidate.sessionId)))
    && (candidate.kind === undefined || candidate.kind === 'audio' || candidate.kind === 'video')
    && (candidate.bidirectionalMediaStream === undefined || typeof candidate.bidirectionalMediaStream === 'boolean')
    && (candidate.location === 'local' || typeof candidate.sessionId === 'string')
}

/**
 * Cloudflare's successful track responses may omit `location`.  We therefore
 * cannot safely correlate two requested tracks that share a name even when
 * their requested locations differ: either response could otherwise satisfy
 * both requests.  Reject that ambiguous server-owned request before it reaches
 * the provider.
 */
const hasUniqueTrackNames = (tracks: readonly CloudflareRealtimeTrack[]): boolean =>
  new Set(tracks.map((track) => track.trackName)).size === tracks.length

const isProviderTimeout = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError' || error.name === 'TimeoutError'
    : typeof error === 'object'
      && error !== null
      && 'name' in error
      && ((error as { name?: unknown }).name === 'AbortError' || (error as { name?: unknown }).name === 'TimeoutError')

const boundedJson = async (response: Response): Promise<unknown | null> => {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > maximumProviderResponseBytes) return null
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumProviderResponseBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } catch {
    return null
  }
  const bytes = chunks.length === 1
    ? chunks[0] ?? new Uint8Array()
    : (() => {
      const output = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      return output
    })()
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

const hasProviderError = (body: unknown): boolean =>
  Boolean(body && typeof body === 'object' && typeof (body as { errorCode?: unknown }).errorCode === 'string')

const safeProviderPath = (...segments: string[]): string =>
  `${realtimeApiOrigin}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`

const typedTrackResponses = (
  body: unknown,
  requested: readonly CloudflareRealtimeTrack[],
): readonly CloudflareRealtimeTrackResponse[] | null => {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { tracks?: unknown }).tracks)) return null
  const tracks = (body as { tracks: unknown[] }).tracks
  if (tracks.length !== requested.length || hasProviderError(body)) return null
  const responses: CloudflareRealtimeTrackResponse[] = []
  for (const request of requested) {
    const matching = tracks.find((item) => {
      if (!item || typeof item !== 'object') return false
      const candidate = item as Partial<CloudflareRealtimeTrackResponse> & { errorCode?: unknown }
      return candidate.trackName === request.trackName
        && (candidate.location === undefined || candidate.location === request.location)
    })
    if (!matching || typeof matching !== 'object') return null
    const candidate = matching as Partial<CloudflareRealtimeTrackResponse> & { errorCode?: unknown }
    if (typeof candidate.errorCode === 'string' || typeof candidate.mid !== 'string' || !isSafeReference(candidate.mid, 64)) return null
    if (candidate.location !== undefined && candidate.location !== request.location) return null
    if (candidate.sessionId !== undefined && (typeof candidate.sessionId !== 'string' || !isSafeReference(candidate.sessionId))) return null
    responses.push({ location: request.location, mid: candidate.mid, sessionId: candidate.sessionId, trackName: request.trackName })
  }
  return responses
}

const typedSessionDescription = (body: unknown): ProviderSessionDescription | null => {
  if (!body || typeof body !== 'object') return null
  const description = (body as { sessionDescription?: unknown }).sessionDescription
  return isSessionDescription(description) ? description : null
}

const typedIceServers = (body: unknown): readonly CloudflareIceServer[] | null => {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { iceServers?: unknown }).iceServers)) return null
  const servers: CloudflareIceServer[] = []
  for (const source of (body as { iceServers: unknown[] }).iceServers) {
    if (!source || typeof source !== 'object') return null
    const candidate = source as { credential?: unknown, urls?: unknown, username?: unknown }
    const urls = typeof candidate.urls === 'string' ? [candidate.urls] : candidate.urls
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8 || urls.some((url) => typeof url !== 'string' || url.length === 0 || url.length > 256 || !/^(stun|turn|turns):/i.test(url))) return null
    // Port 53 is known to time out in browsers. Preserve all other returned
    // UDP/TCP/TLS endpoints and fail closed if filtering leaves none.
    const browserSafeUrls = urls.filter((url) => !/:53(?:[/?]|$)/.test(url)) as string[]
    if (!browserSafeUrls.length) return null
    if (candidate.username !== undefined && (typeof candidate.username !== 'string' || candidate.username.length === 0 || candidate.username.length > 256)) return null
    if (candidate.credential !== undefined && (typeof candidate.credential !== 'string' || candidate.credential.length === 0 || candidate.credential.length > 512)) return null
    servers.push({ credential: candidate.credential as string | undefined, urls: browserSafeUrls, username: candidate.username as string | undefined })
  }
  return servers.length ? servers : null
}

/**
 * Concrete server-only Cloudflare Realtime transport. This class is not
 * reachable from browser commands; production construction below remains
 * source-gated. The optional test construction path supports mocked HTTP only.
 */
export class CloudflareRealtimeHttpAdapter implements SygSphereCommsProviderAdapter {
  private readonly configuration: CloudflareRealtimeAdapterConfiguration

  constructor(configuration: CloudflareRealtimeAdapterConfiguration) {
    this.configuration = configuration
  }

  async execute(request: SygSphereCommsProviderRequest): Promise<SygSphereCommsProviderResult> {
    return { outcome: 'provider_unavailable', requestId: request.requestId }
  }

  private isConfigured(): boolean {
    return this.configuration.mayCallProvider
      && isSafeReference(this.configuration.appId)
      && hasText(this.configuration.appSecret, 512)
  }

  private async request(
    path: string,
    init: Readonly<{ body?: Readonly<Record<string, unknown>>, method: 'GET' | 'POST' | 'PUT' }>,
    token = this.configuration.appSecret,
  ): Promise<CloudflareProviderResult<unknown>> {
    if (!this.isConfigured() || !hasText(token, 512)) {
      return { outcome: 'provider_unavailable', reconciliationRequired: false }
    }
    try {
      const response = await (this.configuration.fetchImplementation ?? fetch)(path, {
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        method: init.method,
        redirect: 'error',
        signal: AbortSignal.timeout(providerRequestTimeoutMs),
      })
      if (!response.ok) return { outcome: 'provider_rejected', reconciliationRequired: false }
      const body = await boundedJson(response)
      return body === null || hasProviderError(body)
        ? { outcome: 'provider_rejected', reconciliationRequired: false }
        : { outcome: 'accepted', value: body }
    } catch (error) {
      return isProviderTimeout(error)
        ? { outcome: 'ambiguous_timeout', reconciliationRequired: true }
        : { outcome: 'provider_unavailable', reconciliationRequired: false }
    }
  }

  async createSession(input: CloudflareCreateSessionRequest): Promise<CloudflareProviderResult<Readonly<{
    sessionDescription?: ProviderSessionDescription
    sessionId: string
  }>>> {
    if (!isSafeReference(input.tenantId)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    if (input.sessionDescription !== undefined && !isSessionDescription(input.sessionDescription)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const result = await this.request(safeProviderPath('apps', this.configuration.appId, 'sessions', 'new'), {
      body: input.sessionDescription === undefined ? {} : { sessionDescription: input.sessionDescription }, method: 'POST',
    })
    if (result.outcome !== 'accepted') return result
    const body = result.value
    if (!body || typeof body !== 'object') return { outcome: 'provider_rejected', reconciliationRequired: false }
    const sessionId = (body as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || !isSafeReference(sessionId)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const sessionDescription = typedSessionDescription(body) ?? undefined
    return { outcome: 'accepted', value: { sessionDescription, sessionId } }
  }

  private async addTracks(
    input: CloudflareTracksRequest,
    operation: 'publish' | 'subscribe',
  ): Promise<CloudflareProviderResult<Readonly<{
    requiresImmediateRenegotiation: boolean
    sessionDescription?: ProviderSessionDescription
    tracks: readonly CloudflareRealtimeTrackResponse[]
  }>>> {
    if (!providerSessionMayMutate(input.session, input.tenantId) || input.tracks.length === 0 || input.tracks.length > 16 || !hasUniqueTrackNames(input.tracks) || input.tracks.some((track) => !isCloudflareTrack(track))) {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    if (operation === 'publish' && input.tracks.some((track) => track.location !== 'local')) return { outcome: 'provider_rejected', reconciliationRequired: false }
    if (operation === 'subscribe' && input.tracks.some((track) => track.location !== 'remote' || !track.sessionId)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    if (input.sessionDescription !== undefined && !isSessionDescription(input.sessionDescription)) return { outcome: 'provider_rejected', reconciliationRequired: false }

    const result = await this.request(safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'tracks', 'new'), {
      body: {
        ...(input.sessionDescription === undefined ? {} : { sessionDescription: input.sessionDescription }),
        tracks: input.tracks,
      },
      method: 'POST',
    })
    if (result.outcome !== 'accepted') return result
    const tracks = typedTrackResponses(result.value, input.tracks)
    if (!tracks) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const requiresImmediateRenegotiation = (result.value as { requiresImmediateRenegotiation?: unknown }).requiresImmediateRenegotiation
    if (requiresImmediateRenegotiation !== undefined && typeof requiresImmediateRenegotiation !== 'boolean') {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    return {
      outcome: 'accepted',
      value: { requiresImmediateRenegotiation: requiresImmediateRenegotiation === true, sessionDescription: typedSessionDescription(result.value) ?? undefined, tracks },
    }
  }

  publishTracks(input: CloudflareTracksRequest) {
    return this.addTracks(input, 'publish')
  }

  subscribeTracks(input: CloudflareTracksRequest) {
    return this.addTracks(input, 'subscribe')
  }

  async updateTracks(input: CloudflareTracksRequest): Promise<CloudflareProviderResult<Readonly<{
    requiresImmediateRenegotiation: boolean
    tracks: readonly CloudflareRealtimeTrackResponse[]
  }>>> {
    if (!providerSessionMayMutate(input.session, input.tenantId) || input.tracks.length === 0 || input.tracks.length > 16 || !hasUniqueTrackNames(input.tracks) || input.tracks.some((track) => !isCloudflareTrack(track))) {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    const result = await this.request(safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'tracks', 'update'), {
      body: {
        ...(input.sessionDescription === undefined ? {} : { sessionDescription: input.sessionDescription }),
        tracks: input.tracks,
      },
      method: 'PUT',
    })
    if (result.outcome !== 'accepted') return result
    const tracks = typedTrackResponses(result.value, input.tracks)
    if (!tracks) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const requiresImmediateRenegotiation = (result.value as { requiresImmediateRenegotiation?: unknown }).requiresImmediateRenegotiation
    if (requiresImmediateRenegotiation !== undefined && typeof requiresImmediateRenegotiation !== 'boolean') {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    return { outcome: 'accepted', value: { requiresImmediateRenegotiation: requiresImmediateRenegotiation === true, tracks } }
  }

  async renegotiate(input: CloudflareRenegotiateRequest): Promise<CloudflareProviderResult<Readonly<{
    sessionDescription?: ProviderSessionDescription
  }>>> {
    if (!providerSessionMayMutate(input.session, input.tenantId) || !isSessionDescription(input.sessionDescription)) {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    const result = await this.request(safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'renegotiate'), {
      body: { sessionDescription: input.sessionDescription }, method: 'PUT',
    })
    if (result.outcome !== 'accepted') return result
    return { outcome: 'accepted', value: { sessionDescription: typedSessionDescription(result.value) ?? undefined } }
  }

  async forceCloseTracks(input: CloudflareCloseTracksRequest): Promise<CloudflareProviderResult<Readonly<{
    requiresImmediateRenegotiation: boolean
  }>>> {
    if (input.tracks.length === 0 || input.tracks.length > 16 || input.tracks.some((track) => !providerTrackMayMutate(input.session, input.tenantId, track.trackId, track.mid))) {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    const result = await this.request(safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'tracks', 'close'), {
      body: { force: true, tracks: input.tracks.map((track) => ({ mid: track.mid })) }, method: 'PUT',
    })
    if (result.outcome !== 'accepted') return result
    const requiresImmediateRenegotiation = (result.value as { requiresImmediateRenegotiation?: unknown }).requiresImmediateRenegotiation
    if (requiresImmediateRenegotiation !== undefined && typeof requiresImmediateRenegotiation !== 'boolean') {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    return { outcome: 'accepted', value: { requiresImmediateRenegotiation: requiresImmediateRenegotiation === true } }
  }

  async inspectSession(input: CloudflareSessionInspection): Promise<CloudflareProviderResult<Readonly<{
    tracks: readonly CloudflareRealtimeTrackResponse[]
  }>>> {
    if (!providerSessionMayMutate(input.session, input.tenantId)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const result = await this.request(safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id), { method: 'GET' })
    if (result.outcome !== 'accepted') return result
    const tracks = typedTrackResponses(result.value, [...input.session.tracks.values()].filter((track) => track.mid).map((track) => ({
      location: 'local' as const, mid: track.mid, trackName: track.id,
    })))
    return tracks === null
      ? { outcome: 'provider_rejected', reconciliationRequired: false }
      : { outcome: 'accepted', value: { tracks } }
  }

  async generateIceServers(ttlSeconds: number): Promise<CloudflareProviderResult<Readonly<{
    iceServers: readonly CloudflareIceServer[]
  }>>> {
    if (!this.configuration.turnKeyId || !this.configuration.turnApiToken || !Number.isInteger(ttlSeconds) || ttlSeconds < minimumTurnCredentialTtlSeconds || ttlSeconds > maximumTurnCredentialTtlSeconds) {
      return { outcome: 'provider_unavailable', reconciliationRequired: false }
    }
    const result = await this.request(
      safeProviderPath('turn', 'keys', this.configuration.turnKeyId, 'credentials', 'generate-ice-servers'),
      { body: { ttl: ttlSeconds }, method: 'POST' },
      this.configuration.turnApiToken,
    )
    if (result.outcome !== 'accepted') return result
    const iceServers = typedIceServers(result.value)
    return iceServers === null
      ? { outcome: 'provider_rejected', reconciliationRequired: false }
      : { outcome: 'accepted', value: { iceServers } }
  }
}

/**
 * Runtime assembly only. The source release boundary is reviewed, but this
 * factory remains unavailable until every runtime and database release gate
 * is satisfied. Secrets stay in memory and are never written into a browser
 * response, worker configuration, or log.
 */
export const createCloudflareRealtimeRuntimeAdapter = (
  configuration: CloudflareRealtimeRuntimeConfiguration,
): SygSphereCommsProviderAdapter => {
  return createCloudflareRealtimeRuntimeHttpAdapter(configuration) ?? closedCloudflareRealtimeAdapter
}

/** Typed construction path for the server-owned coordinator. Browser code
 * never receives this class, the application secret, or a provider handle. */
export const createCloudflareRealtimeRuntimeHttpAdapter = (
  configuration: CloudflareRealtimeRuntimeConfiguration,
): CloudflareRealtimeHttpAdapter | null => {
  if (!SYGSPHERE_COMMS_CLOUDFLARE_REALTIME_ADAPTER_RELEASED
    || !configuration.runtimeEnabled
    || !configuration.coordinatorReleaseMayDispatch
    || !configuration.appId
    || !configuration.appSecret) {
    return null
  }
  return new CloudflareRealtimeHttpAdapter({
    appId: configuration.appId,
    appSecret: configuration.appSecret,
    mayCallProvider: true,
    turnApiToken: configuration.turnApiToken,
    turnKeyId: configuration.turnKeyId,
  })
}

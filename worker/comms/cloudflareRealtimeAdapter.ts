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

/**
 * Server-only diagnostic vocabulary.  It intentionally excludes response
 * bodies, URLs, session IDs, track IDs, SDP, and credentials, so a live
 * failure can be investigated without copying provider or employee data into
 * the Worker logs.
 */
export type CloudflareProviderDiagnostic = Readonly<{
  event: 'sygsphere_communications_provider_failure'
  failureClass: 'configuration' | 'http' | 'invalid_response' | 'request_initialization' | 'timeout' | 'transport'
  httpStatus?: number
  operation: 'session_create' | 'session_inspect' | 'session_renegotiate' | 'track_close' | 'track_publish' | 'track_subscribe' | 'track_update' | 'turn_credentials'
  outcome: CloudflareProviderFailure['outcome']
  requestInitializationCause?: CloudflareProviderRequestInitializationCause
  transportCause?: CloudflareProviderTransportCause
}>

/**
 * Closed, server-only classification for a rejected provider fetch. It is
 * deliberately not an error message, provider response, URL, or identifier.
 */
export type CloudflareProviderTransportCause =
  | 'cloudflare_subrequest'
  | 'network_connection_lost'
  | 'other'
  | 'type_error'

/**
 * A closed diagnostic vocabulary for failures that happen before an outbound
 * provider request exists. It deliberately says nothing about a secret value,
 * header content, URL, request body, or provider response.
 */
export type CloudflareProviderRequestInitializationCause =
  | 'authorization_header'
  | 'redirect_mode'
  | 'request_core'
  | 'request_signal'

export type CloudflareProviderSuccess<T> = Readonly<{
  outcome: 'accepted'
  value: T
}>

export type CloudflareProviderResult<T> = CloudflareProviderFailure | CloudflareProviderSuccess<T>

export type CloudflareRealtimeAdapterConfiguration = Readonly<{
  appId: string
  /** Server-only App secret. It is never returned, logged, or persisted. */
  appSecret: string
  /** Optional test hook. Runtime defaults to a sanitized Worker log entry. */
  diagnosticLogger?: (diagnostic: CloudflareProviderDiagnostic) => void
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
  /**
   * Compatibility-only input retained for callers on the legacy shape. The
   * Realtime new-session endpoint requires an empty POST, so it is never
   * transported to the provider.
   */
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

/** A server-only inspection used only after a close result is ambiguous or
 * rejected. It can prove absence from a validated provider session response,
 * but it never returns provider identifiers to a browser. */
export type CloudflareTrackPresenceInspection = Readonly<{
  /** The stored provider track direction. A remote response must never be
   * treated as though it were a local browser publication. */
  location: 'local' | 'remote'
  mid: string
  session: ProviderSession
  tenantId: string
  trackId: string
}>

export type CloudflareRenegotiateRequest = Readonly<{
  session: ProviderSession
  sessionDescription: ProviderSessionDescription
  tenantId: string
}>

export type CloudflareSessionInspection = Readonly<{
  session: ProviderSession
  tenantId: string
  /** The coordinator must supply the stored direction for every track it
   * inspects. ProviderTrack intentionally does not infer this detail. */
  trackLocations: ReadonlyMap<string, 'local' | 'remote'>
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

/**
 * Map only documented Worker transport signatures to a fixed vocabulary.
 * The original exception is intentionally never returned, stored, or logged:
 * it can contain credentials, paths, provider payloads, or tenant details.
 */
const classifyProviderTransport = (error: unknown): CloudflareProviderTransportCause => {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? (error as { name?: unknown }).name
    : undefined
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (
    message.includes('cloudflare-owned ip')
    || message.includes('another worker')
    || message.includes('global_fetch_strictly_public')
    || message.includes('error 1024')
    || message.includes('error 1042')
  ) return 'cloudflare_subrequest'
  if (message.includes('network connection lost')) return 'network_connection_lost'
  return name === 'TypeError' ? 'type_error' : 'other'
}

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
    // A local publisher's MID identifies the exact browser transceiver that
    // produced the SDP offer. Never accept a response that rebinds this
    // coordinator-owned track name to another browser transceiver.
    if (request.location === 'local' && request.mid !== undefined && candidate.mid !== request.mid) return null
    if (candidate.sessionId !== undefined && (typeof candidate.sessionId !== 'string' || !isSafeReference(candidate.sessionId))) return null
    responses.push({ location: request.location, mid: candidate.mid, sessionId: candidate.sessionId, trackName: request.trackName })
  }
  return responses
}

/** A successful session inspection is useful only when every returned track
 * has the two server-issued references needed to identify it. This parser is
 * deliberately separate from mutation response validation: it proves whether
 * a specific stored track is still present, never exposes those references. */
const typedSessionTrackMetadata = (
  body: unknown,
): readonly Readonly<{ location: 'local' | 'remote', mid: string, trackName: string }>[] | null => {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { tracks?: unknown }).tracks) || hasProviderError(body)) return null
  const tracks: Readonly<{ location: 'local' | 'remote', mid: string, trackName: string }>[] = []
  for (const item of (body as { tracks: unknown[] }).tracks) {
    if (!item || typeof item !== 'object') return null
    const candidate = item as { location?: unknown, mid?: unknown, trackName?: unknown }
    if (
      (candidate.location !== 'local' && candidate.location !== 'remote')
      ||
      typeof candidate.mid !== 'string'
      || !isSafeReference(candidate.mid, 64)
      || typeof candidate.trackName !== 'string'
      || !isSafeReference(candidate.trackName)
    ) return null
    tracks.push({ location: candidate.location, mid: candidate.mid, trackName: candidate.trackName })
  }
  return tracks
}

/* A forced close may succeed for one requested track and fail for another.
 * The provider allows the response to omit `tracks` on a full success; if it
 * supplies track results, require every requested MID to be acknowledged and
 * reject any per-track provider error so the caller can reconcile safely. */
const closeTrackResponsesAreAccepted = (
  body: unknown,
  requested: readonly Readonly<{ mid: string }>[],
): boolean => {
  if (!body || typeof body !== 'object') return false
  const source = (body as { tracks?: unknown }).tracks
  if (source === undefined) return true
  if (!Array.isArray(source)) return false
  return source.every((item) => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as { errorCode?: unknown, errorDescription?: unknown }
    return candidate.errorCode === undefined && candidate.errorDescription === undefined
  }) && requested.every((requestedTrack) => source.some((item) => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as { errorCode?: unknown, errorDescription?: unknown, mid?: unknown }
    return candidate.mid === requestedTrack.mid
      && candidate.errorCode === undefined
      && candidate.errorDescription === undefined
  }))
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

  private reportFailure(
    operation: CloudflareProviderDiagnostic['operation'],
    failure: CloudflareProviderFailure,
    failureClass: CloudflareProviderDiagnostic['failureClass'],
    httpStatus?: number,
    transportCause?: CloudflareProviderTransportCause,
    requestInitializationCause?: CloudflareProviderRequestInitializationCause,
  ): CloudflareProviderFailure {
    const diagnostic: CloudflareProviderDiagnostic = {
      event: 'sygsphere_communications_provider_failure',
      failureClass,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      operation,
      outcome: failure.outcome,
      ...(requestInitializationCause === undefined ? {} : { requestInitializationCause }),
      ...(transportCause === undefined ? {} : { transportCause }),
    }
    try {
      if (this.configuration.diagnosticLogger) this.configuration.diagnosticLogger(diagnostic)
      else console.warn(JSON.stringify(diagnostic))
    } catch {
      // Observability must never alter a media lifecycle outcome.
    }
    return failure
  }

  private async request(
    operation: CloudflareProviderDiagnostic['operation'],
    path: string,
    init: Readonly<{ body?: Readonly<Record<string, unknown>>, method: 'GET' | 'POST' | 'PUT' }>,
    token = this.configuration.appSecret,
  ): Promise<CloudflareProviderResult<unknown>> {
    if (!this.isConfigured() || !hasText(token, 512)) {
      return this.reportFailure(operation, { outcome: 'provider_unavailable', reconciliationRequired: false }, 'configuration')
    }

    let headers: Headers
    try {
      headers = new Headers()
      headers.set('accept', 'application/json')
      headers.set('authorization', `Bearer ${token}`)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
    } catch {
      return this.reportFailure(
        operation,
        { outcome: 'provider_unavailable', reconciliationRequired: false },
        'request_initialization',
        undefined,
        undefined,
        'authorization_header',
      )
    }

    const coreRequestInit: RequestInit = {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers,
      method: init.method,
    }

    /*
     * Construct the same final request in deliberately isolated stages. This
     * does not issue a provider request until the final construction succeeds;
     * it only lets server-side diagnostics distinguish a Worker runtime
     * incompatibility from a provider rejection without retaining any request
     * material in logs.
     */
    try {
      new Request(path, coreRequestInit)
    } catch {
      return this.reportFailure(
        operation,
        { outcome: 'provider_unavailable', reconciliationRequired: false },
        'request_initialization',
        undefined,
        undefined,
        'request_core',
      )
    }

    /*
     * Keep provider redirects observable instead of following them. This
     * prevents an Authorization header from being sent to a redirect target,
     * while retaining a supported Workers request mode. The normal
     * `!response.ok` handling below rejects every returned 3xx response.
     */
    const redirectRequestInit: RequestInit = { ...coreRequestInit, redirect: 'manual' }
    try {
      new Request(path, redirectRequestInit)
    } catch {
      return this.reportFailure(
        operation,
        { outcome: 'provider_unavailable', reconciliationRequired: false },
        'request_initialization',
        undefined,
        undefined,
        'redirect_mode',
      )
    }

    let signal: AbortSignal
    try {
      signal = AbortSignal.timeout(providerRequestTimeoutMs)
    } catch {
      return this.reportFailure(
        operation,
        { outcome: 'provider_unavailable', reconciliationRequired: false },
        'request_initialization',
        undefined,
        undefined,
        'request_signal',
      )
    }

    let request: Request
    try {
      request = new Request(path, { ...redirectRequestInit, signal })
    } catch {
      return this.reportFailure(
        operation,
        { outcome: 'provider_unavailable', reconciliationRequired: false },
        'request_initialization',
        undefined,
        undefined,
        'request_signal',
      )
    }
    try {
      const response = await (this.configuration.fetchImplementation ?? fetch)(request)
      if (!response.ok) return this.reportFailure(operation, { outcome: 'provider_rejected', reconciliationRequired: false }, 'http', response.status)
      const body = await boundedJson(response)
      return body === null || hasProviderError(body)
        ? this.reportFailure(operation, { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
        : { outcome: 'accepted', value: body }
    } catch (error) {
      return isProviderTimeout(error)
        ? this.reportFailure(operation, { outcome: 'ambiguous_timeout', reconciliationRequired: true }, 'timeout')
        : this.reportFailure(
          operation,
          { outcome: 'provider_unavailable', reconciliationRequired: false },
          'transport',
          undefined,
          classifyProviderTransport(error),
        )
    }
  }

  async createSession(input: CloudflareCreateSessionRequest): Promise<CloudflareProviderResult<Readonly<{
    sessionDescription?: ProviderSessionDescription
    sessionId: string
  }>>> {
    if (!isSafeReference(input.tenantId)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const result = await this.request(
      'session_create',
      safeProviderPath('apps', this.configuration.appId, 'sessions', 'new'),
      { method: 'POST' },
    )
    if (result.outcome !== 'accepted') return result
    const body = result.value
    if (!body || typeof body !== 'object') return this.reportFailure('session_create', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    const sessionId = (body as { sessionId?: unknown }).sessionId
    if (typeof sessionId !== 'string' || !isSafeReference(sessionId)) return this.reportFailure('session_create', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
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

    const diagnosticOperation = operation === 'publish' ? 'track_publish' : 'track_subscribe'
    const result = await this.request(diagnosticOperation, safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'tracks', 'new'), {
      body: {
        ...(input.sessionDescription === undefined ? {} : { sessionDescription: input.sessionDescription }),
        tracks: input.tracks,
      },
      method: 'POST',
    })
    if (result.outcome !== 'accepted') return result
    const tracks = typedTrackResponses(result.value, input.tracks)
    if (!tracks) return this.reportFailure(diagnosticOperation, { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    const requiresImmediateRenegotiation = (result.value as { requiresImmediateRenegotiation?: unknown }).requiresImmediateRenegotiation
    if (requiresImmediateRenegotiation !== undefined && typeof requiresImmediateRenegotiation !== 'boolean') {
      return this.reportFailure(diagnosticOperation, { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
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
    const result = await this.request('track_update', safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'tracks', 'update'), {
      body: {
        ...(input.sessionDescription === undefined ? {} : { sessionDescription: input.sessionDescription }),
        tracks: input.tracks,
      },
      method: 'PUT',
    })
    if (result.outcome !== 'accepted') return result
    const tracks = typedTrackResponses(result.value, input.tracks)
    if (!tracks) return this.reportFailure('track_update', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    const requiresImmediateRenegotiation = (result.value as { requiresImmediateRenegotiation?: unknown }).requiresImmediateRenegotiation
    if (requiresImmediateRenegotiation !== undefined && typeof requiresImmediateRenegotiation !== 'boolean') {
      return this.reportFailure('track_update', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    }
    return { outcome: 'accepted', value: { requiresImmediateRenegotiation: requiresImmediateRenegotiation === true, tracks } }
  }

  async renegotiate(input: CloudflareRenegotiateRequest): Promise<CloudflareProviderResult<Readonly<{
    sessionDescription?: ProviderSessionDescription
  }>>> {
    if (!providerSessionMayMutate(input.session, input.tenantId) || !isSessionDescription(input.sessionDescription)) {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    const result = await this.request('session_renegotiate', safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'renegotiate'), {
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
    const result = await this.request('track_close', safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id, 'tracks', 'close'), {
      body: { force: true, tracks: input.tracks.map((track) => ({ mid: track.mid })) }, method: 'PUT',
    })
    if (result.outcome !== 'accepted') return result
    if (!closeTrackResponsesAreAccepted(result.value, input.tracks)) {
      return this.reportFailure('track_close', { outcome: 'provider_rejected', reconciliationRequired: true }, 'invalid_response')
    }
    const requiresImmediateRenegotiation = (result.value as { requiresImmediateRenegotiation?: unknown }).requiresImmediateRenegotiation
    if (requiresImmediateRenegotiation !== undefined && typeof requiresImmediateRenegotiation !== 'boolean') {
      return this.reportFailure('track_close', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    }
    return { outcome: 'accepted', value: { requiresImmediateRenegotiation: requiresImmediateRenegotiation === true } }
  }

  /**
   * A rejected or timed-out close is not evidence that media remains live.
   * Before retrying it indefinitely, the coordinator can use a successful,
   * fully validated GET response to prove the exact stored MID/name is absent.
   */
  async inspectTrackPresence(input: CloudflareTrackPresenceInspection): Promise<CloudflareProviderResult<Readonly<{
    present: boolean
  }>>> {
    if (!providerTrackMayMutate(input.session, input.tenantId, input.trackId, input.mid)) {
      return { outcome: 'provider_rejected', reconciliationRequired: false }
    }
    const result = await this.request('session_inspect', safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id), { method: 'GET' })
    if (result.outcome !== 'accepted') return result
    const tracks = typedSessionTrackMetadata(result.value)
    if (!tracks) return this.reportFailure('session_inspect', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    const matchingTrack = tracks.find((track) => track.mid === input.mid || track.trackName === input.trackId)
    // A response that reuses one of the stored references with a different
    // direction cannot prove anything about the prior remote/local track.
    // Keep the coordinator record pending instead of clearing it.
    if (matchingTrack && matchingTrack.location !== input.location) {
      return this.reportFailure('session_inspect', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
    }
    return {
      outcome: 'accepted',
      value: {
        // A match on either stable server-side reference means the prior track
        // is not conclusively gone. Both must be absent before local cleanup.
        present: Boolean(matchingTrack),
      },
    }
  }

  async inspectSession(input: CloudflareSessionInspection): Promise<CloudflareProviderResult<Readonly<{
    tracks: readonly CloudflareRealtimeTrackResponse[]
  }>>> {
    if (!providerSessionMayMutate(input.session, input.tenantId)) return { outcome: 'provider_rejected', reconciliationRequired: false }
    const requested: CloudflareRealtimeTrack[] = []
    for (const track of input.session.tracks.values()) {
      if (!track.mid) continue
      const location = input.trackLocations.get(track.id)
      // Do not normalize stored subscriber tracks to local. A caller without
      // a complete, server-owned direction map must treat the inspection as
      // inconclusive rather than inventing a browser publication direction.
      if (location !== 'local' && location !== 'remote') {
        return { outcome: 'provider_rejected', reconciliationRequired: false }
      }
      requested.push({ location, mid: track.mid, trackName: track.id })
    }
    const result = await this.request('session_inspect', safeProviderPath('apps', this.configuration.appId, 'sessions', input.session.id), { method: 'GET' })
    if (result.outcome !== 'accepted') return result
    const tracks = typedTrackResponses(result.value, requested)
    return tracks === null
      ? this.reportFailure('session_inspect', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
      : { outcome: 'accepted', value: { tracks } }
  }

  async generateIceServers(ttlSeconds: number): Promise<CloudflareProviderResult<Readonly<{
    iceServers: readonly CloudflareIceServer[]
  }>>> {
    if (!this.configuration.turnKeyId || !this.configuration.turnApiToken || !Number.isInteger(ttlSeconds) || ttlSeconds < minimumTurnCredentialTtlSeconds || ttlSeconds > maximumTurnCredentialTtlSeconds) {
      return this.reportFailure('turn_credentials', { outcome: 'provider_unavailable', reconciliationRequired: false }, 'configuration')
    }
    const result = await this.request(
      'turn_credentials',
      safeProviderPath('turn', 'keys', this.configuration.turnKeyId, 'credentials', 'generate-ice-servers'),
      { body: { ttl: ttlSeconds }, method: 'POST' },
      this.configuration.turnApiToken,
    )
    if (result.outcome !== 'accepted') return result
    const iceServers = typedIceServers(result.value)
    return iceServers === null
      ? this.reportFailure('turn_credentials', { outcome: 'provider_rejected', reconciliationRequired: false }, 'invalid_response')
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

import { DurableObject } from 'cloudflare:workers'
import {
  authorizeCoordinatorCommand,
  authorizeCoordinatorSession,
  coordinatorRuntimeMayDispatch,
  type AuthorizedCoordinatorCommand,
  coordinatorReleaseContextSchema,
  stagedCommsAuthorizationContextSchema,
  type CoordinatorReleaseContext,
  type StagedCommsAuthorizationContext,
} from './tenantCoordinatorCore'
import {
  closedSygSphereCommsProviderRegistry,
  closedProviderOutcome,
} from './providerRegistry'
import {
  createCloudflareRealtimeRuntimeHttpAdapter,
  type CloudflareIceServer,
  type CloudflareRealtimeHttpAdapter,
} from './cloudflareRealtimeAdapter'
import {
  activateProviderSession,
  createProviderSession,
  registerProviderTrack,
  type ProviderSession,
  type ProviderTrack,
} from './providerSessionRegistry'
import {
  acceptServerCall,
  cancelServerCall,
  createServerCall,
  declineServerCall,
  endServerCall,
  type ServerCallEvent,
  type ServerCallLifecycle,
} from './callLifecycle'
import {
  SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS,
  createSygSphereCommsWebSocketTicket,
  digestSygSphereCommsTicket,
  parseSygSphereCommsFirstSocketFrame,
  parseSygSphereCommsWebSocketRouteReference,
} from './websocketTicket'
import { parseSygSphereCommsCommand, parseSygSphereCommsEvent, type SygSphereCommsEventKind } from '../../shared/sygsphere-communications/v1/contract'
import { z } from 'zod'

type CoordinatorLedgerRow = {
  command_id: string
  result_json: string
}

type CoordinatorRateWindowRow = {
  request_count: number
}

type CoordinatorCommandRow = {
  command_id: string
}

type CoordinatorSocketTicketRow = {
  authorization_json: string
  consumed_at_ms: number | null
  expires_at_ms: number
  release_json: string
  route_reference: string
  ticket_digest: string
}

type CoordinatorNextExpiryRow = {
  expires_at_ms: number
}

type CoordinatorStoredCallRow = {
  call_id: string
  conversation_reference: string
  expires_at_ms: number
  lifecycle_json: string
  recipient_employee_id: string
  requester_employee_id: string
  state: string
}

type CoordinatorRoomSequenceRow = {
  room_seq: number
}

type CoordinatorCallMediaSessionRow = {
  call_id: string
  connection_id: string
  created_at_ms: number
  employee_id: string
  session_json: string
  track_id: string
  updated_at_ms: number
}

type CoordinatorMediaNegotiationRow = {
  call_id: string
  completed_at_ms: number | null
  connection_id: string
  employee_id: string
  expires_at_ms: number
  generation: number
  negotiation_id: string
  peer_handle: string
  session_id: string
}

type HibernatableWebSocket = WebSocket & {
  deserializeAttachment(): unknown
  serializeAttachment(value: unknown): void
}

type OpeningSocketAttachment = Readonly<{
  openedAtMs: number
  phase: 'opening'
  routeReference: string
}>

type AuthenticatedSocketAttachment = Readonly<{
  authorization: StagedCommsAuthorizationContext
  connectionId: string
  openedAtMs: number
  phase: 'authenticated'
  release: CoordinatorReleaseContext
  routeReference: string
}>

type SocketAttachment = OpeningSocketAttachment | AuthenticatedSocketAttachment

const webSocketTicketIssueSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  release: coordinatorReleaseContextSchema,
  requestId: z.uuid(),
  scopeMembershipVerified: z.literal(true),
}).strict()

const webSocketAuthorizationRefreshSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  release: coordinatorReleaseContextSchema,
  routeReference: z.uuid(),
  scopeMembershipVerified: z.literal(true),
}).strict()

const storedServerCallLifecycleSchema = z.object({
  callId: z.uuid(),
  expiresAtMs: z.number().int().positive(),
  invitationId: z.uuid(),
  recipientConnectionId: z.uuid(),
  requesterConnectionId: z.uuid(),
  state: z.enum(['accepted', 'cancelled', 'declined', 'ended', 'expired', 'ringing']),
}).strict()

const storedProviderTrackSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['audio', 'screen', 'video']),
  mid: z.string().min(1).max(64).optional(),
  state: z.enum(['active', 'closed']),
}).strict()

const storedProviderSessionSchema = z.object({
  id: z.string().min(1).max(128),
  state: z.enum(['active', 'closed', 'closing', 'pending']),
  tenantId: z.uuid(),
  tracks: z.array(storedProviderTrackSchema).max(16),
}).strict()

const directAudioStartSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  callId: z.uuid(),
  connectionRouteReference: z.uuid(),
  conversationReference: z.uuid(),
  offer: z.string().min(1).max(65_536),
  release: coordinatorReleaseContextSchema,
  requestId: z.uuid(),
}).strict()

const directAudioPreparationSchema = directAudioStartSchema.omit({ offer: true })

const directCallContextSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  callId: z.uuid(),
  connectionRouteReference: z.uuid(),
  requestId: z.uuid(),
}).strict()

export type TenantCommsWebSocketBootstrap = Readonly<{
  expiresAt: string
  routeReference: string
  ticket: string
}>

type SecretsStoreSecretBinding = Readonly<{ get: () => Promise<string> }>

type CoordinatorEnvironment = Omit<Env, 'SYGSHIFT_COMMS_REALTIME_APP_SECRET' | 'SYGSHIFT_COMMS_TURN_API_TOKEN'> & Readonly<{
  /** Optional Worker secrets; never place values in wrangler.jsonc or logs. */
  SYGSHIFT_COMMS_REALTIME_APP_ID?: string
  SYGSHIFT_COMMS_REALTIME_APP_SECRET?: SecretsStoreSecretBinding | string
  SYGSHIFT_COMMS_TURN_API_TOKEN?: SecretsStoreSecretBinding | string
  SYGSHIFT_COMMS_TURN_KEY_ID?: string
  SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED?: string
}>

export type TenantCommsCoordinatorResult = Readonly<{
  outcome: 'accepted' | 'invalid_state' | 'recipient_unavailable' | 'runtime_disabled' | 'rate_limited' | 'provider_unavailable'
  requestId: string
}>

export type TenantCommsDirectAudioPreparation = Readonly<{
  iceServers?: readonly CloudflareIceServer[]
  outcome: TenantCommsCoordinatorResult['outcome']
  requestId: string
}>

export type TenantCommsDirectCallContext = Readonly<{
  conversationReference?: string
  outcome: TenantCommsCoordinatorResult['outcome']
  requestId: string
}>

const commandRateWindowMilliseconds = 10_000
const maximumCommandsPerWindow = 8
const rateWindowRetentionMilliseconds = 60_000
const commandReplayRetentionMilliseconds = 86_400_000
const maximumRecordsPurgedPerDispatch = 50
const maximumWebSocketFrameBytes = 4_096
const directCallRingingMilliseconds = 45_000

const runtimeEnabled = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'true'

const secretValue = async (value: SecretsStoreSecretBinding | string | undefined): Promise<string | undefined> => {
  if (typeof value === 'string') return value
  try { return value ? await value.get() : undefined } catch { return undefined }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const jsonSocketMessage = (value: Record<string, unknown>): string => JSON.stringify(value)

const socketAttachment = (webSocket: WebSocket): SocketAttachment | null => {
  try {
    const attachment = (webSocket as HibernatableWebSocket).deserializeAttachment()
    if (!attachment || typeof attachment !== 'object') return null
    const candidate = attachment as Partial<SocketAttachment>
    if (candidate.phase === 'opening' && typeof candidate.routeReference === 'string' && typeof candidate.openedAtMs === 'number') {
      return candidate as OpeningSocketAttachment
    }
    if (
      candidate.phase === 'authenticated'
        && typeof candidate.routeReference === 'string'
        && typeof candidate.connectionId === 'string'
        && typeof candidate.openedAtMs === 'number'
      && stagedCommsAuthorizationContextSchema.safeParse(candidate.authorization).success
      && coordinatorReleaseContextSchema.safeParse(candidate.release).success
    ) {
      return candidate as AuthenticatedSocketAttachment
    }
  } catch {
    // An unauthenticated or malformed attachment is never recoverable.
  }
  return null
}

const constantTimeTextEquals = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

const messageText = (message: ArrayBuffer | string): string | null => {
  const text = typeof message === 'string' ? message : textDecoder.decode(message)
  return textEncoder.encode(text).byteLength <= maximumWebSocketFrameBytes ? text : null
}

const replayKey = (command: AuthorizedCoordinatorCommand): string =>
  `${command.authorization.tenantId}:${command.authorization.authUserId}:${command.command.commandId}`

const parseStoredCoordinatorResult = (value: string): TenantCommsCoordinatorResult | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as { outcome?: unknown }).outcome === 'string'
      && ['accepted', 'invalid_state', 'recipient_unavailable', 'runtime_disabled', 'rate_limited', 'provider_unavailable'].includes((parsed as { outcome: string }).outcome)
      && typeof (parsed as { requestId?: unknown }).requestId === 'string'
    ) {
      return parsed as TenantCommsCoordinatorResult
    }
  } catch {
    // The ledger has no user-controlled JSON. A malformed stored row remains
    // unavailable rather than allowing an ambiguous replay result.
  }
  return null
}

/**
 * One SQLite-backed coordinator exists per server-derived tenant name. It has
 * no public fetch handler; a later protected Worker route may call this RPC
 * only after database authorization and all release evidence are present.
 */
export class TenantCommsDurableObject extends DurableObject<CoordinatorEnvironment> {
  private readonly initialization: Promise<void>

  constructor(ctx: DurableObjectState, env: CoordinatorEnvironment) {
    super(ctx, env)
    this.initialization = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        create table if not exists coordinator_commands (
          command_id text primary key,
          result_json text not null,
          created_at_ms integer not null
        );
        create table if not exists coordinator_rate_windows (
          rate_key text not null,
          window_started_at_ms integer not null,
          request_count integer not null check (request_count >= 0),
          primary key (rate_key, window_started_at_ms)
        );
        create index if not exists coordinator_commands_created_at_idx
          on coordinator_commands (created_at_ms);
        create index if not exists coordinator_rate_windows_started_at_idx
          on coordinator_rate_windows (window_started_at_ms);
        create table if not exists coordinator_socket_tickets (
          route_reference text primary key,
          ticket_digest text not null,
          authorization_json text not null,
          release_json text not null,
          expires_at_ms integer not null,
          consumed_at_ms integer,
          created_at_ms integer not null
        );
        create table if not exists coordinator_socket_connections (
          connection_id text primary key,
          route_reference text not null,
          employee_id text not null,
          opened_at_ms integer not null,
          closed_at_ms integer
        );
        create index if not exists coordinator_socket_tickets_expiry_idx
          on coordinator_socket_tickets (expires_at_ms);
        create index if not exists coordinator_socket_connections_route_idx
          on coordinator_socket_connections (route_reference);
        create table if not exists coordinator_calls (
          call_id text primary key,
          invitation_id text not null unique,
          conversation_reference text not null,
          requester_employee_id text not null,
          recipient_employee_id text not null,
          expires_at_ms integer not null,
          state text not null,
          lifecycle_json text not null,
          created_at_ms integer not null,
          updated_at_ms integer not null
        );
        create index if not exists coordinator_calls_recipient_idx
          on coordinator_calls (recipient_employee_id, updated_at_ms desc);
        create index if not exists coordinator_calls_expiry_idx
          on coordinator_calls (state, expires_at_ms);
        create table if not exists coordinator_room_sequences (
          room_id text primary key,
          room_seq integer not null check (room_seq >= 0)
        );
        create table if not exists coordinator_call_media_sessions (
          call_id text not null,
          employee_id text not null,
          connection_id text not null,
          session_json text not null,
          track_id text not null,
          created_at_ms integer not null,
          updated_at_ms integer not null,
          primary key (call_id, employee_id)
        );
        create index if not exists coordinator_call_media_sessions_connection_idx
          on coordinator_call_media_sessions (connection_id, updated_at_ms desc);
        create table if not exists coordinator_media_negotiations (
          negotiation_id text primary key,
          call_id text not null,
          employee_id text not null,
          connection_id text not null,
          session_id text not null,
          peer_handle text not null,
          generation integer not null check (generation >= 0),
          expires_at_ms integer not null,
          completed_at_ms integer
        );
        create index if not exists coordinator_media_negotiations_expiry_idx
          on coordinator_media_negotiations (expires_at_ms);
      `)
    })
  }

  private scheduleNextSocketTicketExpiry(): void {
    const next = this.ctx.storage.sql
      .exec<CoordinatorNextExpiryRow>(
        'select expires_at_ms from coordinator_socket_tickets where consumed_at_ms is null order by expires_at_ms asc limit 1',
      )
      .toArray()[0]
    const nextCall = this.ctx.storage.sql
      .exec<CoordinatorNextExpiryRow>(
        `select expires_at_ms from coordinator_calls
         where state = 'ringing' order by expires_at_ms asc limit 1`,
      )
      .toArray()[0]
    const nextExpiry = [next?.expires_at_ms, nextCall?.expires_at_ms]
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => left - right)[0]
    if (nextExpiry !== undefined) void this.ctx.storage.setAlarm(nextExpiry)
  }

  /**
   * Called only from the protected server bootstrap. The opaque route
   * reference is an HttpOnly same-site routing cookie, while the raw ticket
   * is delivered to the already-authenticated browser and must be supplied
   * only in the first WebSocket application frame.
   */
  async issueWebSocketTicket(input: unknown): Promise<TenantCommsWebSocketBootstrap> {
    await this.initialization
    const parsed = webSocketTicketIssueSchema.parse(input)
    const authorization = authorizeCoordinatorSession(parsed.authorization)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      throw new Error('Communications are not available yet.')
    }

    const ticket = await createSygSphereCommsWebSocketTicket()
    const now = Date.now()
    this.purgeExpiredState(now)
    this.ctx.storage.sql.exec(
      `insert into coordinator_socket_tickets (
        route_reference, ticket_digest, authorization_json, release_json,
        expires_at_ms, consumed_at_ms, created_at_ms
      ) values (?, ?, ?, ?, ?, null, ?)`,
      ticket.routeReference,
      ticket.ticketDigest,
      JSON.stringify(authorization),
      JSON.stringify(parsed.release),
      ticket.expiresAt,
      now,
    )
    this.scheduleNextSocketTicketExpiry()
    return {
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      routeReference: ticket.routeReference,
      ticket: ticket.ticket,
    }
  }

  /** The Worker calls this only after re-reading the authenticated server
   * context. A refresh can update a matching active socket, never move a
   * connection between actors or tenants. */
  async refreshWebSocketAuthorization(input: unknown): Promise<number> {
    await this.initialization
    const parsed = webSocketAuthorizationRefreshSchema.parse(input)
    const authorization = authorizeCoordinatorSession(parsed.authorization)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      return 0
    }
    let refreshed = 0
    for (const webSocket of this.ctx.getWebSockets(`comms-route:${parsed.routeReference}`)) {
      const attachment = socketAttachment(webSocket)
      if (
        attachment?.phase !== 'authenticated'
        || attachment.authorization.tenantId !== authorization.tenantId
        || attachment.authorization.employeeId !== authorization.employeeId
        || attachment.authorization.authUserId !== authorization.authUserId
      ) continue
      ;(webSocket as HibernatableWebSocket).serializeAttachment({
        ...attachment,
        authorization,
        release: parsed.release,
      } satisfies AuthenticatedSocketAttachment)
      refreshed += 1
    }
    return refreshed
  }

  private async consumeWebSocketTicket(
    routeReference: string,
    ticket: string,
  ): Promise<Readonly<{ authorization: StagedCommsAuthorizationContext, release: CoordinatorReleaseContext }> | null> {
    const row = this.ctx.storage.sql
      .exec<CoordinatorSocketTicketRow>(
        `select route_reference, ticket_digest, authorization_json, release_json, expires_at_ms, consumed_at_ms
         from coordinator_socket_tickets where route_reference = ? limit 1`,
        routeReference,
      )
      .toArray()[0]
    const now = Date.now()
    if (!row || row.consumed_at_ms !== null || row.expires_at_ms <= now) return null

    const suppliedDigest = await digestSygSphereCommsTicket(ticket)
    if (!constantTimeTextEquals(row.ticket_digest, suppliedDigest)) return null

    const authorization = stagedCommsAuthorizationContextSchema.safeParse(JSON.parse(row.authorization_json))
    const release = coordinatorReleaseContextSchema.safeParse(JSON.parse(row.release_json))
    if (!authorization.success || !release.success || !coordinatorRuntimeMayDispatch(release.data)) return null

    this.ctx.storage.sql.exec(
      `update coordinator_socket_tickets set consumed_at_ms = ?
       where route_reference = ? and consumed_at_ms is null and expires_at_ms > ?`,
      now,
      routeReference,
      now,
    )
    const consumed = this.ctx.storage.sql
      .exec<CoordinatorSocketTicketRow>(
        'select route_reference, ticket_digest, authorization_json, release_json, expires_at_ms, consumed_at_ms from coordinator_socket_tickets where route_reference = ? limit 1',
        routeReference,
      )
      .toArray()[0]
    if (!consumed || consumed.consumed_at_ms !== now) return null
    return { authorization: authorization.data, release: release.data }
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialization
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED)) {
      return new Response('Communications are not available yet.', { status: 503 })
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required.', { status: 426 })
    }
    const routeReference = parseSygSphereCommsWebSocketRouteReference(request.headers.get('x-sygsphere-comms-route-reference'))
    if (!routeReference) return new Response('Communications connection unavailable.', { status: 404 })

    const pending = this.ctx.storage.sql
      .exec<CoordinatorSocketTicketRow>(
        `select route_reference, ticket_digest, authorization_json, release_json, expires_at_ms, consumed_at_ms
         from coordinator_socket_tickets where route_reference = ? limit 1`,
        routeReference,
      )
      .toArray()[0]
    if (!pending || pending.consumed_at_ms !== null || pending.expires_at_ms <= Date.now()) {
      return new Response('Communications connection unavailable.', { status: 404 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, HibernatableWebSocket]
    server.serializeAttachment({ phase: 'opening', routeReference, openedAtMs: Date.now() } satisfies OpeningSocketAttachment)
    this.ctx.acceptWebSocket(server, [`comms-route:${routeReference}`])
    this.scheduleNextSocketTicketExpiry()
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit)
  }

  async webSocketMessage(webSocket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialization
    const attachment = socketAttachment(webSocket)
    const text = messageText(message)
    if (!attachment || !text) {
      webSocket.close(1008, 'Communications connection unavailable.')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      webSocket.close(1008, 'Communications connection unavailable.')
      return
    }

    if (attachment.phase === 'opening') {
      const frame = (() => {
        try {
          return parseSygSphereCommsFirstSocketFrame(parsed)
        } catch {
          return null
        }
      })()
      if (!frame) {
        webSocket.close(1008, 'Communications connection unavailable.')
        return
      }
      const consumed = await this.consumeWebSocketTicket(attachment.routeReference, frame.ticket)
      if (!consumed) {
        webSocket.close(1008, 'Communications connection unavailable.')
        return
      }
      const connectionId = crypto.randomUUID()
      this.ctx.storage.sql.exec(
        'insert into coordinator_socket_connections (connection_id, route_reference, employee_id, opened_at_ms, closed_at_ms) values (?, ?, ?, ?, null)',
        connectionId,
        attachment.routeReference,
        consumed.authorization.employeeId,
        Date.now(),
      )
      ;(webSocket as HibernatableWebSocket).serializeAttachment({
        authorization: consumed.authorization,
        connectionId,
        openedAtMs: Date.now(),
        phase: 'authenticated',
        release: consumed.release,
        routeReference: attachment.routeReference,
      } satisfies AuthenticatedSocketAttachment)
      webSocket.send(jsonSocketMessage({ kind: 'authenticated', protocolVersion: 1 }))
      return
    }

    const command = (() => {
      try {
        return parseSygSphereCommsCommand(parsed)
      } catch {
        return null
      }
    })()
    if (!command || command.kind === 'auth') {
      webSocket.close(1008, 'Communications connection unavailable.')
      return
    }

    if (command.kind === 'heartbeat') {
      webSocket.send(jsonSocketMessage({
        connectionEpoch: command.connectionEpoch,
        correlationId: crypto.randomUUID(),
        kind: 'heartbeat.ack',
        protocolVersion: 1,
        serverTime: new Date().toISOString(),
      }))
      return
    }

    if (command.kind === 'resume' || command.kind === 'snapshot.request') {
      // No browser-supplied room reference may become a restored room. Until
      // the server-owned room-state coordinator records a snapshot, recovery
      // is explicit and safe rather than pretending an old call is active.
      webSocket.send(jsonSocketMessage({
        correlationId: crypto.randomUUID(),
        kind: 'snapshot',
        protocolVersion: 1,
        status: 'unavailable',
      }))
      return
    }

    /*
     * A WebSocket is delivery-only.  It must never become a second mutation
     * route where a browser can pair an otherwise-valid command with a room,
     * person, or call it is not allowed to control.  Every mutation goes
     * through /api/comms/v1/commands, which resolves fresh membership and the
     * current authenticated route before it invokes this coordinator.
     */
    webSocket.send(jsonSocketMessage({
      commandId: command.commandId,
      correlationId: crypto.randomUUID(),
      kind: 'command.outcome',
      outcome: 'unavailable',
      protocolVersion: 1,
    }))
  }

  async webSocketClose(webSocket: WebSocket): Promise<void> {
    await this.initialization
    const attachment = socketAttachment(webSocket)
    if (attachment?.phase !== 'authenticated') return
    this.ctx.storage.sql.exec(
      'update coordinator_socket_connections set closed_at_ms = ? where connection_id = ? and closed_at_ms is null',
      Date.now(),
      attachment.connectionId,
    )
  }

  async alarm(): Promise<void> {
    await this.initialization
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'delete from coordinator_socket_tickets where expires_at_ms <= ? and consumed_at_ms is null',
      now,
    )
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (attachment?.phase === 'opening' && attachment.openedAtMs + SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS <= now) {
        webSocket.close(1008, 'Communications connection unavailable.')
      }
    }
    await this.expireRingingCalls(now)
    this.scheduleNextSocketTicketExpiry()
  }

  private purgeExpiredState(now: number): void {
    const expiredCommandIds = this.ctx.storage.sql
      .exec<CoordinatorCommandRow>(
        'select command_id from coordinator_commands where created_at_ms < ? order by created_at_ms asc limit ?',
        now - commandReplayRetentionMilliseconds,
        maximumRecordsPurgedPerDispatch,
      )
      .toArray()
    for (const expired of expiredCommandIds) {
      this.ctx.storage.sql.exec('delete from coordinator_commands where command_id = ?', expired.command_id)
    }

    const expiredRateWindows = this.ctx.storage.sql
      .exec<CoordinatorRateWindowRow & { rate_key: string, window_started_at_ms: number }>(
        'select rate_key, window_started_at_ms, request_count from coordinator_rate_windows where window_started_at_ms < ? order by window_started_at_ms asc limit ?',
        now - rateWindowRetentionMilliseconds,
        maximumRecordsPurgedPerDispatch,
      )
      .toArray()
    for (const expired of expiredRateWindows) {
      this.ctx.storage.sql.exec(
        'delete from coordinator_rate_windows where rate_key = ? and window_started_at_ms = ?',
        expired.rate_key,
        expired.window_started_at_ms,
      )
    }
  }

  private activeSocketForRoute(
    routeReference: string,
    authorization: StagedCommsAuthorizationContext,
  ): AuthenticatedSocketAttachment | null {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (
        attachment?.phase === 'authenticated'
        && attachment.routeReference === routeReference
        && attachment.authorization.tenantId === authorization.tenantId
        && attachment.authorization.employeeId === authorization.employeeId
        && attachment.authorization.authUserId === authorization.authUserId
      ) return attachment
    }
    return null
  }

  private activeSocketForEmployee(employeeId: string): AuthenticatedSocketAttachment | null {
    let newest: AuthenticatedSocketAttachment | null = null
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (attachment?.phase !== 'authenticated' || attachment.authorization.employeeId !== employeeId) continue
      if (newest === null || attachment.openedAtMs > newest.openedAtMs) newest = attachment
    }
    return newest
  }

  private nextRoomSequence(roomId: string): number {
    this.ctx.storage.sql.exec(
      `insert into coordinator_room_sequences (room_id, room_seq) values (?, 1)
       on conflict (room_id) do update set room_seq = room_seq + 1`,
      roomId,
    )
    const row = this.ctx.storage.sql
      .exec<CoordinatorRoomSequenceRow>('select room_seq from coordinator_room_sequences where room_id = ? limit 1', roomId)
      .toArray()[0]
    if (!row) throw new Error('The communications room sequence is unavailable.')
    return row.room_seq
  }

  private sendCoordinatorEvent(
    connectionId: string,
    roomId: string,
    kind: SygSphereCommsEventKind,
    payload: Record<string, unknown>,
  ): void {
    const frame = parseSygSphereCommsEvent({
      eventId: crypto.randomUUID(),
      kind,
      payload,
      protocolVersion: 1,
      roomEpoch: 0,
      roomId,
      roomSeq: this.nextRoomSequence(roomId),
      serverTime: new Date().toISOString(),
    })
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (attachment?.phase === 'authenticated' && attachment.connectionId === connectionId) {
        try {
          webSocket.send(jsonSocketMessage(frame))
        } catch {
          // Connection cleanup will persist through the standard close handler.
        }
      }
    }
  }

  private sendCallEvent(connectionId: string, event: ServerCallEvent): void {
    this.sendCoordinatorEvent(connectionId, `call:${event.payload.callId}`, event.kind, event.payload)
  }

  private parseStoredCall(row: CoordinatorStoredCallRow): ServerCallLifecycle | null {
    try {
      const parsed = storedServerCallLifecycleSchema.safeParse(JSON.parse(row.lifecycle_json))
      return parsed.success && parsed.data.callId === row.call_id ? parsed.data : null
    } catch {
      return null
    }
  }

  private persistCall(
    row: Pick<CoordinatorStoredCallRow, 'conversation_reference' | 'recipient_employee_id' | 'requester_employee_id'>,
    lifecycle: ServerCallLifecycle,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `update coordinator_calls
       set lifecycle_json = ?, state = ?, updated_at_ms = ?
       where call_id = ? and conversation_reference = ?
         and requester_employee_id = ? and recipient_employee_id = ?`,
      JSON.stringify(lifecycle),
      lifecycle.state,
      now,
      lifecycle.callId,
      row.conversation_reference,
      row.requester_employee_id,
      row.recipient_employee_id,
    )
  }

  private async providerAdapter(release: CoordinatorReleaseContext): Promise<CloudflareRealtimeHttpAdapter | null> {
    const [appSecret, turnApiToken] = await Promise.all([
      secretValue(this.env.SYGSHIFT_COMMS_REALTIME_APP_SECRET),
      secretValue(this.env.SYGSHIFT_COMMS_TURN_API_TOKEN),
    ])
    return createCloudflareRealtimeRuntimeHttpAdapter({
      appId: this.env.SYGSHIFT_COMMS_REALTIME_APP_ID,
      appSecret,
      coordinatorReleaseMayDispatch: coordinatorRuntimeMayDispatch(release),
      runtimeEnabled: runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED),
      turnApiToken,
      turnKeyId: this.env.SYGSHIFT_COMMS_TURN_KEY_ID,
    })
  }

  private parseProviderSession(row: CoordinatorCallMediaSessionRow): ProviderSession | null {
    try {
      const parsed = storedProviderSessionSchema.safeParse(JSON.parse(row.session_json))
      if (!parsed.success || parsed.data.state !== 'active') return null
      return {
        id: parsed.data.id,
        state: parsed.data.state,
        tenantId: parsed.data.tenantId,
        tracks: new Map(parsed.data.tracks.map((track) => [track.id, track satisfies ProviderTrack])),
      }
    } catch {
      return null
    }
  }

  private serializeProviderSession(session: ProviderSession): string {
    return JSON.stringify({
      id: session.id,
      state: session.state,
      tenantId: session.tenantId,
      tracks: [...session.tracks.values()],
    })
  }

  private persistProviderSession(
    input: Readonly<{ callId: string, connectionId: string, employeeId: string, session: ProviderSession, trackId: string }>,
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `insert into coordinator_call_media_sessions (
        call_id, employee_id, connection_id, session_json, track_id, created_at_ms, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (call_id, employee_id) do update set
        connection_id = excluded.connection_id,
        session_json = excluded.session_json,
        track_id = excluded.track_id,
        updated_at_ms = excluded.updated_at_ms`,
      input.callId,
      input.employeeId,
      input.connectionId,
      this.serializeProviderSession(input.session),
      input.trackId,
      now,
      now,
    )
  }

  private mediaSession(callId: string, employeeId: string): CoordinatorCallMediaSessionRow | null {
    return this.ctx.storage.sql.exec<CoordinatorCallMediaSessionRow>(
      `select call_id, employee_id, connection_id, session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_call_media_sessions where call_id = ? and employee_id = ? limit 1`,
      callId,
      employeeId,
    ).toArray()[0] ?? null
  }

  private registerMediaNegotiation(input: Readonly<{
    callId: string
    connectionId: string
    employeeId: string
    generation: number
    peerHandle: string
    sessionId: string
  }>, now: number): Readonly<{ expiresAt: string, negotiationId: string }> {
    const negotiationId = crypto.randomUUID()
    const expiresAtMs = now + 30_000
    this.ctx.storage.sql.exec(
      `insert into coordinator_media_negotiations (
        negotiation_id, call_id, employee_id, connection_id, session_id,
        peer_handle, generation, expires_at_ms, completed_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?, null)`,
      negotiationId,
      input.callId,
      input.employeeId,
      input.connectionId,
      input.sessionId,
      input.peerHandle,
      input.generation,
      expiresAtMs,
    )
    return { expiresAt: new Date(expiresAtMs).toISOString(), negotiationId }
  }

  private async sendRemoteAudioSubscription(input: Readonly<{
    adapter: CloudflareRealtimeHttpAdapter
    callId: string
    destination: CoordinatorCallMediaSessionRow
    destinationSession: ProviderSession
    iceServers: readonly Readonly<{ credential?: string, urls: readonly string[], username?: string }>[]
    now: number
    source: CoordinatorCallMediaSessionRow
    sourceSession: ProviderSession
  }>): Promise<void> {
    const providerResult = await input.adapter.subscribeTracks({
      session: input.destinationSession,
      tenantId: input.destinationSession.tenantId,
      tracks: [{
        location: 'remote',
        sessionId: input.sourceSession.id,
        trackName: input.source.track_id,
      }],
    })
    if (providerResult.outcome !== 'accepted' || !providerResult.value.sessionDescription) {
      this.sendCoordinatorEvent(input.destination.connection_id, `call:${input.callId}`, 'media.failed', {
        callId: input.callId,
        operation: 'subscribe',
        retryAllowed: providerResult.outcome !== 'provider_rejected',
      })
      return
    }
    const track = providerResult.value.tracks[0]
    if (!track?.mid) {
      this.sendCoordinatorEvent(input.destination.connection_id, `call:${input.callId}`, 'media.failed', {
        callId: input.callId,
        operation: 'subscribe',
        retryAllowed: false,
      })
      return
    }
    const peerHandle = `peer:${input.destinationSession.id}:${crypto.randomUUID()}`
    const negotiation = this.registerMediaNegotiation({
      callId: input.callId,
      connectionId: input.destination.connection_id,
      employeeId: input.destination.employee_id,
      generation: 1,
      peerHandle,
      sessionId: input.destinationSession.id,
    }, input.now)
    this.sendCoordinatorEvent(input.destination.connection_id, `call:${input.callId}`, 'media.negotiation', {
      callId: input.callId,
      description: providerResult.value.sessionDescription.sdp,
      descriptionType: providerResult.value.sessionDescription.type,
      direction: 'subscribe',
      expiresAt: negotiation.expiresAt,
      generation: 1,
      iceServers: input.iceServers,
      negotiationId: negotiation.negotiationId,
      peerHandle,
      trackBindings: [{
        mediaKind: 'audio',
        participantConnectionId: input.source.connection_id,
        publicationKind: 'call_audio',
        role: 'remote',
        trackReference: input.source.track_id,
        transceiverMid: track.mid,
      }],
    })
  }

  /** The app shell uses this only to learn which already-accepted direct
   * conversation a current participant may join. The DO checks the live
   * authenticated connection before returning the local reference. */
  async getDirectCallContext(input: unknown): Promise<TenantCommsDirectCallContext> {
    await this.initialization
    const parsed = directCallContextSchema.parse(input)
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.callById(parsed.callId)
    const lifecycle = row ? this.parseStoredCall(row) : null
    if (!caller || !row || !lifecycle || lifecycle.state !== 'accepted'
      || (row.requester_employee_id !== caller.authorization.employeeId && row.recipient_employee_id !== caller.authorization.employeeId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    return { conversationReference: row.conversation_reference, outcome: 'accepted', requestId: parsed.requestId }
  }

  /** Short-lived TURN details are returned only after the browser, Worker,
   * database, and coordinator all agree on the current direct-call scope. */
  async prepareDirectAudio(input: unknown): Promise<TenantCommsDirectAudioPreparation> {
    await this.initialization
    const parsed = directAudioPreparationSchema.parse(input)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const callRow = this.callById(parsed.callId)
    const lifecycle = callRow ? this.parseStoredCall(callRow) : null
    if (!caller || !callRow || !lifecycle || lifecycle.state !== 'accepted'
      || callRow.conversation_reference !== parsed.conversationReference
      || (callRow.requester_employee_id !== caller.authorization.employeeId && callRow.recipient_employee_id !== caller.authorization.employeeId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const adapter = await this.providerAdapter(parsed.release)
    if (!adapter) return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const ice = await adapter.generateIceServers(300)
    return ice.outcome === 'accepted'
      ? { iceServers: ice.value.iceServers, outcome: 'accepted', requestId: parsed.requestId }
      : { outcome: 'provider_unavailable', requestId: parsed.requestId }
  }

  /** Starts the first media negotiation for an already accepted direct call.
   * The browser supplies only its own SDP offer; this coordinator resolves the
   * exact call, connection, recipient, provider session, and track names. */
  async startDirectAudio(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = directAudioStartSchema.parse(input)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const callRow = this.callById(parsed.callId)
    const lifecycle = callRow ? this.parseStoredCall(callRow) : null
    if (!caller || !callRow || !lifecycle || lifecycle.state !== 'accepted'
      || callRow.conversation_reference !== parsed.conversationReference
      || (callRow.requester_employee_id !== caller.authorization.employeeId && callRow.recipient_employee_id !== caller.authorization.employeeId)
      || this.mediaSession(parsed.callId, caller.authorization.employeeId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const adapter = await this.providerAdapter(parsed.release)
    if (!adapter) return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const ice = await adapter.generateIceServers(300)
    if (ice.outcome !== 'accepted') return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const created = await adapter.createSession({ tenantId: caller.authorization.tenantId })
    if (created.outcome !== 'accepted') return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const pending = activateProviderSession(createProviderSession(created.value.sessionId, caller.authorization.tenantId))
    const trackId = `call-${parsed.callId}-audio-${caller.authorization.employeeId}`
    const publication = await adapter.publishTracks({
      session: pending,
      sessionDescription: { sdp: parsed.offer, type: 'offer' },
      tenantId: caller.authorization.tenantId,
      tracks: [{ kind: 'audio', location: 'local', trackName: trackId }],
    })
    const localTrack = publication.outcome === 'accepted' ? publication.value.tracks[0] : null
    if (publication.outcome !== 'accepted' || !localTrack?.mid || !publication.value.sessionDescription) {
      return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    }
    const session = registerProviderTrack(pending, { id: trackId, kind: 'audio', mid: localTrack.mid, state: 'active' })
    const now = Date.now()
    this.persistProviderSession({
      callId: parsed.callId,
      connectionId: caller.connectionId,
      employeeId: caller.authorization.employeeId,
      session,
      trackId,
    }, now)
    const peerHandle = `peer:${session.id}`
    this.sendCoordinatorEvent(caller.connectionId, `call:${parsed.callId}`, 'media.negotiation', {
      callId: parsed.callId,
      description: publication.value.sessionDescription.sdp,
      descriptionType: publication.value.sessionDescription.type,
      direction: 'publish',
      expiresAt: new Date(now + 30_000).toISOString(),
      generation: 1,
      iceServers: ice.value.iceServers,
      negotiationId: crypto.randomUUID(),
      peerHandle,
      trackBindings: [{
        mediaKind: 'audio',
        publicationKind: 'call_audio',
        role: 'local',
        trackReference: trackId,
        transceiverMid: localTrack.mid,
      }],
    })
    const otherEmployeeId = callRow.requester_employee_id === caller.authorization.employeeId
      ? callRow.recipient_employee_id
      : callRow.requester_employee_id
    const other = this.mediaSession(parsed.callId, otherEmployeeId)
    const otherSession = other ? this.parseProviderSession(other) : null
    if (other && otherSession) {
      await this.sendRemoteAudioSubscription({ adapter, callId: parsed.callId, destination: other, destinationSession: otherSession, iceServers: ice.value.iceServers, now, source: {
        call_id: parsed.callId, connection_id: caller.connectionId, created_at_ms: now, employee_id: caller.authorization.employeeId, session_json: this.serializeProviderSession(session), track_id: trackId, updated_at_ms: now,
      }, sourceSession: session })
      await this.sendRemoteAudioSubscription({ adapter, callId: parsed.callId, destination: {
        call_id: parsed.callId, connection_id: caller.connectionId, created_at_ms: now, employee_id: caller.authorization.employeeId, session_json: this.serializeProviderSession(session), track_id: trackId, updated_at_ms: now,
      }, destinationSession: session, iceServers: ice.value.iceServers, now, source: other, sourceSession: otherSession })
    }
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  private async dispatchMediaAnswer(authorized: AuthorizedCoordinatorCommand, now: number): Promise<TenantCommsCoordinatorResult['outcome']> {
    const routeReference = authorized.connectionRouteReference
    if (!routeReference) return 'invalid_state'
    const caller = this.activeSocketForRoute(routeReference, authorized.authorization)
    const payload = authorized.command.payload
    const negotiationId = typeof payload.negotiationId === 'string' ? payload.negotiationId : null
    const peerHandle = typeof payload.peerHandle === 'string' ? payload.peerHandle : null
    const answer = typeof payload.answer === 'string' ? payload.answer : null
    const generation = typeof payload.generation === 'number' ? payload.generation : null
    if (!caller || !negotiationId || !peerHandle || !answer || generation === null) return 'invalid_state'
    const negotiation = this.ctx.storage.sql.exec<CoordinatorMediaNegotiationRow>(
      `select negotiation_id, call_id, employee_id, connection_id, session_id, peer_handle,
              generation, expires_at_ms, completed_at_ms
       from coordinator_media_negotiations where negotiation_id = ? limit 1`,
      negotiationId,
    ).toArray()[0]
    if (!negotiation || negotiation.completed_at_ms !== null || negotiation.expires_at_ms < now
      || negotiation.employee_id !== caller.authorization.employeeId || negotiation.connection_id !== caller.connectionId
      || negotiation.peer_handle !== peerHandle || negotiation.generation !== generation) return 'invalid_state'
    const media = this.mediaSession(negotiation.call_id, caller.authorization.employeeId)
    const session = media ? this.parseProviderSession(media) : null
    const adapter = await this.providerAdapter(authorized.release)
    if (!media || !session || session.id !== negotiation.session_id || !adapter) return 'provider_unavailable'
    const reconciled = await adapter.renegotiate({ session, sessionDescription: { sdp: answer, type: 'answer' }, tenantId: session.tenantId })
    if (reconciled.outcome !== 'accepted') return 'provider_unavailable'
    this.ctx.storage.sql.exec(
      `update coordinator_media_negotiations set completed_at_ms = ?
       where negotiation_id = ? and completed_at_ms is null`,
      now,
      negotiation.negotiation_id,
    )
    return 'accepted'
  }

  /**
   * The call lifecycle is authoritative. Ending it must stop browser media
   * immediately even when a provider cleanup is temporarily unavailable.
   * Provider tracks are force-closed opportunistically from server-stored
   * session and MID values; no browser-supplied provider identifiers exist.
   */
  private async closeDirectCallMedia(callId: string, release: CoordinatorReleaseContext, reason: 'cancelled' | 'declined' | 'ended' | 'expired'): Promise<void> {
    const rows = this.ctx.storage.sql.exec<CoordinatorCallMediaSessionRow>(
      `select call_id, employee_id, connection_id, session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_call_media_sessions where call_id = ?`,
      callId,
    ).toArray()
    const adapter = await this.providerAdapter(release)
    for (const row of rows) {
      const session = this.parseProviderSession(row)
      const track = session?.tracks.get(row.track_id)
      if (adapter && session && track?.mid) {
        await adapter.forceCloseTracks({
          session,
          tenantId: session.tenantId,
          tracks: [{ mid: track.mid, trackId: track.id }],
        }).catch(() => undefined)
      }
      this.sendCoordinatorEvent(row.connection_id, `call:${callId}`, 'media.closed', {
        callId,
        generation: 1,
        reason,
      })
    }
    this.ctx.storage.sql.exec('delete from coordinator_media_negotiations where call_id = ?', callId)
    this.ctx.storage.sql.exec('delete from coordinator_call_media_sessions where call_id = ?', callId)
  }

  private async expireRingingCalls(now: number): Promise<void> {
    const calls = this.ctx.storage.sql
      .exec<CoordinatorStoredCallRow>(
        `select call_id, conversation_reference, expires_at_ms, lifecycle_json,
                recipient_employee_id, requester_employee_id, state
         from coordinator_calls where state = 'ringing' and expires_at_ms <= ?
         order by expires_at_ms asc limit ?`,
        now,
        maximumRecordsPurgedPerDispatch,
      )
      .toArray()
    for (const row of calls) {
      const lifecycle = this.parseStoredCall(row)
      if (!lifecycle) continue
      const expired = declineServerCall(lifecycle, {
        invitationId: lifecycle.invitationId,
        nowMs: now,
        recipientConnectionId: lifecycle.recipientConnectionId,
      })
      if (expired.state.state !== lifecycle.state) this.persistCall(row, expired.state, now)
      if (expired.event) {
        this.sendCallEvent(lifecycle.requesterConnectionId, expired.event)
        this.sendCallEvent(lifecycle.recipientConnectionId, expired.event)
        await this.closeDirectCallMedia(row.call_id, {
          databaseFoundationApplied: true,
          commandSchemasVerified: true,
          providerPhysicalDeviceEvidenceComplete: true,
          coordinatorDeploymentApproved: true,
          sharedCompatibilityVerified: true,
          runtimeEnabled: runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED),
        }, 'expired')
      }
    }
  }

  private recordResult(commandId: string, result: TenantCommsCoordinatorResult, now: number): TenantCommsCoordinatorResult {
    this.ctx.storage.sql.exec(
      'insert into coordinator_commands (command_id, result_json, created_at_ms) values (?, ?, ?)',
      commandId,
      JSON.stringify(result),
      now,
    )
    return result
  }

  private callById(callId: string): CoordinatorStoredCallRow | null {
    return this.ctx.storage.sql
      .exec<CoordinatorStoredCallRow>(
        `select call_id, conversation_reference, expires_at_ms, lifecycle_json,
                recipient_employee_id, requester_employee_id, state
         from coordinator_calls where call_id = ? limit 1`,
        callId,
      )
      .toArray()[0] ?? null
  }

  private callByInvitation(invitationId: string): CoordinatorStoredCallRow | null {
    return this.ctx.storage.sql
      .exec<CoordinatorStoredCallRow>(
        `select call_id, conversation_reference, expires_at_ms, lifecycle_json,
                recipient_employee_id, requester_employee_id, state
         from coordinator_calls where invitation_id = ? limit 1`,
        invitationId,
      )
      .toArray()[0] ?? null
  }

  /**
   * The caller's open socket and a database-resolved direct-conversation
   * recipient are both required. This coordinates safe ringing state only;
   * media remains a separately authorized provider operation.
   */
  private async dispatchCallCommand(
    authorized: AuthorizedCoordinatorCommand,
    now: number,
  ): Promise<TenantCommsCoordinatorResult['outcome']> {
    const routeReference = authorized.connectionRouteReference
    if (!routeReference) return 'invalid_state'
    const caller = this.activeSocketForRoute(routeReference, authorized.authorization)
    if (!caller) return 'invalid_state'

    if (authorized.command.kind === 'call.request') {
      const scope = authorized.scope
      if (!scope) return 'invalid_state'
      const recipient = this.activeSocketForEmployee(scope.recipientEmployeeId)
      if (!recipient || recipient.connectionId === caller.connectionId) return 'recipient_unavailable'
      const created = createServerCall({
        callId: crypto.randomUUID(),
        expiresAtMs: now + directCallRingingMilliseconds,
        invitationId: crypto.randomUUID(),
        recipientConnectionId: recipient.connectionId,
        requesterConnectionId: caller.connectionId,
      })
      this.ctx.storage.sql.exec(
        `insert into coordinator_calls (
          call_id, invitation_id, conversation_reference,
          requester_employee_id, recipient_employee_id, expires_at_ms,
          state, lifecycle_json, created_at_ms, updated_at_ms
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        created.state.callId,
        created.state.invitationId,
        scope.conversationReference,
        caller.authorization.employeeId,
        recipient.authorization.employeeId,
        created.state.expiresAtMs,
        created.state.state,
        JSON.stringify(created.state),
        now,
        now,
      )
      this.sendCallEvent(caller.connectionId, created.events[0])
      this.sendCallEvent(recipient.connectionId, created.events[1])
      this.scheduleNextSocketTicketExpiry()
      return 'accepted'
    }

    const invitationId = typeof authorized.command.payload.invitationId === 'string'
      ? authorized.command.payload.invitationId
      : null
    const callId = typeof authorized.command.payload.callId === 'string'
      ? authorized.command.payload.callId
      : null
    const row = authorized.command.kind === 'call.accept' || authorized.command.kind === 'call.decline'
      ? invitationId ? this.callByInvitation(invitationId) : null
      : callId ? this.callById(callId) : null
    const lifecycle = row ? this.parseStoredCall(row) : null
    if (!row || !lifecycle) return 'invalid_state'

    if (authorized.command.kind === 'call.accept') {
      if (row.recipient_employee_id !== caller.authorization.employeeId) return 'invalid_state'
      const accepted = acceptServerCall(lifecycle, {
        invitationId: invitationId ?? '',
        nowMs: now,
        recipientConnectionId: caller.connectionId,
      })
      if (!accepted.event) return 'invalid_state'
      this.persistCall(row, accepted.state, now)
      this.sendCallEvent(accepted.state.requesterConnectionId, accepted.event)
      this.sendCallEvent(accepted.state.recipientConnectionId, accepted.event)
      return 'accepted'
    }

    if (authorized.command.kind === 'call.decline') {
      if (row.recipient_employee_id !== caller.authorization.employeeId) return 'invalid_state'
      const declined = declineServerCall(lifecycle, {
        invitationId: invitationId ?? '',
        nowMs: now,
        recipientConnectionId: caller.connectionId,
      })
      if (!declined.event) return 'invalid_state'
      this.persistCall(row, declined.state, now)
      this.sendCallEvent(declined.state.requesterConnectionId, declined.event)
      this.sendCallEvent(declined.state.recipientConnectionId, declined.event)
      await this.closeDirectCallMedia(row.call_id, authorized.release, 'declined')
      return 'accepted'
    }

    if (authorized.command.kind === 'call.cancel') {
      if (row.requester_employee_id !== caller.authorization.employeeId) return 'invalid_state'
      const cancelled = cancelServerCall(lifecycle, caller.connectionId, now)
      if (!cancelled.event) return 'invalid_state'
      this.persistCall(row, cancelled.state, now)
      this.sendCallEvent(cancelled.state.requesterConnectionId, cancelled.event)
      this.sendCallEvent(cancelled.state.recipientConnectionId, cancelled.event)
      await this.closeDirectCallMedia(row.call_id, authorized.release, 'cancelled')
      return 'accepted'
    }

    if (authorized.command.kind === 'call.end') {
      if (row.requester_employee_id !== caller.authorization.employeeId && row.recipient_employee_id !== caller.authorization.employeeId) return 'invalid_state'
      const ended = endServerCall(lifecycle, caller.connectionId)
      if (!ended.event) return 'invalid_state'
      this.persistCall(row, ended.state, now)
      this.sendCallEvent(ended.state.requesterConnectionId, ended.event)
      this.sendCallEvent(ended.state.recipientConnectionId, ended.event)
      await this.closeDirectCallMedia(row.call_id, authorized.release, 'ended')
      return 'accepted'
    }

    return 'invalid_state'
  }

  async dispatch(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const authorized = authorizeCoordinatorCommand(input)

    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(authorized.release)) {
      return { outcome: 'runtime_disabled', requestId: authorized.requestId }
    }

    const commandId = replayKey(authorized)
    const previous = this.ctx.storage.sql
      .exec<CoordinatorLedgerRow>('select command_id, result_json from coordinator_commands where command_id = ? limit 1', commandId)
      .toArray()[0]
    if (previous) {
      const storedResult = parseStoredCoordinatorResult(previous.result_json)
      if (storedResult) return storedResult
      throw new Error('The communications command replay record is invalid.')
    }

    const now = Date.now()
    this.purgeExpiredState(now)
    const windowStartedAt = Math.floor(now / commandRateWindowMilliseconds) * commandRateWindowMilliseconds
    const rateKey = `${authorized.authorization.tenantId}:${authorized.authorization.employeeId}:${authorized.command.kind}`
    this.ctx.storage.sql.exec(
      `insert into coordinator_rate_windows (rate_key, window_started_at_ms, request_count)
       values (?, ?, 1)
       on conflict (rate_key, window_started_at_ms)
       do update set request_count = request_count + 1`,
      rateKey,
      windowStartedAt,
    )
    const rate = this.ctx.storage.sql
      .exec<CoordinatorRateWindowRow>(
        'select request_count from coordinator_rate_windows where rate_key = ? and window_started_at_ms = ? limit 1',
        rateKey,
        windowStartedAt,
      )
      .toArray()[0]
    if (!rate || rate.request_count > maximumCommandsPerWindow) {
      return { outcome: 'rate_limited', requestId: authorized.requestId }
    }

    const outcome = ['call.request', 'call.accept', 'call.decline', 'call.cancel', 'call.end'].includes(authorized.command.kind)
      ? await this.dispatchCallCommand(authorized, now)
      : authorized.command.kind === 'media.answer'
        ? await this.dispatchMediaAnswer(authorized, now)
        : closedProviderOutcome(closedSygSphereCommsProviderRegistry)
    const result: TenantCommsCoordinatorResult = { outcome, requestId: authorized.requestId }
    return this.recordResult(commandId, result, now)
  }
}

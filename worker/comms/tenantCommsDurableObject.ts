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
  SYGSPHERE_COMMS_WEBSOCKET_TICKET_TTL_MS,
  createSygSphereCommsWebSocketTicket,
  digestSygSphereCommsTicket,
  parseSygSphereCommsFirstSocketFrame,
  parseSygSphereCommsWebSocketRouteReference,
} from './websocketTicket'
import { parseSygSphereCommsCommand } from '../../shared/sygsphere-communications/v1/contract'
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

export type TenantCommsWebSocketBootstrap = Readonly<{
  expiresAt: string
  routeReference: string
  ticket: string
}>

type CoordinatorEnvironment = Env & Readonly<{
  SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED?: string
}>

export type TenantCommsCoordinatorResult = Readonly<{
  outcome: 'runtime_disabled' | 'rate_limited' | 'provider_unavailable'
  requestId: string
}>

const commandRateWindowMilliseconds = 10_000
const maximumCommandsPerWindow = 8
const rateWindowRetentionMilliseconds = 60_000
const commandReplayRetentionMilliseconds = 86_400_000
const maximumRecordsPurgedPerDispatch = 50
const maximumWebSocketFrameBytes = 4_096

const runtimeEnabled = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'true'

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
      && ['runtime_disabled', 'rate_limited', 'provider_unavailable'].includes((parsed as { outcome: string }).outcome)
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
      `)
    })
  }

  private scheduleNextSocketTicketExpiry(): void {
    const next = this.ctx.storage.sql
      .exec<CoordinatorNextExpiryRow>(
        'select expires_at_ms from coordinator_socket_tickets where consumed_at_ms is null order by expires_at_ms asc limit 1',
      )
      .toArray()[0]
    if (next) void this.ctx.storage.setAlarm(next.expires_at_ms)
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

    try {
      const result = await this.dispatch({
        authorization: attachment.authorization,
        command,
        release: attachment.release,
        requestId: crypto.randomUUID(),
      })
      webSocket.send(jsonSocketMessage({ kind: 'command.outcome', outcome: result.outcome, protocolVersion: 1 }))
    } catch {
      webSocket.send(jsonSocketMessage({ kind: 'command.outcome', outcome: 'unavailable', protocolVersion: 1 }))
    }
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

    const result: TenantCommsCoordinatorResult = {
      outcome: closedProviderOutcome(closedSygSphereCommsProviderRegistry),
      requestId: authorized.requestId,
    }
    this.ctx.storage.sql.exec(
      'insert into coordinator_commands (command_id, result_json, created_at_ms) values (?, ?, ?)',
      commandId,
      JSON.stringify(result),
      now,
    )
    return result
  }
}

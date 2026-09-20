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
  grantServerPttFloor,
  prepareServerPttFloor,
  recordServerPttListenerReady,
  recordServerPttMediaNegotiation,
  startServerPttTransmission,
} from './pttLifecycle'
import {
  createServerMeeting,
  endServerMeeting,
  grantServerMeetingMedia,
  joinServerMeeting,
  leaveServerMeeting,
  muteServerMeetingParticipant,
  removeServerMeetingParticipant,
  type ServerMeeting,
} from './meetingLifecycle'
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

type CoordinatorPttTransmissionRow = {
  channel_reference: string
  created_at_ms: number
  lease_expires_at_ms: number
  lease_generation: number
  recipient_employee_ids_json: string
  requester_connection_id: string
  requester_employee_id: string
  scope: 'assignment' | 'shift' | 'site' | 'dispatch'
  state: 'ended' | 'preparing' | 'ready'
  transmission_request_id: string
}

type PttCloseReason = 'cancelled' | 'ended' | 'expired' | 'network_lost' | 'unavailable'

type CoordinatorMeetingRow = {
  allowed_employee_ids_json: string
  conversation_reference: string
  host_connection_id: string
  meeting_id: string
  max_participants: 5 | 10 | 20 | 50
  scope: 'assignment' | 'shift' | 'site' | 'dispatch'
  state: 'active' | 'ended'
}

type CoordinatorMeetingParticipantRow = {
  connection_id: string
  employee_id: string
  muted: 0 | 1
}

type CoordinatorMeetingMediaSessionRow = {
  connection_id: string
  created_at_ms: number
  media_kind: 'audio' | 'screen' | 'video'
  meeting_id: string
  session_json: string
  source_connection_id: string
  track_id: string
  updated_at_ms: number
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

const pttAudioStartSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  channelReference: z.uuid(),
  connectionRouteReference: z.uuid(),
  offer: z.string().min(1).max(65_536),
  release: coordinatorReleaseContextSchema,
  requestId: z.uuid(),
  transmissionRequestId: z.uuid(),
}).strict()

// A remote Cloudflare subscription is provider-offer driven. Unlike a
// publisher, a listener must never supply browser SDP when it asks the
// coordinator to create the remote track.
const pttListenStartSchema = pttAudioStartSchema.omit({ channelReference: true, offer: true })
const pttAudioPreparationSchema = pttAudioStartSchema.omit({ offer: true })
const pttListenPreparationSchema = pttListenStartSchema
const pttListenerReadySchema = pttListenPreparationSchema
const pttListenerFailedSchema = pttListenPreparationSchema

const meetingMediaKindSchema = z.enum(['audio', 'screen', 'video'])
const meetingMediaPreparationSchema = z.object({
  authorization: stagedCommsAuthorizationContextSchema,
  connectionRouteReference: z.uuid(),
  mediaKind: meetingMediaKindSchema,
  meetingId: z.uuid(),
  release: coordinatorReleaseContextSchema,
  requestId: z.uuid(),
  sourceConnectionId: z.uuid().optional(),
}).strict()
const meetingMediaStartSchema = meetingMediaPreparationSchema.extend({ offer: z.string().min(1).max(65_536) }).strict()
const meetingMediaStopSchema = meetingMediaPreparationSchema.omit({ sourceConnectionId: true })

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
  outcome: 'accepted' | 'channel_busy' | 'invalid_state' | 'recipient_unavailable' | 'runtime_disabled' | 'rate_limited' | 'provider_unavailable'
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
// PTT preparation spans protected TURN, browser ICE, provider publication,
// remote subscription, and the listener's mandatory provider renegotiation.
// The coordinator renews this only while it independently verifies the exact
// live reservation; the hard cap still prevents a client from retaining a
// channel indefinitely during a failed setup.
const pttPreparingMilliseconds = 60_000
const pttMaximumPreparationLifetimeMilliseconds = 180_000
const pttLeaseMilliseconds = 6_000

/**
 * Extends a still-valid server reservation without ever reviving an expired
 * one or exceeding its original absolute preparation deadline. Every input is
 * supplied by coordinator storage or server constants; browsers never choose
 * either duration.
 */
export const extendServerPttPreparationLease = (input: Readonly<{
  createdAtMs: number
  currentLeaseExpiresAtMs: number
  maximumPreparationLifetimeMs: number
  nowMs: number
  setupExtensionMs: number
}>): number | null => {
  if (
    !Number.isSafeInteger(input.createdAtMs)
    || !Number.isSafeInteger(input.currentLeaseExpiresAtMs)
    || !Number.isSafeInteger(input.maximumPreparationLifetimeMs)
    || !Number.isSafeInteger(input.nowMs)
    || !Number.isSafeInteger(input.setupExtensionMs)
    || input.createdAtMs <= 0
    || input.maximumPreparationLifetimeMs <= 0
    || input.setupExtensionMs <= 0
    || input.currentLeaseExpiresAtMs <= input.nowMs
  ) return null

  const absoluteDeadlineMs = input.createdAtMs + input.maximumPreparationLifetimeMs
  const requestedDeadlineMs = input.nowMs + input.setupExtensionMs
  if (!Number.isSafeInteger(absoluteDeadlineMs) || !Number.isSafeInteger(requestedDeadlineMs) || input.nowMs >= absoluteDeadlineMs) return null

  const extendedLeaseExpiresAtMs = Math.min(
    absoluteDeadlineMs,
    Math.max(input.currentLeaseExpiresAtMs, requestedDeadlineMs),
  )
  return extendedLeaseExpiresAtMs > input.nowMs ? extendedLeaseExpiresAtMs : null
}

/**
 * Floor renewals are independently sequenced from WebRTC media negotiation.
 * The browser deliberately ignores a duplicate or older renewal, so each
 * accepted renewal must receive a strictly increasing server-owned value.
 */
export const nextServerPttLeaseGeneration = (currentGeneration: number): number | null =>
  Number.isSafeInteger(currentGeneration)
    && currentGeneration >= 0
    && currentGeneration < Number.MAX_SAFE_INTEGER
    ? currentGeneration + 1
    : null

const runtimeEnabled = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'true'

/**
 * These diagnostics are deliberately narrower than the provider diagnostics.
 * They identify a setup boundary that failed before Cloudflare can receive a
 * request, without placing employee data, provider handles, configuration
 * names, exception text, or credentials in production logs.
 */
export type SygSphereCommsSetupUnavailableStage =
  | 'runtime_flag_disabled'
  | 'release_gate_not_ready'
  | 'app_secret_read_failed'
  | 'app_secret_missing'
  | 'turn_token_read_failed'
  | 'turn_token_missing'
  | 'adapter_construction_rejected'

export type SygSphereCommsSetupOperation =
  | 'direct_media'
  | 'meeting_media'
  | 'other_media'
  | 'ptt_listener_failed'
  | 'ptt_listener_ready'
  | 'ptt_prepare_listener'
  | 'ptt_prepare_publisher'
  | 'ptt_start_listener'
  | 'ptt_start_publisher'

export type SygSphereCommsSetupUnavailableDiagnostic = Readonly<{
  event: 'sygsphere_communications_setup_unavailable'
  operation: SygSphereCommsSetupOperation
  stage: SygSphereCommsSetupUnavailableStage
}>

type SecretValueReadResult =
  | Readonly<{ outcome: 'available', value: string }>
  | Readonly<{ outcome: 'missing' }>
  | Readonly<{ outcome: 'read_failed' }>

export const readSygSphereCommsSecret = async (
  value: SecretsStoreSecretBinding | string | undefined,
): Promise<SecretValueReadResult> => {
  if (typeof value === 'string') return value.trim().length > 0
    ? { outcome: 'available', value }
    : { outcome: 'missing' }
  if (!value) return { outcome: 'missing' }
  try {
    const resolved = await value.get()
    return resolved.trim().length > 0
      ? { outcome: 'available', value: resolved }
      : { outcome: 'missing' }
  } catch {
    return { outcome: 'read_failed' }
  }
}

export const sygsphereCommsSetupUnavailableDiagnostic = (
  stage: SygSphereCommsSetupUnavailableStage,
  operation: SygSphereCommsSetupOperation,
): SygSphereCommsSetupUnavailableDiagnostic => ({
  event: 'sygsphere_communications_setup_unavailable',
  operation,
  stage,
})

const reportSygSphereCommsSetupUnavailable = (
  stage: SygSphereCommsSetupUnavailableStage,
  operation: SygSphereCommsSetupOperation,
): void => {
  try {
    console.warn(JSON.stringify(sygsphereCommsSetupUnavailableDiagnostic(stage, operation)))
  } catch {
    // Observability must never change a protected communications outcome.
  }
}

/**
 * Availability is intentionally recorded as a small fixed vocabulary. It is
 * useful to operators investigating a failed call or PTT request, but never
 * identifies a person, tenant, socket, permission, or channel in logs or in
 * the response returned to the browser.
 */
export type SygSphereCommsAvailabilityOperation = 'direct_call_request' | 'ptt_floor_request'

export type SygSphereCommsAvailabilityReason =
  | 'channel_busy'
  | 'no_listener_connected'
  | 'no_listener_eligible'
  | 'recipient_not_connected'
  | 'recipient_not_eligible'

export type SygSphereCommsAvailabilityDiagnostic = Readonly<{
  event: 'sygsphere_communications_availability_unavailable'
  operation: SygSphereCommsAvailabilityOperation
  reason: SygSphereCommsAvailabilityReason
}>

export const sygsphereCommsAvailabilityDiagnostic = (
  operation: SygSphereCommsAvailabilityOperation,
  reason: SygSphereCommsAvailabilityReason,
): SygSphereCommsAvailabilityDiagnostic => ({
  event: 'sygsphere_communications_availability_unavailable',
  operation,
  reason,
})

const reportSygSphereCommsAvailability = (
  operation: SygSphereCommsAvailabilityOperation,
  reason: SygSphereCommsAvailabilityReason,
): void => {
  try {
    console.warn(JSON.stringify(sygsphereCommsAvailabilityDiagnostic(operation, reason)))
  } catch {
    // Observability must never change a protected communications outcome.
  }
}

export const resolveSygSphereCommsDirectAvailabilityReason = (
  hasConnectedRecipient: boolean,
  hasEligibleRecipient: boolean,
): Extract<SygSphereCommsAvailabilityReason, 'recipient_not_connected' | 'recipient_not_eligible'> | null => {
  if (hasEligibleRecipient) return null
  return hasConnectedRecipient ? 'recipient_not_eligible' : 'recipient_not_connected'
}

export const resolveSygSphereCommsPttAvailabilityReason = (
  hasConnectedListener: boolean,
  hasEligibleListener: boolean,
): Extract<SygSphereCommsAvailabilityReason, 'no_listener_connected' | 'no_listener_eligible'> | null => {
  if (hasEligibleListener) return null
  return hasConnectedListener ? 'no_listener_eligible' : 'no_listener_connected'
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
      && ['accepted', 'channel_busy', 'invalid_state', 'recipient_unavailable', 'runtime_disabled', 'rate_limited', 'provider_unavailable'].includes((parsed as { outcome: string }).outcome)
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
        create table if not exists coordinator_ptt_transmissions (
          transmission_request_id text primary key,
          channel_reference text not null,
          requester_employee_id text not null,
          requester_connection_id text not null,
          recipient_employee_ids_json text not null,
          scope text not null check (scope in ('assignment', 'shift', 'site', 'dispatch')),
          state text not null check (state in ('preparing', 'ready', 'ended')),
          lease_expires_at_ms integer not null,
          lease_generation integer not null default 0 check (lease_generation >= 0),
          created_at_ms integer not null,
          updated_at_ms integer not null
        );
        create unique index if not exists coordinator_ptt_one_active_floor_per_channel_idx
          on coordinator_ptt_transmissions (channel_reference)
          where state in ('preparing', 'ready');
        create index if not exists coordinator_ptt_transmissions_expiry_idx
          on coordinator_ptt_transmissions (state, lease_expires_at_ms);
        create table if not exists coordinator_ptt_listener_requirements (
          transmission_request_id text not null,
          connection_id text not null,
          employee_id text not null,
          ready_at_ms integer,
          primary key (transmission_request_id, connection_id)
        );
        create index if not exists coordinator_ptt_listener_requirements_ready_idx
          on coordinator_ptt_listener_requirements (transmission_request_id, ready_at_ms);
        create table if not exists coordinator_ptt_media_negotiations (
          transmission_request_id text primary key,
          negotiation_id text not null,
          source_ready_at_ms integer not null,
          expires_at_ms integer not null
        );
        create table if not exists coordinator_meetings (
          meeting_id text primary key,
          conversation_reference text not null,
          host_connection_id text not null,
          allowed_employee_ids_json text not null,
          scope text not null check (scope in ('assignment', 'shift', 'site', 'dispatch')),
          max_participants integer not null check (max_participants in (5, 10, 20, 50)),
          state text not null check (state in ('active', 'ended')),
          created_at_ms integer not null,
          updated_at_ms integer not null
        );
        create table if not exists coordinator_meeting_participants (
          meeting_id text not null,
          connection_id text not null,
          employee_id text not null,
          muted integer not null check (muted in (0, 1)),
          joined_at_ms integer not null,
          primary key (meeting_id, connection_id)
        );
        create index if not exists coordinator_meeting_participants_employee_idx
          on coordinator_meeting_participants (meeting_id, employee_id, joined_at_ms desc);
        create table if not exists coordinator_meeting_muted_employees (
          meeting_id text not null,
          employee_id text not null,
          muted_at_ms integer not null,
          primary key (meeting_id, employee_id)
        );
        create table if not exists coordinator_meeting_media_grants (
          meeting_id text not null,
          connection_id text not null,
          media_kind text not null check (media_kind in ('screen', 'video')),
          granted_at_ms integer not null,
          primary key (meeting_id, connection_id, media_kind)
        );
        create table if not exists coordinator_meeting_media_sessions (
          meeting_id text not null,
          connection_id text not null,
          source_connection_id text not null,
          media_kind text not null check (media_kind in ('audio', 'screen', 'video')),
          session_json text not null,
          track_id text not null,
          created_at_ms integer not null,
          updated_at_ms integer not null,
          primary key (meeting_id, connection_id, source_connection_id, media_kind)
        );
        create index if not exists coordinator_meeting_media_sessions_source_idx
          on coordinator_meeting_media_sessions (meeting_id, source_connection_id, media_kind, updated_at_ms desc);
      `)
      const pttTransmissionColumns = this.ctx.storage.sql
        .exec<{ name: string }>("pragma table_info('coordinator_ptt_transmissions')")
        .toArray()
      if (!pttTransmissionColumns.some((column) => column.name === 'lease_generation')) {
        this.ctx.storage.sql.exec(
          'alter table coordinator_ptt_transmissions add column lease_generation integer not null default 0',
        )
      }
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
    const nextPtt = this.ctx.storage.sql
      .exec<CoordinatorNextExpiryRow>(
        `select lease_expires_at_ms as expires_at_ms from coordinator_ptt_transmissions
         where state in ('preparing', 'ready') order by lease_expires_at_ms asc limit 1`,
      )
      .toArray()[0]
    const nextExpiry = [next?.expires_at_ms, nextCall?.expires_at_ms, nextPtt?.expires_at_ms]
      .filter((value): value is number => typeof value === 'number')
      .sort((left, right) => left - right)[0]
    if (nextExpiry !== undefined) void this.ctx.storage.setAlarm(nextExpiry)
  }

  /**
   * Called only from the protected server bootstrap. The opaque route
   * reference is carried by the calling tab and validated at the Worker
   * boundary, while the raw ticket is delivered to the already-authenticated
   * browser and must be supplied
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
    // The Worker has already parsed the browser offer and replaced it with the
    // one canonical route protocol. Echo that selected protocol in the 101
    // response: without it, browsers reject the opening socket before the
    // one-use ticket can authenticate.
    const selectedProtocol = request.headers.get('sec-websocket-protocol')
    const selectedProtocolPrefix = 'sygsphere-comms-route.'
    const selectedProtocolSuffix = `.${routeReference}`
    const selectedTenantId = selectedProtocol?.startsWith(selectedProtocolPrefix)
      && selectedProtocol.endsWith(selectedProtocolSuffix)
      ? selectedProtocol.slice(selectedProtocolPrefix.length, -selectedProtocolSuffix.length)
      : null
    if (
      !selectedProtocol
      || selectedProtocol.includes(',')
      || !selectedTenantId
      || !z.uuid().safeParse(selectedTenantId).success
    ) return new Response('Communications connection unavailable.', { status: 404 })

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
    return new Response(null, {
      headers: { 'sec-websocket-protocol': selectedProtocol },
      status: 101,
      webSocket: client,
    } as unknown as ResponseInit)
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
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'update coordinator_socket_connections set closed_at_ms = ? where connection_id = ? and closed_at_ms is null',
      now,
      attachment.connectionId,
    )
    const ownedFloors = this.ctx.storage.sql.exec<CoordinatorPttTransmissionRow>(
      `select transmission_request_id, channel_reference, requester_employee_id,
              requester_connection_id, recipient_employee_ids_json, scope, state,
              lease_expires_at_ms, lease_generation, created_at_ms
       from coordinator_ptt_transmissions
       where requester_connection_id = ? and state in ('preparing', 'ready')`,
      attachment.connectionId,
    ).toArray()
    for (const floor of ownedFloors) {
      await this.closePttTransmission(floor, attachment.release, 'network_lost')
    }
    this.scheduleNextSocketTicketExpiry()
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
    await this.expirePttTransmissions(now)
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

  /** A PTT source must remain the exact authenticated browser connection that
   * reserved the floor. Employee identity alone is not sufficient after a
   * reconnect because the prior connection may already be stale. */
  private activeSocketByConnectionId(connectionId: string): AuthenticatedSocketAttachment | null {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (attachment?.phase === 'authenticated' && attachment.connectionId === connectionId) return attachment
    }
    return null
  }

  /** Direct-call delivery must be resolved from a current, same-tenant
   * authenticated socket. The coordinator never treats a browser-provided
   * recipient list, a cross-tenant socket, or a caller's own connection as a
   * recipient. */
  private directRecipientAvailability(
    employeeId: string,
    caller: AuthenticatedSocketAttachment,
  ): Readonly<{
    recipient: AuthenticatedSocketAttachment | null
    unavailableReason: Extract<SygSphereCommsAvailabilityReason, 'recipient_not_connected' | 'recipient_not_eligible'> | null
  }> {
    let hasConnectedRecipient = false
    let newestEligibleRecipient: AuthenticatedSocketAttachment | null = null
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (
        attachment?.phase !== 'authenticated'
        || attachment.authorization.tenantId !== caller.authorization.tenantId
        || attachment.authorization.employeeId !== employeeId
        || attachment.connectionId === caller.connectionId
      ) continue
      hasConnectedRecipient = true
      if (!attachment.authorization.permissions.includes('sygsphere.comms.call.receive')) continue
      if (newestEligibleRecipient === null || attachment.openedAtMs > newestEligibleRecipient.openedAtMs) {
        newestEligibleRecipient = attachment
      }
    }
    return {
      recipient: newestEligibleRecipient,
      unavailableReason: resolveSygSphereCommsDirectAvailabilityReason(
        hasConnectedRecipient,
        newestEligibleRecipient !== null,
      ),
    }
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

  private pttRuntimeMayPrepare(
    release: CoordinatorReleaseContext,
    operation: SygSphereCommsSetupOperation,
  ): boolean {
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED)) {
      reportSygSphereCommsSetupUnavailable('runtime_flag_disabled', operation)
      return false
    }
    if (!coordinatorRuntimeMayDispatch(release)) {
      reportSygSphereCommsSetupUnavailable('release_gate_not_ready', operation)
      return false
    }
    return true
  }

  private async providerAdapter(
    release: CoordinatorReleaseContext,
    operation: SygSphereCommsSetupOperation = 'other_media',
  ): Promise<CloudflareRealtimeHttpAdapter | null> {
    try {
      const [appSecretResult, turnApiTokenResult] = await Promise.all([
        readSygSphereCommsSecret(this.env.SYGSHIFT_COMMS_REALTIME_APP_SECRET),
        readSygSphereCommsSecret(this.env.SYGSHIFT_COMMS_TURN_API_TOKEN),
      ])
      if (appSecretResult.outcome !== 'available') {
        reportSygSphereCommsSetupUnavailable(
          appSecretResult.outcome === 'read_failed' ? 'app_secret_read_failed' : 'app_secret_missing',
          operation,
        )
        return null
      }
      if (turnApiTokenResult.outcome !== 'available') {
        reportSygSphereCommsSetupUnavailable(
          turnApiTokenResult.outcome === 'read_failed' ? 'turn_token_read_failed' : 'turn_token_missing',
          operation,
        )
        return null
      }
      if (!this.env.SYGSHIFT_COMMS_REALTIME_APP_ID || !this.env.SYGSHIFT_COMMS_TURN_KEY_ID) {
        reportSygSphereCommsSetupUnavailable('adapter_construction_rejected', operation)
        return null
      }
      const adapter = createCloudflareRealtimeRuntimeHttpAdapter({
        appId: this.env.SYGSHIFT_COMMS_REALTIME_APP_ID,
        appSecret: appSecretResult.value,
        coordinatorReleaseMayDispatch: coordinatorRuntimeMayDispatch(release),
        runtimeEnabled: runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED),
        turnApiToken: turnApiTokenResult.value,
        turnKeyId: this.env.SYGSHIFT_COMMS_TURN_KEY_ID,
      })
      if (!adapter) reportSygSphereCommsSetupUnavailable('adapter_construction_rejected', operation)
      return adapter
    } catch {
      // No raw exception text can reach logs or an employee. The operation is
      // enough to correlate a broken setup path with provider diagnostics.
      reportSygSphereCommsSetupUnavailable('adapter_construction_rejected', operation)
      return null
    }
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
    expiresAtMs?: number
    generation: number
    peerHandle: string
    sessionId: string
  }>, now: number): Readonly<{ expiresAt: string, negotiationId: string }> {
    const negotiationId = crypto.randomUUID()
    const expiresAtMs = input.expiresAtMs ?? now + 30_000
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
    if (
      providerResult.outcome !== 'accepted'
      || providerResult.value.requiresImmediateRenegotiation !== true
      || providerResult.value.sessionDescription?.type !== 'offer'
    ) {
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
    // A PTT listener answer may only arrive through its own room. This keeps a
    // valid coordinator-issued negotiation from being replayed through an
    // unrelated call or meeting envelope.
    if (this.pttTransmission(negotiation.call_id) && authorized.command.roomId !== `ptt:${negotiation.call_id}`) return 'invalid_state'
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
      if (!scope || scope.kind !== 'direct_conversation') return 'invalid_state'
      const recipientAvailability = this.directRecipientAvailability(scope.recipientEmployeeId, caller)
      const recipient = recipientAvailability.recipient
      if (!recipient) {
        reportSygSphereCommsAvailability(
          'direct_call_request',
          recipientAvailability.unavailableReason ?? 'recipient_not_connected',
        )
        return 'recipient_unavailable'
      }
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

  private meetingById(meetingId: string): CoordinatorMeetingRow | null {
    return this.ctx.storage.sql.exec<CoordinatorMeetingRow>(
      `select meeting_id, conversation_reference, host_connection_id,
              allowed_employee_ids_json, scope, max_participants, state
       from coordinator_meetings where meeting_id = ? limit 1`,
      meetingId,
    ).toArray()[0] ?? null
  }

  private meetingParticipantRows(meetingId: string): readonly CoordinatorMeetingParticipantRow[] {
    return this.ctx.storage.sql.exec<CoordinatorMeetingParticipantRow>(
      `select connection_id, employee_id, muted
       from coordinator_meeting_participants where meeting_id = ? order by joined_at_ms asc`,
      meetingId,
    ).toArray()
  }

  private isMeetingEmployeeMuted(meetingId: string, employeeId: string): boolean {
    return this.ctx.storage.sql.exec<{ employee_id: string }>(
      `select employee_id from coordinator_meeting_muted_employees
       where meeting_id = ? and employee_id = ? limit 1`,
      meetingId,
      employeeId,
    ).toArray().length === 1
  }

  private meetingParticipantEmployeeId(meetingId: string, connectionId: string): string | null {
    return this.ctx.storage.sql.exec<{ employee_id: string }>(
      `select employee_id from coordinator_meeting_participants
       where meeting_id = ? and connection_id = ? limit 1`,
      meetingId,
      connectionId,
    ).toArray()[0]?.employee_id ?? null
  }

  private meetingAllowedEmployeeIds(row: CoordinatorMeetingRow): readonly string[] {
    try {
      const parsed = z.array(z.uuid()).min(1).max(50).safeParse(JSON.parse(row.allowed_employee_ids_json))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  private storedMeeting(row: CoordinatorMeetingRow): ServerMeeting | null {
    const allowed = this.meetingAllowedEmployeeIds(row)
    if (!allowed.length) return null
    const participants = new Map(this.meetingParticipantRows(row.meeting_id).map((participant) => [
      participant.connection_id,
      {
        connectionId: participant.connection_id,
        muted: participant.muted === 1 || this.isMeetingEmployeeMuted(row.meeting_id, participant.employee_id),
      },
    ]))
    return {
      hostConnectionId: row.host_connection_id,
      maxParticipants: row.max_participants,
      meetingId: row.meeting_id,
      participants,
      state: row.state,
    }
  }

  private sendMeetingEvent(
    connectionIds: readonly string[],
    meetingId: string,
    kind: Extract<SygSphereCommsEventKind, 'meeting.created' | 'meeting.joined' | 'meeting.ended' | 'participant.changed' | 'participant.removed' | 'participant.muted' | 'camera.granted' | 'camera.denied' | 'camera.revoked' | 'screen.granted' | 'screen.denied' | 'screen.revoked' | 'focus.granted' | 'focus.denied' | 'focus.revoked'>,
    payload: Record<string, unknown>,
  ): void {
    for (const connectionId of new Set(connectionIds)) this.sendCoordinatorEvent(connectionId, `meeting:${meetingId}`, kind, payload)
  }

  private meetingParticipantConnectionIds(meetingId: string): readonly string[] {
    return this.meetingParticipantRows(meetingId).map((participant) => participant.connection_id)
  }

  private async dispatchMeetingCommand(
    authorized: AuthorizedCoordinatorCommand,
    now: number,
  ): Promise<TenantCommsCoordinatorResult['outcome']> {
    const routeReference = authorized.connectionRouteReference
    if (!routeReference) return 'invalid_state'
    const caller = this.activeSocketForRoute(routeReference, authorized.authorization)
    if (!caller) return 'invalid_state'

    if (authorized.command.kind === 'meeting.create') {
      const scope = authorized.scope
      if (!scope || scope.kind !== 'channel_conversation') return 'invalid_state'
      const clientIntentId: unknown = (authorized.command.payload as Record<string, unknown>).clientIntentId
      if (typeof clientIntentId !== 'string') return 'invalid_state'
      const meetingId: string = clientIntentId
      if (this.meetingById(meetingId)) return 'accepted'
      const created = createServerMeeting({ hostConnectionId: caller.connectionId, maxParticipants: 50, meetingId })
      this.ctx.storage.sql.exec(
        `insert into coordinator_meetings (
          meeting_id, conversation_reference, host_connection_id,
          allowed_employee_ids_json, scope, max_participants, state, created_at_ms, updated_at_ms
        ) values (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        meetingId,
        scope.channelReference,
        caller.connectionId,
        JSON.stringify(scope.participantEmployeeIds),
        scope.scope,
        created.state.maxParticipants,
        now,
        now,
      )
      this.ctx.storage.sql.exec(
        `insert into coordinator_meeting_participants (
          meeting_id, connection_id, employee_id, muted, joined_at_ms
        ) values (?, ?, ?, 0, ?)`,
        meetingId,
        caller.connectionId,
        caller.authorization.employeeId,
        now,
      )
      this.sendMeetingEvent([caller.connectionId], meetingId, 'meeting.created', {
        hostConnectionId: caller.connectionId,
        invited: false,
        meetingId,
      })
      const invited = new Set(scope.participantEmployeeIds)
      for (const webSocket of this.ctx.getWebSockets()) {
        const attachment = socketAttachment(webSocket)
        if (
          attachment?.phase !== 'authenticated'
          || attachment.connectionId === caller.connectionId
          || attachment.authorization.tenantId !== caller.authorization.tenantId
          || !invited.has(attachment.authorization.employeeId)
        ) continue
        this.sendMeetingEvent([attachment.connectionId], meetingId, 'meeting.created', {
          hostConnectionId: caller.connectionId,
          invited: true,
          meetingId,
        })
      }
      return 'accepted'
    }

    const commandPayload = authorized.command.payload as Record<string, unknown>
    const meetingId = typeof commandPayload.meetingId === 'string'
      ? commandPayload.meetingId
      : typeof commandPayload.callId === 'string'
        ? commandPayload.callId
        : null
    if (!meetingId) return 'invalid_state'
    const row = this.meetingById(meetingId)
    const meeting = row ? this.storedMeeting(row) : null
    if (!row || !meeting || row.state !== 'active') return 'invalid_state'
    const allowedEmployees = this.meetingAllowedEmployeeIds(row)
    const callerIsAllowed = allowedEmployees.includes(caller.authorization.employeeId)
    const existingParticipant = meeting.participants.get(caller.connectionId)

    if (authorized.command.kind === 'meeting.join') {
      const joined = joinServerMeeting(meeting, { coordinatorAuthorized: callerIsAllowed, participantConnectionId: caller.connectionId })
      if (!callerIsAllowed) return 'invalid_state'
      if (joined.event) {
        this.ctx.storage.sql.exec(
          `insert into coordinator_meeting_participants (
            meeting_id, connection_id, employee_id, muted, joined_at_ms
          ) values (?, ?, ?, 0, ?)`,
          meetingId,
          caller.connectionId,
          caller.authorization.employeeId,
          now,
        )
        this.ctx.storage.sql.exec('update coordinator_meetings set updated_at_ms = ? where meeting_id = ?', now, meetingId)
        const otherConnections = [...meeting.participants.keys()]
        this.sendMeetingEvent(otherConnections, meetingId, 'participant.changed', {
          meetingId,
          participantConnectionId: caller.connectionId,
          state: 'joined',
        })
        for (const participantConnectionId of otherConnections) {
          this.sendMeetingEvent([caller.connectionId], meetingId, 'participant.changed', {
            meetingId,
            participantConnectionId,
            state: 'joined',
          })
        }
        for (const source of this.meetingMediaSourceRows(meetingId)) {
          if (source.source_connection_id === caller.connectionId) continue
          this.sendCoordinatorEvent(caller.connectionId, `meeting:${meetingId}`, 'media.source.available', {
            callId: meetingId,
            mediaKind: source.media_kind,
            participantConnectionId: source.source_connection_id,
            trackReference: source.track_id,
          })
        }
      } else if (!existingParticipant) return 'invalid_state'
      this.sendMeetingEvent([caller.connectionId], meetingId, 'meeting.joined', { meetingId, participantConnectionId: caller.connectionId })
      return 'accepted'
    }

    if (!existingParticipant) return 'invalid_state'

    if (authorized.command.kind === 'meeting.leave') {
      if (caller.connectionId === row.host_connection_id) {
        const ended = endServerMeeting(meeting, { coordinatorMayModerate: true, reason: 'ended' })
        if (!ended.event) return 'invalid_state'
        const participantConnections = this.meetingParticipantConnectionIds(meetingId)
        for (const connectionId of participantConnections) await this.closeMeetingMediaForParticipant(meetingId, connectionId, authorized.release, 'ended')
        this.ctx.storage.sql.exec('update coordinator_meetings set state = \'ended\', updated_at_ms = ? where meeting_id = ?', now, meetingId)
        this.ctx.storage.sql.exec('delete from coordinator_meeting_muted_employees where meeting_id = ?', meetingId)
        this.sendMeetingEvent(participantConnections, meetingId, 'meeting.ended', ended.event.payload)
        return 'accepted'
      }
      const left = leaveServerMeeting(meeting, caller.connectionId)
      if (!left.event) return 'invalid_state'
      await this.closeMeetingMediaForParticipant(meetingId, caller.connectionId, authorized.release, 'ended')
      this.ctx.storage.sql.exec('delete from coordinator_meeting_participants where meeting_id = ? and connection_id = ?', meetingId, caller.connectionId)
      this.ctx.storage.sql.exec('update coordinator_meetings set updated_at_ms = ? where meeting_id = ?', now, meetingId)
      this.sendMeetingEvent(this.meetingParticipantConnectionIds(meetingId), meetingId, 'participant.changed', left.event.payload)
      return 'accepted'
    }

    if (authorized.command.kind === 'meeting.end') {
      const mayEnd = caller.connectionId === row.host_connection_id || authorized.authorization.permissions.includes('sygsphere.comms.moderate')
      const ended = endServerMeeting(meeting, { coordinatorMayModerate: mayEnd, reason: 'ended' })
      if (!ended.event) return 'invalid_state'
      const participantConnections = this.meetingParticipantConnectionIds(meetingId)
      for (const connectionId of participantConnections) await this.closeMeetingMediaForParticipant(meetingId, connectionId, authorized.release, 'ended')
      this.ctx.storage.sql.exec('update coordinator_meetings set state = \'ended\', updated_at_ms = ? where meeting_id = ?', now, meetingId)
      this.ctx.storage.sql.exec('delete from coordinator_meeting_muted_employees where meeting_id = ?', meetingId)
      this.sendMeetingEvent(participantConnections, meetingId, 'meeting.ended', ended.event.payload)
      return 'accepted'
    }

    if (authorized.command.kind === 'participant.remove' || authorized.command.kind === 'participant.mute') {
      const targetConnectionId = typeof commandPayload.participantConnectionId === 'string'
        ? commandPayload.participantConnectionId
        : null
      if (!targetConnectionId) return 'invalid_state'
      const moderationAllowed = authorized.authorization.permissions.includes('sygsphere.comms.moderate')
      const changed = authorized.command.kind === 'participant.remove'
        ? removeServerMeetingParticipant(meeting, { coordinatorMayModerate: moderationAllowed, participantConnectionId: targetConnectionId })
        : muteServerMeetingParticipant(meeting, { coordinatorMayModerate: moderationAllowed, participantConnectionId: targetConnectionId })
      if (!changed.event) return 'invalid_state'
      if (authorized.command.kind === 'participant.remove') {
        await this.closeMeetingMediaForParticipant(meetingId, targetConnectionId, authorized.release, 'moderated')
        this.ctx.storage.sql.exec('delete from coordinator_meeting_participants where meeting_id = ? and connection_id = ?', meetingId, targetConnectionId)
      } else {
        const targetEmployeeId = this.meetingParticipantEmployeeId(meetingId, targetConnectionId)
        if (!targetEmployeeId) return 'invalid_state'
        await this.closeMeetingPublishedMedia(meetingId, targetConnectionId, authorized.release, 'moderated')
        this.ctx.storage.sql.exec('update coordinator_meeting_participants set muted = 1 where meeting_id = ? and connection_id = ?', meetingId, targetConnectionId)
        this.ctx.storage.sql.exec(
          `insert into coordinator_meeting_muted_employees (meeting_id, employee_id, muted_at_ms)
           values (?, ?, ?)
           on conflict (meeting_id, employee_id) do update set muted_at_ms = excluded.muted_at_ms`,
          meetingId,
          targetEmployeeId,
          now,
        )
        this.sendCoordinatorEvent(targetConnectionId, `meeting:${meetingId}`, 'media.closed', {
          callId: meetingId,
          generation: 1,
          reason: 'moderated',
        })
      }
      this.sendMeetingEvent(this.meetingParticipantConnectionIds(meetingId), meetingId, changed.event.kind, changed.event.payload)
      if (authorized.command.kind === 'participant.mute') {
        this.sendMeetingEvent([targetConnectionId], meetingId, 'participant.muted', {
          ...changed.event.payload,
          self: true,
        })
      }
      return 'accepted'
    }

    if (authorized.command.kind === 'camera.request' || authorized.command.kind === 'screen.request') {
      const kind = authorized.command.kind === 'camera.request' ? 'camera' : 'screen'
      const granted = grantServerMeetingMedia({
        callId: meetingId,
        coordinatorAuthorized: true,
        deviceSupported: true,
        generation: 1,
        kind,
        meeting,
        participantConnectionId: caller.connectionId,
        trackReference: `meeting:${meetingId}:${caller.connectionId}:${kind}`,
      })
      const grantedEvent = 'event' in granted ? granted.event : granted
      if ('event' in granted) {
        this.ctx.storage.sql.exec(
          `insert into coordinator_meeting_media_grants (meeting_id, connection_id, media_kind, granted_at_ms)
           values (?, ?, ?, ?)
           on conflict (meeting_id, connection_id, media_kind) do update set granted_at_ms = excluded.granted_at_ms`,
          meetingId,
          caller.connectionId,
          kind === 'camera' ? 'video' : 'screen',
          now,
        )
      }
      this.sendMeetingEvent([caller.connectionId], meetingId, grantedEvent.kind, grantedEvent.payload)
      return 'event' in granted ? 'accepted' : 'recipient_unavailable'
    }

    if (authorized.command.kind === 'camera.release' || authorized.command.kind === 'screen.release') {
      const kind = authorized.command.kind === 'camera.release' ? 'camera' : 'screen'
      const mediaKind = kind === 'camera' ? 'video' : 'screen'
      const rows = this.ctx.storage.sql.exec<CoordinatorMeetingMediaSessionRow>(
        `select meeting_id, connection_id, source_connection_id, media_kind,
                session_json, track_id, created_at_ms, updated_at_ms
         from coordinator_meeting_media_sessions
         where meeting_id = ? and connection_id = ? and source_connection_id = ? and media_kind = ?`,
        meetingId,
        caller.connectionId,
        caller.connectionId,
        mediaKind,
      ).toArray()
      await this.closeMeetingMediaRows(rows, authorized.release, 'ended')
      this.ctx.storage.sql.exec('delete from coordinator_meeting_media_grants where meeting_id = ? and connection_id = ? and media_kind = ?', meetingId, caller.connectionId, mediaKind)
      return 'accepted'
    }

    if (authorized.command.kind === 'focus.request') {
      this.sendMeetingEvent([caller.connectionId], meetingId, 'focus.granted', { callId: meetingId, focusReference: `focus:${meetingId}:${caller.connectionId}` })
      return 'accepted'
    }
    if (authorized.command.kind === 'focus.release') {
      this.sendMeetingEvent([caller.connectionId], meetingId, 'focus.revoked', { callId: meetingId, focusReference: `focus:${meetingId}:${caller.connectionId}`, reason: 'ended' })
      return 'accepted'
    }
    return 'invalid_state'
  }

  private meetingMediaSession(
    meetingId: string,
    connectionId: string,
    sourceConnectionId: string,
    mediaKind: CoordinatorMeetingMediaSessionRow['media_kind'],
  ): CoordinatorMeetingMediaSessionRow | null {
    return this.ctx.storage.sql.exec<CoordinatorMeetingMediaSessionRow>(
      `select meeting_id, connection_id, source_connection_id, media_kind,
              session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_meeting_media_sessions
       where meeting_id = ? and connection_id = ? and source_connection_id = ? and media_kind = ? limit 1`,
      meetingId,
      connectionId,
      sourceConnectionId,
      mediaKind,
    ).toArray()[0] ?? null
  }

  private meetingMediaSourceRows(meetingId: string): readonly CoordinatorMeetingMediaSessionRow[] {
    return this.ctx.storage.sql.exec<CoordinatorMeetingMediaSessionRow>(
      `select meeting_id, connection_id, source_connection_id, media_kind,
              session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_meeting_media_sessions
       where meeting_id = ? and connection_id = source_connection_id
       order by created_at_ms asc`,
      meetingId,
    ).toArray()
  }

  private persistMeetingMediaSession(row: Readonly<{
    connectionId: string
    mediaKind: CoordinatorMeetingMediaSessionRow['media_kind']
    meetingId: string
    session: ProviderSession
    sourceConnectionId: string
    trackId: string
  }>, now: number): void {
    this.ctx.storage.sql.exec(
      `insert into coordinator_meeting_media_sessions (
        meeting_id, connection_id, source_connection_id, media_kind,
        session_json, track_id, created_at_ms, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (meeting_id, connection_id, source_connection_id, media_kind)
       do update set session_json = excluded.session_json, track_id = excluded.track_id, updated_at_ms = excluded.updated_at_ms`,
      row.meetingId,
      row.connectionId,
      row.sourceConnectionId,
      row.mediaKind,
      JSON.stringify({ id: row.session.id, state: row.session.state, tenantId: row.session.tenantId, tracks: [...row.session.tracks.values()] }),
      row.trackId,
      now,
      now,
    )
  }

  private meetingMediaPublicationKind(mediaKind: CoordinatorMeetingMediaSessionRow['media_kind']): 'call_audio' | 'camera' | 'screen' {
    return mediaKind === 'audio' ? 'call_audio' : mediaKind === 'video' ? 'camera' : 'screen'
  }

  private meetingMediaMayPublish(
    meetingId: string,
    connectionId: string,
    mediaKind: CoordinatorMeetingMediaSessionRow['media_kind'],
  ): boolean {
    const meetingRow = this.meetingById(meetingId)
    const participant = meetingRow ? this.storedMeeting(meetingRow)?.participants.get(connectionId) : null
    if (!participant || participant.muted) return false
    if (mediaKind === 'audio') return true
    return this.ctx.storage.sql.exec<{ granted_at_ms: number }>(
      `select granted_at_ms from coordinator_meeting_media_grants
       where meeting_id = ? and connection_id = ? and media_kind = ? limit 1`,
      meetingId,
      connectionId,
      mediaKind,
    ).toArray().length === 1
  }

  private async closeMeetingMediaRows(
    rows: readonly CoordinatorMeetingMediaSessionRow[],
    release: CoordinatorReleaseContext,
    reason: 'ended' | 'moderated' | 'unavailable',
  ): Promise<void> {
    const adapter = await this.providerAdapter(release)
    for (const row of rows) {
      let storedSession: unknown = null
      try {
        storedSession = JSON.parse(row.session_json)
      } catch {
        // Bad persisted media metadata must never prevent a moderator, cleanup,
        // or expiry path from removing the isolated session record.
      }
      const session = storedProviderSessionSchema.safeParse(storedSession)
      const track = session.success ? session.data.tracks.find((candidate) => candidate.id === row.track_id) : null
      if (adapter && session.success && track?.mid) {
        await adapter.forceCloseTracks({
          session: { id: session.data.id, state: session.data.state, tenantId: session.data.tenantId, tracks: new Map(session.data.tracks.map((candidate) => [candidate.id, candidate])) },
          tenantId: session.data.tenantId,
          tracks: [{ mid: track.mid, trackId: track.id }],
        }).catch(() => undefined)
      }
      this.ctx.storage.sql.exec(
        `delete from coordinator_meeting_media_sessions
         where meeting_id = ? and connection_id = ? and source_connection_id = ? and media_kind = ?`,
        row.meeting_id,
        row.connection_id,
        row.source_connection_id,
        row.media_kind,
      )
      if (row.connection_id === row.source_connection_id) {
        const participantConnectionIds = this.meetingParticipantConnectionIds(row.meeting_id)
        for (const participantConnectionId of participantConnectionIds) {
          this.sendCoordinatorEvent(participantConnectionId, `meeting:${row.meeting_id}`, 'media.source.unavailable', {
            callId: row.meeting_id,
            mediaKind: row.media_kind,
            participantConnectionId: row.source_connection_id,
            reason,
            trackReference: row.track_id,
          })
        }
      }
      if (row.connection_id === row.source_connection_id && row.media_kind !== 'audio') {
        this.sendMeetingEvent(this.meetingParticipantConnectionIds(row.meeting_id), row.meeting_id, `${row.media_kind === 'video' ? 'camera' : 'screen'}.revoked` as 'camera.revoked' | 'screen.revoked', {
          callId: row.meeting_id,
          reason,
          trackReference: row.track_id,
        })
      }
    }
  }

  private async closeMeetingMediaForParticipant(
    meetingId: string,
    connectionId: string,
    release: CoordinatorReleaseContext,
    reason: 'ended' | 'moderated' | 'unavailable',
  ): Promise<void> {
    const rows = this.ctx.storage.sql.exec<CoordinatorMeetingMediaSessionRow>(
      `select meeting_id, connection_id, source_connection_id, media_kind,
              session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_meeting_media_sessions
       where meeting_id = ? and (connection_id = ? or source_connection_id = ?)`,
      meetingId,
      connectionId,
      connectionId,
    ).toArray()
    await this.closeMeetingMediaRows(rows, release, reason)
    this.ctx.storage.sql.exec('delete from coordinator_meeting_media_grants where meeting_id = ? and connection_id = ?', meetingId, connectionId)
  }

  private async closeMeetingPublishedMedia(
    meetingId: string,
    connectionId: string,
    release: CoordinatorReleaseContext,
    reason: 'ended' | 'moderated' | 'unavailable',
  ): Promise<void> {
    const rows = this.ctx.storage.sql.exec<CoordinatorMeetingMediaSessionRow>(
      `select meeting_id, connection_id, source_connection_id, media_kind,
              session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_meeting_media_sessions
       where meeting_id = ? and connection_id = ? and source_connection_id = ?`,
      meetingId,
      connectionId,
      connectionId,
    ).toArray()
    await this.closeMeetingMediaRows(rows, release, reason)
  }

  async prepareMeetingMedia(input: unknown): Promise<TenantCommsDirectAudioPreparation> {
    await this.initialization
    const parsed = meetingMediaPreparationSchema.parse(input)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.meetingById(parsed.meetingId)
    const meeting = row ? this.storedMeeting(row) : null
    const sourceConnectionId = parsed.sourceConnectionId ?? caller?.connectionId
    if (!caller || !row || !meeting || row.state !== 'active' || !sourceConnectionId
      || !meeting.participants.has(caller.connectionId)
      || (parsed.sourceConnectionId === undefined && !this.meetingMediaMayPublish(parsed.meetingId, caller.connectionId, parsed.mediaKind))
      || (parsed.sourceConnectionId !== undefined && (!meeting.participants.has(sourceConnectionId)
        || !this.meetingMediaSession(parsed.meetingId, sourceConnectionId, sourceConnectionId, parsed.mediaKind)))) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const adapter = await this.providerAdapter(parsed.release)
    if (!adapter) return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const ice = await adapter.generateIceServers(300)
    return ice.outcome === 'accepted'
      ? { iceServers: ice.value.iceServers, outcome: 'accepted', requestId: parsed.requestId }
      : { outcome: 'provider_unavailable', requestId: parsed.requestId }
  }

  async startMeetingMedia(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = meetingMediaStartSchema.parse(input)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.meetingById(parsed.meetingId)
    const meeting = row ? this.storedMeeting(row) : null
    if (!caller || !row || !meeting || row.state !== 'active' || !meeting.participants.has(caller.connectionId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const subscriber = parsed.sourceConnectionId !== undefined
    const sourceConnectionId = parsed.sourceConnectionId ?? caller.connectionId
    const source = subscriber ? this.meetingMediaSession(parsed.meetingId, sourceConnectionId, sourceConnectionId, parsed.mediaKind) : null
    if (
      (subscriber && (!source || !meeting.participants.has(sourceConnectionId)))
      || (!subscriber && (!this.meetingMediaMayPublish(parsed.meetingId, caller.connectionId, parsed.mediaKind)
        || this.meetingMediaSession(parsed.meetingId, caller.connectionId, caller.connectionId, parsed.mediaKind)))
      || (subscriber && this.meetingMediaSession(parsed.meetingId, caller.connectionId, sourceConnectionId, parsed.mediaKind))
    ) return { outcome: 'invalid_state', requestId: parsed.requestId }
    const adapter = await this.providerAdapter(parsed.release)
    if (!adapter) return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const ice = await adapter.generateIceServers(300)
    const created = await adapter.createSession({ tenantId: caller.authorization.tenantId })
    if (ice.outcome !== 'accepted' || created.outcome !== 'accepted') return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    const pending = activateProviderSession(createProviderSession(created.value.sessionId, caller.authorization.tenantId))
    const trackId = `meeting-${parsed.meetingId}-${sourceConnectionId}-${parsed.mediaKind}`
    const result = subscriber
      ? await adapter.subscribeTracks({
        session: pending,
        sessionDescription: { sdp: parsed.offer, type: 'offer' },
        tenantId: caller.authorization.tenantId,
        tracks: [{
          kind: parsed.mediaKind === 'audio' ? 'audio' : 'video',
          location: 'remote',
          sessionId: storedProviderSessionSchema.parse(JSON.parse(source!.session_json)).id,
          trackName: source!.track_id,
        }],
      })
      : await adapter.publishTracks({
        session: pending,
        sessionDescription: { sdp: parsed.offer, type: 'offer' },
        tenantId: caller.authorization.tenantId,
        tracks: [{ kind: parsed.mediaKind === 'audio' ? 'audio' : 'video', location: 'local', trackName: trackId }],
      })
    const providerTrack = result.outcome === 'accepted' ? result.value.tracks[0] : null
    if (result.outcome !== 'accepted' || !providerTrack?.mid || !result.value.sessionDescription) {
      return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    }
    const registered = registerProviderTrack(pending, {
      id: subscriber ? source!.track_id : trackId,
      kind: parsed.mediaKind === 'audio' ? 'audio' : parsed.mediaKind === 'video' ? 'video' : 'screen',
      mid: providerTrack.mid,
      state: 'active',
    })
    const now = Date.now()
    this.persistMeetingMediaSession({
      connectionId: caller.connectionId,
      mediaKind: parsed.mediaKind,
      meetingId: parsed.meetingId,
      session: registered,
      sourceConnectionId,
      trackId: subscriber ? source!.track_id : trackId,
    }, now)
    this.sendCoordinatorEvent(caller.connectionId, `meeting:${parsed.meetingId}`, 'media.negotiation', {
      callId: parsed.meetingId,
      description: result.value.sessionDescription.sdp,
      descriptionType: result.value.sessionDescription.type,
      direction: subscriber ? 'subscribe' : 'publish',
      expiresAt: new Date(now + 30_000).toISOString(),
      generation: 1,
      iceServers: ice.value.iceServers,
      negotiationId: crypto.randomUUID(),
      peerHandle: `peer:${registered.id}`,
      trackBindings: [{
        mediaKind: parsed.mediaKind === 'audio' ? 'audio' : 'video',
        participantConnectionId: subscriber ? sourceConnectionId : undefined,
        publicationKind: this.meetingMediaPublicationKind(parsed.mediaKind),
        role: subscriber ? 'remote' : 'local',
        trackReference: subscriber ? source!.track_id : trackId,
        transceiverMid: providerTrack.mid,
      }],
    })
    if (!subscriber) {
      const others = this.meetingParticipantConnectionIds(parsed.meetingId).filter((connectionId) => connectionId !== caller.connectionId)
      for (const connectionId of others) {
        this.sendCoordinatorEvent(connectionId, `meeting:${parsed.meetingId}`, 'media.source.available', {
          callId: parsed.meetingId,
          mediaKind: parsed.mediaKind,
          participantConnectionId: caller.connectionId,
          trackReference: trackId,
        })
      }
    }
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  async stopMeetingMedia(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = meetingMediaStopSchema.parse(input)
    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(parsed.release)) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.meetingById(parsed.meetingId)
    const meeting = row ? this.storedMeeting(row) : null
    if (!caller || !row || !meeting || !meeting.participants.has(caller.connectionId)) return { outcome: 'invalid_state', requestId: parsed.requestId }
    const rows = this.ctx.storage.sql.exec<CoordinatorMeetingMediaSessionRow>(
      `select meeting_id, connection_id, source_connection_id, media_kind,
              session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_meeting_media_sessions
       where meeting_id = ? and connection_id = ? and source_connection_id = ? and media_kind = ?`,
      parsed.meetingId,
      caller.connectionId,
      caller.connectionId,
      parsed.mediaKind,
    ).toArray()
    await this.closeMeetingMediaRows(rows, parsed.release, 'ended')
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  private pttTransmission(transmissionRequestId: string): CoordinatorPttTransmissionRow | null {
    return this.ctx.storage.sql.exec<CoordinatorPttTransmissionRow>(
      `select transmission_request_id, channel_reference, requester_employee_id,
              requester_connection_id, recipient_employee_ids_json, scope, state,
              lease_expires_at_ms, lease_generation, created_at_ms
       from coordinator_ptt_transmissions where transmission_request_id = ? limit 1`,
      transmissionRequestId,
    ).toArray()[0] ?? null
  }

  /**
   * Only the coordinator may extend a floor that is still preparing. The
   * extension is capped from the original reservation timestamp, so retries
   * cannot turn a transient provider delay into a permanently busy channel.
   */
  private extendPttPreparationLease(row: CoordinatorPttTransmissionRow, now: number): CoordinatorPttTransmissionRow | null {
    if (row.state !== 'preparing') return null
    const leaseExpiresAtMs = extendServerPttPreparationLease({
      createdAtMs: row.created_at_ms,
      currentLeaseExpiresAtMs: row.lease_expires_at_ms,
      maximumPreparationLifetimeMs: pttMaximumPreparationLifetimeMilliseconds,
      nowMs: now,
      setupExtensionMs: pttPreparingMilliseconds,
    })
    if (leaseExpiresAtMs === null) return null

    if (leaseExpiresAtMs > row.lease_expires_at_ms) {
      this.ctx.storage.sql.exec(
        `update coordinator_ptt_transmissions
         set lease_expires_at_ms = ?, updated_at_ms = ?
         where transmission_request_id = ? and state = 'preparing'
           and channel_reference = ? and requester_employee_id = ?
           and requester_connection_id = ? and created_at_ms = ?
           and lease_expires_at_ms > ?`,
        leaseExpiresAtMs,
        now,
        row.transmission_request_id,
        row.channel_reference,
        row.requester_employee_id,
        row.requester_connection_id,
        row.created_at_ms,
        now,
      )
    }

    const current = this.pttTransmission(row.transmission_request_id)
    if (
      !current
      || current.state !== 'preparing'
      || current.lease_expires_at_ms <= now
      || current.channel_reference !== row.channel_reference
      || current.requester_employee_id !== row.requester_employee_id
      || current.requester_connection_id !== row.requester_connection_id
      || current.created_at_ms !== row.created_at_ms
    ) return null
    // Once the publisher has created its source marker, keep that marker in
    // step with the bounded server reservation while listener setup makes
    // verified progress. Otherwise a valid slow listener can answer its own
    // fresh provider offer after the source marker's original short deadline.
    this.ctx.storage.sql.exec(
      `update coordinator_ptt_media_negotiations
       set expires_at_ms = ?
       where transmission_request_id = ? and expires_at_ms < ?`,
      current.lease_expires_at_ms,
      current.transmission_request_id,
      current.lease_expires_at_ms,
    )
    this.scheduleNextSocketTicketExpiry()
    return current
  }

  /** Revalidates the exact publisher connection after a provider await. A
   * route match alone is insufficient: a reconnect receives a new connection
   * ID and may not inherit a reserved floor or a prior provider track. */
  private pttPublisherReservationIsCurrent(input: Readonly<{
    authorization: StagedCommsAuthorizationContext
    channelReference: string
    connectionId: string
    connectionRouteReference: string
    now: number
    transmissionRequestId: string
  }>): CoordinatorPttTransmissionRow | null {
    const caller = this.activeSocketForRoute(input.connectionRouteReference, input.authorization)
    const row = this.pttTransmission(input.transmissionRequestId)
    if (
      !caller
      || caller.connectionId !== input.connectionId
      || !input.authorization.permissions.includes('sygsphere.comms.ptt.transmit')
      || !row
      || row.state !== 'preparing'
      || row.lease_expires_at_ms <= input.now
      || row.channel_reference !== input.channelReference
      || row.requester_employee_id !== caller.authorization.employeeId
      || row.requester_connection_id !== caller.connectionId
      || this.mediaSession(input.transmissionRequestId, caller.authorization.employeeId)
    ) return null
    // Each provider operation has its own bounded network wait. Refreshing
    // the server-owned preparation lease after the exact reservation has been
    // re-verified prevents a legal slow provider sequence from expiring in
    // the gap between two successful operations; the absolute cap remains
    // anchored to the original floor reservation.
    return this.extendPttPreparationLease(row, input.now)
  }

  /** Revalidates the exact selected listener and the live publisher source
   * after subscriber-provider I/O. This prevents a late response from being
   * persisted when a listener reconnects, is removed, or the source changes. */
  private pttListenerReservationIsCurrent(input: Readonly<{
    authorization: StagedCommsAuthorizationContext
    connectionId: string
    connectionRouteReference: string
    now: number
    sourceConnectionId: string
    sourceSessionId: string
    sourceTrackId: string
    transmissionRequestId: string
  }>): CoordinatorPttTransmissionRow | null {
    const caller = this.activeSocketForRoute(input.connectionRouteReference, input.authorization)
    const row = this.pttTransmission(input.transmissionRequestId)
    if (
      !caller
      || caller.connectionId !== input.connectionId
      || !input.authorization.permissions.includes('sygsphere.comms.ptt.listen')
      || !row
      || !['preparing', 'ready'].includes(row.state)
      || row.lease_expires_at_ms <= input.now
      || caller.authorization.employeeId === row.requester_employee_id
      || !this.pttRecipients(row).includes(caller.authorization.employeeId)
      || !this.pttRequiredListenerConnectionIds(input.transmissionRequestId).includes(caller.connectionId)
      || this.mediaSession(input.transmissionRequestId, caller.authorization.employeeId)
    ) return null

    const sourceSocket = this.activeSocketByConnectionId(row.requester_connection_id)
    const source = this.mediaSession(input.transmissionRequestId, row.requester_employee_id)
    const sourceSession = source ? this.parseProviderSession(source) : null
    if (
      !sourceSocket
      || sourceSocket.authorization.tenantId !== caller.authorization.tenantId
      || sourceSocket.authorization.employeeId !== row.requester_employee_id
      || !source
      || !sourceSession
      || source.connection_id !== row.requester_connection_id
      || source.connection_id !== input.sourceConnectionId
      || source.track_id !== input.sourceTrackId
      || sourceSession.id !== input.sourceSessionId
    ) return null
    return row.state === 'preparing'
      ? this.extendPttPreparationLease(row, input.now)
      : row
  }

  /** A successful provider request can return after its floor has ended. The
   * track was never persisted, so clean it up directly rather than invoking a
   * broader call teardown that could affect a newer transmission. */
  private async closeStalePttTrack(input: Readonly<{
    adapter: CloudflareRealtimeHttpAdapter
    mid: string
    session: ProviderSession
    trackId: string
  }>): Promise<void> {
    await input.adapter.forceCloseTracks({
      session: input.session,
      tenantId: input.session.tenantId,
      tracks: [{ mid: input.mid, trackId: input.trackId }],
    }).catch(() => undefined)
  }

  /** PTT sessions are write-once for a floor participant. A late concurrent
   * provider response must not overwrite a newer session for that connection. */
  private claimPttMediaSession(
    input: Readonly<{ callId: string, connectionId: string, employeeId: string, session: ProviderSession, trackId: string }>,
    now: number,
  ): boolean {
    this.ctx.storage.sql.exec(
      `insert into coordinator_call_media_sessions (
        call_id, employee_id, connection_id, session_json, track_id, created_at_ms, updated_at_ms
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (call_id, employee_id) do nothing`,
      input.callId,
      input.employeeId,
      input.connectionId,
      this.serializeProviderSession(input.session),
      input.trackId,
      now,
      now,
    )
    const stored = this.mediaSession(input.callId, input.employeeId)
    const storedSession = stored ? this.parseProviderSession(stored) : null
    return stored !== null
      && stored.connection_id === input.connectionId
      && stored.track_id === input.trackId
      && storedSession?.id === input.session.id
  }

  private pttRecipients(row: CoordinatorPttTransmissionRow): readonly string[] {
    try {
      const parsed = z.array(z.uuid()).min(1).max(50).safeParse(JSON.parse(row.recipient_employee_ids_json))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  private pttRequiredListenerConnectionIds(transmissionRequestId: string): readonly string[] {
    return this.ctx.storage.sql.exec<{ connection_id: string }>(
      `select connection_id from coordinator_ptt_listener_requirements
       where transmission_request_id = ? order by connection_id asc`,
      transmissionRequestId,
    ).toArray().map((row) => row.connection_id)
  }

  private pttReadyListenerConnectionIds(transmissionRequestId: string): readonly string[] {
    return this.ctx.storage.sql.exec<{ connection_id: string }>(
      `select connection_id from coordinator_ptt_listener_requirements
       where transmission_request_id = ? and ready_at_ms is not null order by connection_id asc`,
      transmissionRequestId,
    ).toArray().map((row) => row.connection_id)
  }

  /** One current, authorized Communications connection per channel member is
   * required before a PTT floor can be granted.  We deliberately do not wake
   * inactive accounts or trust client-provided recipients. */
  private activePttListeners(
    scope: Extract<NonNullable<AuthorizedCoordinatorCommand['scope']>, { kind: 'channel_conversation' }>,
    caller: AuthenticatedSocketAttachment,
  ): Readonly<{
    listeners: readonly AuthenticatedSocketAttachment[]
    unavailableReason: Extract<SygSphereCommsAvailabilityReason, 'no_listener_connected' | 'no_listener_eligible'> | null
  }> {
    const permittedEmployees = new Set(scope.participantEmployeeIds)
    const newestByEmployee = new Map<string, AuthenticatedSocketAttachment>()
    let hasConnectedListener = false
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (
        attachment?.phase !== 'authenticated'
        || attachment.authorization.tenantId !== caller.authorization.tenantId
        || attachment.authorization.employeeId === caller.authorization.employeeId
        || !permittedEmployees.has(attachment.authorization.employeeId)
      ) continue
      hasConnectedListener = true
      if (!attachment.authorization.permissions.includes('sygsphere.comms.ptt.listen')) continue
      const prior = newestByEmployee.get(attachment.authorization.employeeId)
      if (!prior || attachment.openedAtMs > prior.openedAtMs) newestByEmployee.set(attachment.authorization.employeeId, attachment)
    }
    const listeners = [...newestByEmployee.values()].sort((left, right) => left.connectionId.localeCompare(right.connectionId))
    return {
      listeners,
      unavailableReason: resolveSygSphereCommsPttAvailabilityReason(hasConnectedListener, listeners.length > 0),
    }
  }

  private sendPttConnectionEvent(
    connectionIds: readonly string[],
    transmissionRequestId: string,
    kind: Extract<SygSphereCommsEventKind, 'transmission.started' | 'transmission.ended'>,
    payload: Record<string, unknown>,
  ): void {
    for (const connectionId of new Set(connectionIds)) {
      this.sendCoordinatorEvent(connectionId, `ptt:${transmissionRequestId}`, kind, payload)
    }
  }

  private sendPttEvent(
    employeeIds: readonly string[],
    transmissionRequestId: string,
    kind: Extract<SygSphereCommsEventKind, 'floor.preparing' | 'floor.ready' | 'floor.renewed' | 'floor.denied' | 'floor.revoked' | 'transmission.started' | 'transmission.ended'>,
    payload: Record<string, unknown>,
  ): void {
    const roomId = `ptt:${transmissionRequestId}`
    const allowed = new Set(employeeIds)
    const delivered = new Set<string>()
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = socketAttachment(webSocket)
      if (attachment?.phase !== 'authenticated' || !allowed.has(attachment.authorization.employeeId)) continue
      if (delivered.has(attachment.connectionId)) continue
      delivered.add(attachment.connectionId)
      this.sendCoordinatorEvent(attachment.connectionId, roomId, kind, payload)
    }
  }

  private async closePttMedia(
    transmissionRequestId: string,
    release: CoordinatorReleaseContext,
    reason: PttCloseReason,
  ): Promise<void> {
    const rows = this.ctx.storage.sql.exec<CoordinatorCallMediaSessionRow>(
      `select call_id, employee_id, connection_id, session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_call_media_sessions where call_id = ?`,
      transmissionRequestId,
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
      this.sendCoordinatorEvent(row.connection_id, `ptt:${transmissionRequestId}`, 'media.closed', {
        callId: transmissionRequestId,
        generation: 1,
        reason,
      })
    }
    this.ctx.storage.sql.exec('delete from coordinator_media_negotiations where call_id = ?', transmissionRequestId)
    this.ctx.storage.sql.exec('delete from coordinator_call_media_sessions where call_id = ?', transmissionRequestId)
  }

  /** Remove one selected listener's server media before any provider cleanup
   * can await. A failed browser receiver must not remain an implicit required
   * listener and hold an otherwise-unused channel floor until its lease ends. */
  private async closePttListenerMedia(
    transmissionRequestId: string,
    connectionId: string,
    release: CoordinatorReleaseContext,
  ): Promise<void> {
    const rows = this.ctx.storage.sql.exec<CoordinatorCallMediaSessionRow>(
      `select call_id, employee_id, connection_id, session_json, track_id, created_at_ms, updated_at_ms
       from coordinator_call_media_sessions
       where call_id = ? and connection_id = ?`,
      transmissionRequestId,
      connectionId,
    ).toArray()
    // A late provider completion can no longer claim this listener after the
    // local participant has reported an unrecoverable setup failure.
    this.ctx.storage.sql.exec(
      'delete from coordinator_call_media_sessions where call_id = ? and connection_id = ?',
      transmissionRequestId,
      connectionId,
    )
    // A late browser answer must never complete a listener negotiation after
    // that listener has been removed from the current floor reservation.
    this.ctx.storage.sql.exec(
      'delete from coordinator_media_negotiations where call_id = ? and connection_id = ?',
      transmissionRequestId,
      connectionId,
    )
    const adapter = await this.providerAdapter(release, 'ptt_listener_failed')
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
      this.sendCoordinatorEvent(row.connection_id, `ptt:${transmissionRequestId}`, 'media.closed', {
        callId: transmissionRequestId,
        generation: 1,
        reason: 'unavailable',
      })
    }
  }

  private async closePttTransmission(
    row: CoordinatorPttTransmissionRow,
    release: CoordinatorReleaseContext,
    reason: PttCloseReason,
  ): Promise<boolean> {
    if (row.state === 'ended') return false
    const current = this.pttTransmission(row.transmission_request_id)
    if (!current || current.state === 'ended') return false
    const closedAtMs = Date.now()
    this.ctx.storage.sql.exec(
      `update coordinator_ptt_transmissions set state = 'ended', updated_at_ms = ?
       where transmission_request_id = ? and state = ?`,
      closedAtMs,
      current.transmission_request_id,
      current.state,
    )
    const closed = this.pttTransmission(current.transmission_request_id)
    if (!closed || closed.state !== 'ended') return false
    // Make the channel immediately eligible for the next floor request before
    // provider cleanup performs any network I/O.
    this.scheduleNextSocketTicketExpiry()
    await this.closePttMedia(current.transmission_request_id, release, reason)
    this.ctx.storage.sql.exec('delete from coordinator_ptt_listener_requirements where transmission_request_id = ?', current.transmission_request_id)
    this.ctx.storage.sql.exec('delete from coordinator_ptt_media_negotiations where transmission_request_id = ?', current.transmission_request_id)
    // The requester must receive the authoritative end event too. Without it,
    // their browser can remain visually stuck in the releasing state even though
    // the server has already closed the floor and media sessions.
    this.sendPttEvent([current.requester_employee_id, ...this.pttRecipients(current)], current.transmission_request_id, 'transmission.ended', {
      reason,
      transmissionRequestId: current.transmission_request_id,
    })
    return true
  }

  /** A provider setup failure must not leave a preparing row holding the
   * channel. A late secondary listener cannot tear down an already-ready
   * transmission, and a concurrent publisher that has already registered its
   * source remains authoritative. */
  private async closeFailedPttPreparation(
    row: CoordinatorPttTransmissionRow,
    release: CoordinatorReleaseContext,
    role: 'listener' | 'publisher',
  ): Promise<void> {
    const current = this.pttTransmission(row.transmission_request_id)
    if (
      !current
      || current.state !== 'preparing'
      || current.created_at_ms !== row.created_at_ms
      || current.requester_connection_id !== row.requester_connection_id
      || current.channel_reference !== row.channel_reference
      || (role === 'publisher' && this.mediaSession(current.transmission_request_id, current.requester_employee_id))
      || (role === 'listener' && this.pttReadyListenerConnectionIds(current.transmission_request_id).length > 0)
    ) return

    const reason: PttCloseReason = current.lease_expires_at_ms <= Date.now() ? 'expired' : 'unavailable'
    if (await this.closePttTransmission(current, release, reason)) {
      this.sendPttEvent([current.requester_employee_id], current.transmission_request_id, 'floor.revoked', {
        reason,
        transmissionRequestId: current.transmission_request_id,
      })
    }
  }

  private async dispatchFloorCommand(
    authorized: AuthorizedCoordinatorCommand,
    now: number,
  ): Promise<TenantCommsCoordinatorResult['outcome']> {
    const routeReference = authorized.connectionRouteReference
    if (!routeReference) return 'invalid_state'
    const caller = this.activeSocketForRoute(routeReference, authorized.authorization)
    if (!caller) return 'invalid_state'

    if (authorized.command.kind === 'floor.request') {
      if (!authorized.scope || authorized.scope.kind !== 'channel_conversation') return 'invalid_state'
      const scope = authorized.scope
      const commandPayload = authorized.command.payload as Record<string, unknown>
      const transmissionRequestId = typeof commandPayload.clientIntentId === 'string' ? commandPayload.clientIntentId : null
      if (!transmissionRequestId) return 'invalid_state'
      const listenerAvailability = this.activePttListeners(scope, caller)
      const listeners = listenerAvailability.listeners
      if (!listeners.length) {
        reportSygSphereCommsAvailability(
          'ptt_floor_request',
          listenerAvailability.unavailableReason ?? 'no_listener_connected',
        )
        this.sendPttEvent([caller.authorization.employeeId], transmissionRequestId, 'floor.denied', {
          reason: 'unavailable',
          transmissionRequestId,
        })
        return 'recipient_unavailable'
      }
      const active = this.ctx.storage.sql.exec<CoordinatorPttTransmissionRow>(
        `select transmission_request_id, channel_reference, requester_employee_id,
                requester_connection_id, recipient_employee_ids_json, scope, state,
                lease_expires_at_ms, lease_generation, created_at_ms
         from coordinator_ptt_transmissions
         where channel_reference = ? and state in ('preparing', 'ready') limit 1`,
        scope.channelReference,
      ).toArray()[0]
      if (active) {
        reportSygSphereCommsAvailability('ptt_floor_request', 'channel_busy')
        this.sendPttEvent([caller.authorization.employeeId], transmissionRequestId, 'floor.denied', {
          reason: 'channel_busy',
          transmissionRequestId,
        })
        return 'channel_busy'
      }
      try {
        this.ctx.storage.sql.exec(
          `insert into coordinator_ptt_transmissions (
            transmission_request_id, channel_reference, requester_employee_id,
            requester_connection_id, recipient_employee_ids_json, scope, state,
            lease_expires_at_ms, lease_generation, created_at_ms, updated_at_ms
          ) values (?, ?, ?, ?, ?, ?, 'preparing', ?, 0, ?, ?)`,
          transmissionRequestId,
          scope.channelReference,
          caller.authorization.employeeId,
          caller.connectionId,
          JSON.stringify(scope.participantEmployeeIds),
          scope.scope,
          now + pttPreparingMilliseconds,
          now,
          now,
        )
      } catch {
        reportSygSphereCommsAvailability('ptt_floor_request', 'channel_busy')
        this.sendPttEvent([caller.authorization.employeeId], transmissionRequestId, 'floor.denied', {
          reason: 'channel_busy',
          transmissionRequestId,
        })
        return 'channel_busy'
      }
      for (const listener of listeners) {
        this.ctx.storage.sql.exec(
          `insert into coordinator_ptt_listener_requirements (
            transmission_request_id, connection_id, employee_id, ready_at_ms
          ) values (?, ?, ?, null)`,
          transmissionRequestId,
          listener.connectionId,
          listener.authorization.employeeId,
        )
      }
      this.sendPttEvent([caller.authorization.employeeId], transmissionRequestId, 'floor.preparing', {
        scope: scope.scope,
        transmissionRequestId,
      })
      this.scheduleNextSocketTicketExpiry()
      return 'accepted'
    }

    const commandPayload = authorized.command.payload as Record<string, unknown>
    const transmissionRequestId = typeof commandPayload.transmissionRequestId === 'string' ? commandPayload.transmissionRequestId : null
    if (!transmissionRequestId) return 'invalid_state'
    const row = this.pttTransmission(transmissionRequestId)
    if (!row || row.requester_employee_id !== caller.authorization.employeeId || row.requester_connection_id !== caller.connectionId) {
      return 'invalid_state'
    }
    if (authorized.command.kind === 'floor.renew') {
      if (row.state !== 'ready' || row.lease_expires_at_ms <= now) return 'invalid_state'
      const leaseExpiresAtMs = now + pttLeaseMilliseconds
      const leaseGeneration = nextServerPttLeaseGeneration(row.lease_generation)
      if (leaseGeneration === null) return 'invalid_state'
      this.ctx.storage.sql.exec(
        `update coordinator_ptt_transmissions
         set lease_expires_at_ms = ?, lease_generation = ?, updated_at_ms = ?
         where transmission_request_id = ? and state = 'ready'
           and lease_expires_at_ms > ? and lease_generation = ?`,
        leaseExpiresAtMs,
        leaseGeneration,
        now,
        transmissionRequestId,
        now,
        row.lease_generation,
      )
      const renewed = this.pttTransmission(transmissionRequestId)
      if (
        !renewed
        || renewed.state !== 'ready'
        || renewed.lease_expires_at_ms !== leaseExpiresAtMs
        || renewed.lease_generation !== leaseGeneration
      ) return 'invalid_state'
      this.sendPttEvent([caller.authorization.employeeId], transmissionRequestId, 'floor.renewed', {
        commandId: authorized.command.commandId,
        generation: renewed.lease_generation,
        leaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
        transmissionRequestId,
      })
      this.scheduleNextSocketTicketExpiry()
      return 'accepted'
    }
    await this.closePttTransmission(row, authorized.release, authorized.command.kind === 'floor.cancel' ? 'cancelled' : 'ended')
    this.scheduleNextSocketTicketExpiry()
    return 'accepted'
  }

  async startPttAudio(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = pttAudioStartSchema.parse(input)
    if (!this.pttRuntimeMayPrepare(parsed.release, 'ptt_start_publisher')) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    await this.expirePttTransmissions(Date.now(), parsed.release)
    const requestedAtMs = Date.now()
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.pttTransmission(parsed.transmissionRequestId)
    if (!caller || !row || row.state !== 'preparing' || row.lease_expires_at_ms <= requestedAtMs
      || row.channel_reference !== parsed.channelReference
      || row.requester_employee_id !== caller.authorization.employeeId
      || row.requester_connection_id !== caller.connectionId
      || this.mediaSession(parsed.transmissionRequestId, caller.authorization.employeeId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }

    // Keep the floor reserved through the server-owned setup sequence, but
    // never past the reservation's fixed absolute preparation deadline.
    if (!this.extendPttPreparationLease(row, requestedAtMs)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const providerUnavailable = async (): Promise<TenantCommsCoordinatorResult> => {
      await this.closeFailedPttPreparation(row, parsed.release, 'publisher')
      return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    }
    const invalidAfterProviderWait = async (): Promise<TenantCommsCoordinatorResult> => {
      await this.expirePttTransmissions(Date.now(), parsed.release)
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const adapter = await this.providerAdapter(parsed.release, 'ptt_start_publisher')
    if (!adapter) return providerUnavailable()
    const publisherInput = {
      authorization: parsed.authorization,
      channelReference: parsed.channelReference,
      connectionId: caller.connectionId,
      connectionRouteReference: parsed.connectionRouteReference,
      transmissionRequestId: parsed.transmissionRequestId,
    }
    if (!this.pttPublisherReservationIsCurrent({ ...publisherInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const ice = await adapter.generateIceServers(300)
    if (ice.outcome !== 'accepted') return providerUnavailable()
    if (!this.pttPublisherReservationIsCurrent({ ...publisherInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const created = await adapter.createSession({ tenantId: caller.authorization.tenantId })
    if (created.outcome !== 'accepted') return providerUnavailable()
    if (!this.pttPublisherReservationIsCurrent({ ...publisherInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const pending = activateProviderSession(createProviderSession(created.value.sessionId, caller.authorization.tenantId))
    const trackId = `ptt-${parsed.transmissionRequestId}-audio-${caller.authorization.employeeId}`
    const publication = await adapter.publishTracks({
      session: pending,
      sessionDescription: { sdp: parsed.offer, type: 'offer' },
      tenantId: caller.authorization.tenantId,
      tracks: [{ kind: 'audio', location: 'local', trackName: trackId }],
    })
    const localTrack = publication.outcome === 'accepted' ? publication.value.tracks[0] : null
    if (publication.outcome !== 'accepted' || !localTrack?.mid || !publication.value.sessionDescription) {
      return providerUnavailable()
    }
    const session = registerProviderTrack(pending, { id: trackId, kind: 'audio', mid: localTrack.mid, state: 'active' })
    const now = Date.now()
    const current = this.pttPublisherReservationIsCurrent({ ...publisherInput, now })
    if (!current) {
      await this.closeStalePttTrack({ adapter, mid: localTrack.mid, session, trackId })
      return invalidAfterProviderWait()
    }
    if (!this.claimPttMediaSession({
      callId: parsed.transmissionRequestId,
      connectionId: caller.connectionId,
      employeeId: caller.authorization.employeeId,
      session,
      trackId,
    }, now)) {
      await this.closeStalePttTrack({ adapter, mid: localTrack.mid, session, trackId })
      return invalidAfterProviderWait()
    }
    const negotiationId = crypto.randomUUID()
    const negotiationExpiresAtMs = Math.min(current.lease_expires_at_ms, now + pttPreparingMilliseconds)
    this.ctx.storage.sql.exec(
      `insert into coordinator_ptt_media_negotiations (
        transmission_request_id, negotiation_id, source_ready_at_ms, expires_at_ms
      ) values (?, ?, ?, ?)
       on conflict (transmission_request_id) do nothing`,
      parsed.transmissionRequestId,
      negotiationId,
      now,
      negotiationExpiresAtMs,
    )
    this.sendCoordinatorEvent(caller.connectionId, `ptt:${parsed.transmissionRequestId}`, 'media.negotiation', {
      callId: parsed.transmissionRequestId,
      description: publication.value.sessionDescription.sdp,
      descriptionType: publication.value.sessionDescription.type,
      direction: 'publish',
      expiresAt: new Date(negotiationExpiresAtMs).toISOString(),
      generation: 1,
      iceServers: ice.value.iceServers,
      negotiationId,
      peerHandle: `peer:${session.id}`,
      trackBindings: [{
        mediaKind: 'audio',
        publicationKind: 'ptt',
        role: 'local',
        trackReference: trackId,
        transceiverMid: localTrack.mid,
      }],
    })
    const active = this.pttTransmission(parsed.transmissionRequestId)
    if (active) {
      this.sendPttConnectionEvent(this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId), parsed.transmissionRequestId, 'transmission.started', {
        scope: active.scope,
        transmissionRequestId: parsed.transmissionRequestId,
      })
    }
    this.scheduleNextSocketTicketExpiry()
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  async preparePttAudio(input: unknown): Promise<TenantCommsDirectAudioPreparation> {
    await this.initialization
    const parsed = pttAudioPreparationSchema.parse(input)
    if (!this.pttRuntimeMayPrepare(parsed.release, 'ptt_prepare_publisher')) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    await this.expirePttTransmissions(Date.now(), parsed.release)
    const requestedAtMs = Date.now()
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.pttTransmission(parsed.transmissionRequestId)
    if (!caller || !row || row.state !== 'preparing' || row.lease_expires_at_ms <= requestedAtMs
      || row.channel_reference !== parsed.channelReference
      || row.requester_employee_id !== caller.authorization.employeeId
      || row.requester_connection_id !== caller.connectionId) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    if (!this.extendPttPreparationLease(row, requestedAtMs)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const providerUnavailable = async (): Promise<TenantCommsDirectAudioPreparation> => {
      await this.closeFailedPttPreparation(row, parsed.release, 'publisher')
      return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    }
    const adapter = await this.providerAdapter(parsed.release, 'ptt_prepare_publisher')
    if (!adapter) return providerUnavailable()
    const ice = await adapter.generateIceServers(300)
    if (ice.outcome !== 'accepted') return providerUnavailable()
    const current = this.pttPublisherReservationIsCurrent({
      authorization: parsed.authorization,
      channelReference: parsed.channelReference,
      connectionId: caller.connectionId,
      connectionRouteReference: parsed.connectionRouteReference,
      now: Date.now(),
      transmissionRequestId: parsed.transmissionRequestId,
    })
    if (current) return { iceServers: ice.value.iceServers, outcome: 'accepted', requestId: parsed.requestId }
    await this.expirePttTransmissions(Date.now(), parsed.release)
    return { outcome: 'invalid_state', requestId: parsed.requestId }
  }

  async startPttListen(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = pttListenStartSchema.parse(input)
    if (!this.pttRuntimeMayPrepare(parsed.release, 'ptt_start_listener')) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    await this.expirePttTransmissions(Date.now(), parsed.release)
    const requestedAtMs = Date.now()
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.pttTransmission(parsed.transmissionRequestId)
    if (!caller || !row || !['preparing', 'ready'].includes(row.state) || row.lease_expires_at_ms <= requestedAtMs
      || !this.pttRecipients(row).includes(caller.authorization.employeeId)
      || caller.authorization.employeeId === row.requester_employee_id
      || !this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId).includes(caller.connectionId)
      || this.mediaSession(parsed.transmissionRequestId, caller.authorization.employeeId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }

    // Do not lengthen an already-ready transmit lease. Only the detached setup
    // phase receives the bounded server-owned extension.
    const setupRow = row.state === 'preparing'
      ? this.extendPttPreparationLease(row, requestedAtMs)
      : row
    if (!setupRow) return { outcome: 'invalid_state', requestId: parsed.requestId }

    const providerUnavailable = async (): Promise<TenantCommsCoordinatorResult> => {
      await this.closeFailedPttPreparation(row, parsed.release, 'listener')
      return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    }
    const invalidAfterProviderWait = async (): Promise<TenantCommsCoordinatorResult> => {
      await this.expirePttTransmissions(Date.now(), parsed.release)
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }

    const source = this.mediaSession(parsed.transmissionRequestId, setupRow.requester_employee_id)
    const sourceSession = source ? this.parseProviderSession(source) : null
    if (!source || !sourceSession) return providerUnavailable()
    const listenerInput = {
      authorization: parsed.authorization,
      connectionId: caller.connectionId,
      connectionRouteReference: parsed.connectionRouteReference,
      sourceConnectionId: source.connection_id,
      sourceSessionId: sourceSession.id,
      sourceTrackId: source.track_id,
      transmissionRequestId: parsed.transmissionRequestId,
    }
    const adapter = await this.providerAdapter(parsed.release, 'ptt_start_listener')
    if (!adapter) return providerUnavailable()
    if (!this.pttListenerReservationIsCurrent({ ...listenerInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const ice = await adapter.generateIceServers(300)
    if (ice.outcome !== 'accepted') return providerUnavailable()
    if (!this.pttListenerReservationIsCurrent({ ...listenerInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const created = await adapter.createSession({ tenantId: caller.authorization.tenantId })
    if (created.outcome !== 'accepted') return providerUnavailable()
    if (!this.pttListenerReservationIsCurrent({ ...listenerInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const pending = activateProviderSession(createProviderSession(created.value.sessionId, caller.authorization.tenantId))
    const subscription = await adapter.subscribeTracks({
      session: pending,
      tenantId: caller.authorization.tenantId,
      tracks: [{ location: 'remote', sessionId: sourceSession.id, trackName: source.track_id }],
    })
    const remoteTrack = subscription.outcome === 'accepted' ? subscription.value.tracks[0] : null
    // Cloudflare remote-track subscription is server-offer driven. The
    // browser answers this provider-issued offer through the protected generic
    // media.answer command below; accepting any other response would strand
    // the listener in a negotiation the provider cannot complete.
    if (
      subscription.outcome !== 'accepted'
      || subscription.value.requiresImmediateRenegotiation !== true
      || !remoteTrack?.mid
      || subscription.value.sessionDescription?.type !== 'offer'
    ) {
      return providerUnavailable()
    }
    const session = registerProviderTrack(pending, { id: source.track_id, kind: 'audio', mid: remoteTrack.mid, state: 'active' })
    const now = Date.now()
    const current = this.pttListenerReservationIsCurrent({ ...listenerInput, now })
    if (!current) {
      await this.closeStalePttTrack({ adapter, mid: remoteTrack.mid, session, trackId: source.track_id })
      return invalidAfterProviderWait()
    }
    if (!this.claimPttMediaSession({
      callId: parsed.transmissionRequestId,
      connectionId: caller.connectionId,
      employeeId: caller.authorization.employeeId,
      session,
      trackId: source.track_id,
    }, now)) {
      await this.closeStalePttTrack({ adapter, mid: remoteTrack.mid, session, trackId: source.track_id })
      return invalidAfterProviderWait()
    }
    const peerHandle = `peer:${session.id}`
    const negotiation = this.registerMediaNegotiation({
      callId: parsed.transmissionRequestId,
      connectionId: caller.connectionId,
      employeeId: caller.authorization.employeeId,
      expiresAtMs: Math.min(current.lease_expires_at_ms, now + pttPreparingMilliseconds),
      generation: 1,
      peerHandle,
      sessionId: session.id,
    }, now)
    this.sendCoordinatorEvent(caller.connectionId, `ptt:${parsed.transmissionRequestId}`, 'media.negotiation', {
      callId: parsed.transmissionRequestId,
      description: subscription.value.sessionDescription.sdp,
      descriptionType: subscription.value.sessionDescription.type,
      direction: 'subscribe',
      expiresAt: negotiation.expiresAt,
      generation: 1,
      iceServers: ice.value.iceServers,
      negotiationId: negotiation.negotiationId,
      peerHandle,
      trackBindings: [{
        mediaKind: 'audio',
        participantConnectionId: source.connection_id,
        publicationKind: 'ptt',
        role: 'remote',
        trackReference: source.track_id,
        transceiverMid: remoteTrack.mid,
      }],
    })
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  async preparePttListen(input: unknown): Promise<TenantCommsDirectAudioPreparation> {
    await this.initialization
    const parsed = pttListenPreparationSchema.parse(input)
    if (!this.pttRuntimeMayPrepare(parsed.release, 'ptt_prepare_listener')) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    // Direct preparation calls are not routed through dispatch(), so they
    // must also synchronously reap an expired floor before validating it.
    await this.expirePttTransmissions(Date.now(), parsed.release)
    const requestedAtMs = Date.now()
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.pttTransmission(parsed.transmissionRequestId)
    if (!caller || !row || !['preparing', 'ready'].includes(row.state) || row.lease_expires_at_ms <= requestedAtMs
      || !this.pttRecipients(row).includes(caller.authorization.employeeId)
      || caller.authorization.employeeId === row.requester_employee_id
      || !this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId).includes(caller.connectionId)) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const setupRow = row.state === 'preparing'
      ? this.extendPttPreparationLease(row, requestedAtMs)
      : row
    if (!setupRow) return { outcome: 'invalid_state', requestId: parsed.requestId }
    const providerUnavailable = async (): Promise<TenantCommsDirectAudioPreparation> => {
      await this.closeFailedPttPreparation(row, parsed.release, 'listener')
      return { outcome: 'provider_unavailable', requestId: parsed.requestId }
    }
    const invalidAfterProviderWait = async (): Promise<TenantCommsDirectAudioPreparation> => {
      await this.expirePttTransmissions(Date.now(), parsed.release)
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const source = this.mediaSession(parsed.transmissionRequestId, setupRow.requester_employee_id)
    const sourceSession = source ? this.parseProviderSession(source) : null
    if (!source || !sourceSession) return providerUnavailable()
    const listenerInput = {
      authorization: parsed.authorization,
      connectionId: caller.connectionId,
      connectionRouteReference: parsed.connectionRouteReference,
      sourceConnectionId: source.connection_id,
      sourceSessionId: sourceSession.id,
      sourceTrackId: source.track_id,
      transmissionRequestId: parsed.transmissionRequestId,
    }
    const adapter = await this.providerAdapter(parsed.release, 'ptt_prepare_listener')
    if (!adapter) return providerUnavailable()
    if (!this.pttListenerReservationIsCurrent({ ...listenerInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    const ice = await adapter.generateIceServers(300)
    if (ice.outcome !== 'accepted') return providerUnavailable()
    if (!this.pttListenerReservationIsCurrent({ ...listenerInput, now: Date.now() })) {
      return invalidAfterProviderWait()
    }
    return { iceServers: ice.value.iceServers, outcome: 'accepted', requestId: parsed.requestId }
  }

  /** A listener acknowledgement is accepted only from the exact current
   * channel connection selected at floor reservation.  The grant happens
   * once, after the first selected listener has completed its own subscriber
   * SDP negotiation. Other selected listeners can finish joining while the
   * renewable floor is active. */
  async acknowledgePttListenerReady(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = pttListenerReadySchema.parse(input)
    if (!this.pttRuntimeMayPrepare(parsed.release, 'ptt_listener_ready')) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    await this.expirePttTransmissions(Date.now(), parsed.release)
    const now = Date.now()
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.pttTransmission(parsed.transmissionRequestId)
    const listenerMedia = caller
      ? this.mediaSession(parsed.transmissionRequestId, caller.authorization.employeeId)
      : null
    const listenerSession = listenerMedia ? this.parseProviderSession(listenerMedia) : null
    if (!caller || !row || !['preparing', 'ready'].includes(row.state) || row.lease_expires_at_ms <= now
      || !this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId).includes(caller.connectionId)
      || !listenerMedia || !listenerSession || listenerMedia.connection_id !== caller.connectionId) {
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    const negotiation = this.ctx.storage.sql.exec<{ expires_at_ms: number, negotiation_id: string }>(
      `select negotiation_id, expires_at_ms from coordinator_ptt_media_negotiations
       where transmission_request_id = ? limit 1`,
      parsed.transmissionRequestId,
    ).toArray()[0]
    if (!negotiation || negotiation.expires_at_ms <= now) {
      await this.closeFailedPttPreparation(row, parsed.release, 'listener')
      return { outcome: 'invalid_state', requestId: parsed.requestId }
    }
    // The source/publisher marker above proves the transmission began. This
    // separate row proves this exact listener has returned an answer that the
    // provider accepted for its own session before it can unlock the floor.
    const listenerNegotiation = this.ctx.storage.sql.exec<CoordinatorMediaNegotiationRow>(
      `select negotiation_id, call_id, employee_id, connection_id, session_id,
              peer_handle, generation, expires_at_ms, completed_at_ms
       from coordinator_media_negotiations
       where call_id = ? and employee_id = ? and connection_id = ? and session_id = ?
         and completed_at_ms is not null and expires_at_ms > ?
       limit 1`,
      parsed.transmissionRequestId,
      caller.authorization.employeeId,
      caller.connectionId,
      listenerSession.id,
      now,
    ).toArray()[0]
    if (!listenerNegotiation) return { outcome: 'invalid_state', requestId: parsed.requestId }
    this.ctx.storage.sql.exec(
      `update coordinator_ptt_listener_requirements set ready_at_ms = ?
       where transmission_request_id = ? and connection_id = ? and ready_at_ms is null`,
      now,
      parsed.transmissionRequestId,
      caller.connectionId,
    )
    if (row.state === 'ready') return { outcome: 'accepted', requestId: parsed.requestId }
    const requiredListeners = this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId)
    let lifecycle = prepareServerPttFloor({
      callId: parsed.transmissionRequestId,
      generation: 1,
      requiredListenerConnectionIds: requiredListeners,
      scope: row.scope,
      transmissionRequestId: parsed.transmissionRequestId,
    }).state
    lifecycle = recordServerPttMediaNegotiation(lifecycle, { generation: 1, negotiationId: negotiation.negotiation_id })
    for (const listenerConnectionId of this.pttReadyListenerConnectionIds(parsed.transmissionRequestId)) {
      lifecycle = recordServerPttListenerReady(lifecycle, {
        generation: 1,
        listenerConnectionId,
        negotiationId: negotiation.negotiation_id,
      })
    }
    const grant = grantServerPttFloor(lifecycle, { leaseDurationMs: pttLeaseMilliseconds, nowMs: now })
    if (!grant) return { outcome: 'accepted', requestId: parsed.requestId }
    const active = startServerPttTransmission(grant.state, now)
    if (active.stage !== 'transmitting' || active.leaseExpiresAtMs === null) return { outcome: 'invalid_state', requestId: parsed.requestId }
    this.ctx.storage.sql.exec(
      `update coordinator_ptt_transmissions set state = 'ready', lease_expires_at_ms = ?, updated_at_ms = ?
       where transmission_request_id = ? and state = 'preparing'`,
      active.leaseExpiresAtMs,
      now,
      parsed.transmissionRequestId,
    )
    this.sendPttEvent([row.requester_employee_id], parsed.transmissionRequestId, 'floor.ready', grant.event.payload)
    this.scheduleNextSocketTicketExpiry()
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  /** A browser may fail before it can apply a subscriber answer or before its
   * connection-state deadline. Only the exact currently-selected listener can
   * report that condition, and only while the floor is still preparing. The
   * browser supplies no cancellation reason or participant authority. */
  async reportPttListenerFailure(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const parsed = pttListenerFailedSchema.parse(input)
    if (!this.pttRuntimeMayPrepare(parsed.release, 'ptt_listener_failed')) {
      return { outcome: 'runtime_disabled', requestId: parsed.requestId }
    }
    await this.expirePttTransmissions(Date.now(), parsed.release)
    const now = Date.now()
    const caller = this.activeSocketForRoute(parsed.connectionRouteReference, parsed.authorization)
    const row = this.pttTransmission(parsed.transmissionRequestId)
    if (
      !caller
      || !row
      || row.state !== 'preparing'
      || row.lease_expires_at_ms <= now
      || caller.authorization.employeeId === row.requester_employee_id
      || !this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId).includes(caller.connectionId)
      || this.pttReadyListenerConnectionIds(parsed.transmissionRequestId).includes(caller.connectionId)
    ) return { outcome: 'invalid_state', requestId: parsed.requestId }

    this.ctx.storage.sql.exec(
      `delete from coordinator_ptt_listener_requirements
       where transmission_request_id = ? and connection_id = ? and ready_at_ms is null`,
      parsed.transmissionRequestId,
      caller.connectionId,
    )
    const current = this.pttTransmission(parsed.transmissionRequestId)
    if (!current || current.state !== 'preparing') return { outcome: 'invalid_state', requestId: parsed.requestId }

    if (this.pttRequiredListenerConnectionIds(parsed.transmissionRequestId).length === 0) {
      if (await this.closePttTransmission(current, parsed.release, 'unavailable')) {
        this.sendPttEvent([current.requester_employee_id], current.transmission_request_id, 'floor.revoked', {
          reason: 'unavailable',
          transmissionRequestId: current.transmission_request_id,
        })
      }
      return { outcome: 'accepted', requestId: parsed.requestId }
    }

    await this.closePttListenerMedia(parsed.transmissionRequestId, caller.connectionId, parsed.release)
    this.scheduleNextSocketTicketExpiry()
    return { outcome: 'accepted', requestId: parsed.requestId }
  }

  private async expirePttTransmissions(
    now: number,
    release: CoordinatorReleaseContext = {
      databaseFoundationApplied: true,
      commandSchemasVerified: true,
      providerPhysicalDeviceEvidenceComplete: true,
      coordinatorDeploymentApproved: true,
      sharedCompatibilityVerified: true,
      runtimeEnabled: runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED),
    },
  ): Promise<void> {
    const rows = this.ctx.storage.sql.exec<CoordinatorPttTransmissionRow>(
      `select transmission_request_id, channel_reference, requester_employee_id,
              requester_connection_id, recipient_employee_ids_json, scope, state,
              lease_expires_at_ms, lease_generation, created_at_ms
       from coordinator_ptt_transmissions
       where state in ('preparing', 'ready') and lease_expires_at_ms <= ?
       order by lease_expires_at_ms asc limit ?`,
      now,
      maximumRecordsPurgedPerDispatch,
    ).toArray()
    for (const row of rows) {
      // Alarms are best-effort scheduling. Re-read the row before closing so a
      // valid renewal that arrived near the alarm boundary is never revoked.
      const current = this.pttTransmission(row.transmission_request_id)
      if (!current || current.state === 'ended' || current.lease_expires_at_ms > now) continue
      if (await this.closePttTransmission(current, release, 'expired')) {
        this.sendPttEvent([current.requester_employee_id], current.transmission_request_id, 'floor.revoked', {
          reason: 'expired',
          transmissionRequestId: current.transmission_request_id,
        })
      }
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
    // Alarm delivery is not a correctness boundary. Reap an expired floor on
    // every protected command before a new request can be denied as busy.
    await this.expirePttTransmissions(now, authorized.release)
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
      : ['floor.request', 'floor.cancel', 'floor.renew', 'floor.release'].includes(authorized.command.kind)
        ? await this.dispatchFloorCommand(authorized, now)
        : ['meeting.create', 'meeting.join', 'meeting.leave', 'meeting.end', 'participant.remove', 'participant.mute', 'camera.request', 'camera.release', 'screen.request', 'screen.release', 'focus.request', 'focus.release'].includes(authorized.command.kind)
          ? await this.dispatchMeetingCommand(authorized, now)
        : authorized.command.kind === 'media.answer'
          ? await this.dispatchMediaAnswer(authorized, now)
        : closedProviderOutcome(closedSygSphereCommsProviderRegistry)
    const result: TenantCommsCoordinatorResult = { outcome, requestId: authorized.requestId }
    return this.recordResult(commandId, result, now)
  }
}

/**
 * SygShift-owned shared communications contract.
 * This artifact contains transport-safe shapes only. Canonical authorization
 * derives actor, tenant, room membership, permissions, and provider handles
 * from the authenticated server-side binding.
 */
import { z } from 'zod'

export const SYGSPHERE_COMMS_CONTRACT_VERSION = '1.0.0-draft.6' as const
export const SYGSPHERE_COMMS_PROTOCOL_VERSION = 1 as const

export const SYGSPHERE_COMMS_PERMISSIONS = [
  'sygsphere.comms.use',
  'sygsphere.comms.ptt.listen',
  'sygsphere.comms.ptt.transmit',
  'sygsphere.comms.ptt.priority',
  'sygsphere.comms.ptt.monitor',
  'sygsphere.comms.call.start',
  'sygsphere.comms.call.receive',
  'sygsphere.comms.meeting.create',
  'sygsphere.comms.video.publish',
  'sygsphere.comms.screen.publish',
  'sygsphere.comms.moderate',
  'sygsphere.comms.history.read',
  'sygsphere.comms.usage.read',
  'sygsphere.comms.configure',
] as const

export type SygSphereCommsPermission = (typeof SYGSPHERE_COMMS_PERMISSIONS)[number]

export const SYGSPHERE_COMMS_COMMAND_KINDS = [
  'auth',
  'heartbeat',
  'resume',
  'snapshot.request',
  'floor.request',
  'floor.cancel',
  'floor.renew',
  'floor.release',
  'call.request',
  'call.accept',
  'call.decline',
  'call.cancel',
  'call.end',
  'meeting.create',
  'meeting.join',
  'meeting.leave',
  'meeting.end',
  'participant.remove',
  'participant.mute',
  'media.answer',
  'media.ready',
  'media.layout',
  'media.stop',
  'camera.request',
  'camera.release',
  'screen.request',
  'screen.release',
  'focus.request',
  'focus.release',
] as const

export type SygSphereCommsCommandKind = (typeof SYGSPHERE_COMMS_COMMAND_KINDS)[number]

export const SYGSPHERE_COMMS_EVENT_KINDS = [
  'authenticated',
  'authorization.expiring',
  'session.revoked',
  'snapshot',
  'floor.preparing',
  'floor.ready',
  'floor.renewed',
  'floor.denied',
  'floor.revoked',
  'transmission.started',
  'transmission.ended',
  'call.ringing',
  'call.requested',
  'call.accepted',
  'call.ended',
  'call.missed',
  'meeting.created',
  'meeting.joined',
  'meeting.ended',
  'participant.changed',
  'participant.removed',
  'participant.muted',
  'media.source.available',
  'media.source.unavailable',
  'media.negotiation',
  'media.policy',
  'media.failed',
  'media.closed',
  'camera.granted',
  'camera.denied',
  'camera.revoked',
  'screen.granted',
  'screen.denied',
  'screen.revoked',
  'focus.granted',
  'focus.denied',
  'focus.revoked',
] as const

export type SygSphereCommsEventKind = (typeof SYGSPHERE_COMMS_EVENT_KINDS)[number]

export type SygSphereCommsCommand<TPayload = unknown> = Readonly<{
  protocolVersion: typeof SYGSPHERE_COMMS_PROTOCOL_VERSION
  commandId: string
  roomId?: string
  expectedRoomVersion?: number
  connectionEpoch: number
  kind: SygSphereCommsCommandKind
  payload: TPayload
}>

export type SygSphereCommsEvent<TPayload = unknown> = Readonly<{
  protocolVersion: typeof SYGSPHERE_COMMS_PROTOCOL_VERSION
  eventId: string
  roomId: string
  roomEpoch: number
  roomSeq: number
  serverTime: string
  kind: SygSphereCommsEventKind
  payload: TPayload
}>

export const isSupportedSygSphereCommsProtocol = (protocolVersion: number): protocolVersion is typeof SYGSPHERE_COMMS_PROTOCOL_VERSION =>
  protocolVersion === SYGSPHERE_COMMS_PROTOCOL_VERSION

const emptyCommandPayloadSchema = z.object({}).strict()
const uuidSchema = z.uuid()
const roomSequenceSchema = z.number().int().min(0)
const roomReferenceSchema = z.string().min(1).max(128)
const opaqueServerReferenceSchema = z.string().min(1).max(128)
const opaqueTrackReferenceSchema = z.string().min(1).max(128)
const serverTransceiverMidSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

/**
 * Every client command has a bounded, command-specific payload. These values
 * are requests or references only: the coordinator resolves their tenant,
 * actor, scope membership, permission, state, and provider consequences.
 */
export const SYGSPHERE_COMMS_COMMAND_PAYLOAD_SCHEMAS = {
  auth: emptyCommandPayloadSchema,
  heartbeat: emptyCommandPayloadSchema,
  resume: z.object({ lastSeenRoomSeq: roomSequenceSchema.optional() }).strict(),
  'snapshot.request': z.object({ sinceRoomSeq: roomSequenceSchema.optional() }).strict(),
  'floor.request': z.object({
    channelReference: roomReferenceSchema,
    clientIntentId: uuidSchema,
  }).strict(),
  'floor.cancel': z.object({ transmissionRequestId: uuidSchema }).strict(),
  'floor.renew': z.object({ transmissionRequestId: uuidSchema }).strict(),
  'floor.release': z.object({ transmissionRequestId: uuidSchema }).strict(),
  'call.request': z.object({
    clientIntentId: uuidSchema,
    conversationReference: roomReferenceSchema,
  }).strict(),
  'call.accept': z.object({ invitationId: uuidSchema }).strict(),
  'call.decline': z.object({ invitationId: uuidSchema }).strict(),
  'call.cancel': z.object({ callId: uuidSchema }).strict(),
  'call.end': z.object({ callId: uuidSchema }).strict(),
  'meeting.create': z.object({
    clientIntentId: uuidSchema,
    conversationReference: roomReferenceSchema,
  }).strict(),
  'meeting.join': z.object({ meetingId: uuidSchema }).strict(),
  'meeting.leave': z.object({ meetingId: uuidSchema }).strict(),
  'meeting.end': z.object({ meetingId: uuidSchema }).strict(),
  'participant.remove': z.object({
    meetingId: uuidSchema,
    participantConnectionId: uuidSchema,
  }).strict(),
  'participant.mute': z.object({
    meetingId: uuidSchema,
    participantConnectionId: uuidSchema,
  }).strict(),
  'media.answer': z.object({
    negotiationId: uuidSchema,
    peerHandle: opaqueServerReferenceSchema,
    generation: roomSequenceSchema,
    answer: z.string().min(1).max(65_536),
  }).strict(),
  'media.ready': z.object({
    callId: uuidSchema,
    negotiationId: uuidSchema,
    peerHandle: opaqueServerReferenceSchema,
    generation: roomSequenceSchema,
    inputKind: z.enum(['audio', 'video']),
  }).strict(),
  'media.layout': z.object({
    callId: uuidSchema,
    layout: z.enum(['speaker', 'grid']),
  }).strict(),
  'media.stop': z.object({
    callId: uuidSchema,
    generation: roomSequenceSchema,
    trackReference: opaqueTrackReferenceSchema,
    trackKind: z.enum(['audio', 'video', 'screen']),
  }).strict(),
  'camera.request': z.object({ callId: uuidSchema }).strict(),
  'camera.release': z.object({ callId: uuidSchema }).strict(),
  'screen.request': z.object({ callId: uuidSchema }).strict(),
  'screen.release': z.object({ callId: uuidSchema }).strict(),
  'focus.request': z.object({ callId: uuidSchema }).strict(),
  'focus.release': z.object({ callId: uuidSchema }).strict(),
} as const satisfies Record<SygSphereCommsCommandKind, z.ZodType>

const timestampSchema = z.iso.datetime()
const boundedSessionDescriptionSchema = z.string().min(1).max(65_536)
const iceUrlSchema = z.string().min(1).max(256).regex(/^(stun|turn|turns):/i)
const iceServerSchema = z.object({
  credential: z.string().min(1).max(512).optional(),
  urls: z.union([iceUrlSchema, z.array(iceUrlSchema).min(1).max(8)]),
  username: z.string().min(1).max(256).optional(),
}).strict()
const eventReasonSchema = z.enum(['ended', 'cancelled', 'declined', 'expired', 'authorization_changed', 'network_lost', 'moderated', 'unavailable'])
const mediaKindSchema = z.enum(['audio', 'video', 'screen'])
const callReferenceSchema = z.uuid()
const meetingReferenceSchema = z.uuid()
const participantConnectionReferenceSchema = z.uuid()
const mediaGenerationSchema = z.number().int().min(0)

/**
 * Every event has a strict, documented payload. In particular, negotiation
 * description and TURN credentials can only travel from an authenticated
 * server to the browser; a browser never sends provider/session/track
 * authority back. Browser-facing errors use employee-safe outcomes only.
 */
export const SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS = {
  authenticated: z.object({ connectionEpoch: roomSequenceSchema }).strict(),
  'authorization.expiring': z.object({ expiresAt: timestampSchema }).strict(),
  'session.revoked': z.object({ reason: z.enum(['authorization_changed', 'signed_out', 'security_action']) }).strict(),
  snapshot: z.object({
    lastRoomSeq: roomSequenceSchema.optional(),
    roomVersion: roomSequenceSchema.optional(),
    status: z.enum(['available', 'unavailable']),
  }).strict(),
  'floor.preparing': z.object({ scope: z.enum(['assignment', 'shift', 'site', 'dispatch']), transmissionRequestId: z.uuid() }).strict(),
  'floor.ready': z.object({ expiresAt: timestampSchema, scope: z.enum(['assignment', 'shift', 'site', 'dispatch']), transmissionRequestId: z.uuid() }).strict(),
  'floor.renewed': z.object({
    commandId: z.uuid(),
    generation: mediaGenerationSchema,
    leaseExpiresAt: timestampSchema,
    transmissionRequestId: z.uuid(),
  }).strict(),
  'floor.denied': z.object({ reason: z.enum(['not_allowed', 'channel_busy', 'unavailable']), transmissionRequestId: z.uuid() }).strict(),
  'floor.revoked': z.object({ reason: eventReasonSchema, transmissionRequestId: z.uuid() }).strict(),
  'transmission.started': z.object({ scope: z.enum(['assignment', 'shift', 'site', 'dispatch']), transmissionRequestId: z.uuid() }).strict(),
  'transmission.ended': z.object({ reason: eventReasonSchema, transmissionRequestId: z.uuid() }).strict(),
  'call.ringing': z.object({ callId: callReferenceSchema, expiresAt: timestampSchema, invitationId: z.uuid() }).strict(),
  'call.requested': z.object({ callId: callReferenceSchema, expiresAt: timestampSchema, invitationId: z.uuid() }).strict(),
  'call.accepted': z.object({ callId: callReferenceSchema, invitationId: z.uuid() }).strict(),
  'call.ended': z.object({ callId: callReferenceSchema, reason: eventReasonSchema }).strict(),
  'call.missed': z.object({ callId: callReferenceSchema, reason: z.enum(['declined', 'expired', 'cancelled']) }).strict(),
  'meeting.created': z.object({
    hostConnectionId: participantConnectionReferenceSchema,
    invited: z.boolean(),
    meetingId: meetingReferenceSchema,
  }).strict(),
  'meeting.joined': z.object({ meetingId: meetingReferenceSchema, participantConnectionId: participantConnectionReferenceSchema }).strict(),
  'meeting.ended': z.object({ meetingId: meetingReferenceSchema, reason: eventReasonSchema }).strict(),
  'participant.changed': z.object({ meetingId: meetingReferenceSchema, participantConnectionId: participantConnectionReferenceSchema, state: z.enum(['joined', 'left']) }).strict(),
  'participant.removed': z.object({ meetingId: meetingReferenceSchema, participantConnectionId: participantConnectionReferenceSchema }).strict(),
  'participant.muted': z.object({
    meetingId: meetingReferenceSchema,
    participantConnectionId: participantConnectionReferenceSchema,
    self: z.boolean().optional(),
  }).strict(),
  'media.source.available': z.object({
    callId: callReferenceSchema,
    mediaKind: mediaKindSchema,
    participantConnectionId: participantConnectionReferenceSchema,
    trackReference: opaqueTrackReferenceSchema,
  }).strict(),
  'media.source.unavailable': z.object({
    callId: callReferenceSchema,
    mediaKind: mediaKindSchema,
    participantConnectionId: participantConnectionReferenceSchema,
    reason: eventReasonSchema,
    trackReference: opaqueTrackReferenceSchema,
  }).strict(),
  'media.negotiation': z.object({
    callId: callReferenceSchema,
    description: boundedSessionDescriptionSchema,
    descriptionType: z.enum(['offer', 'answer']),
    expiresAt: timestampSchema,
    generation: mediaGenerationSchema,
    iceServers: z.array(iceServerSchema).min(1).max(4),
    negotiationId: z.uuid(),
    peerHandle: opaqueServerReferenceSchema,
    direction: z.enum(['publish', 'subscribe', 'duplex']),
    trackBindings: z.array(z.object({
      mediaKind: mediaKindSchema,
      participantConnectionId: participantConnectionReferenceSchema.optional(),
      publicationKind: z.enum(['ptt', 'call_audio', 'camera', 'screen']),
      role: z.enum(['local', 'remote']),
      trackReference: opaqueTrackReferenceSchema,
      transceiverMid: serverTransceiverMidSchema,
    }).strict()).min(1).max(16),
  }).strict(),
  'media.policy': z.object({
    callId: callReferenceSchema,
    canPublishCamera: z.boolean(),
    canPublishScreen: z.boolean(),
    canTransmitAudio: z.boolean(),
    generation: mediaGenerationSchema,
  }).strict(),
  'media.failed': z.object({
    callId: callReferenceSchema,
    operation: z.enum(['connect', 'publish', 'subscribe', 'renegotiate', 'screen_share']),
    retryAllowed: z.boolean(),
  }).strict(),
  'media.closed': z.object({ callId: callReferenceSchema, generation: mediaGenerationSchema, reason: eventReasonSchema }).strict(),
  'camera.granted': z.object({ callId: callReferenceSchema, generation: mediaGenerationSchema, trackReference: opaqueTrackReferenceSchema }).strict(),
  'camera.denied': z.object({ callId: callReferenceSchema, reason: z.enum(['not_allowed', 'not_supported', 'unavailable']) }).strict(),
  'camera.revoked': z.object({ callId: callReferenceSchema, reason: eventReasonSchema, trackReference: opaqueTrackReferenceSchema }).strict(),
  'screen.granted': z.object({ callId: callReferenceSchema, generation: mediaGenerationSchema, trackReference: opaqueTrackReferenceSchema }).strict(),
  'screen.denied': z.object({ callId: callReferenceSchema, reason: z.enum(['not_allowed', 'not_supported', 'unavailable']) }).strict(),
  'screen.revoked': z.object({ callId: callReferenceSchema, reason: eventReasonSchema, trackReference: opaqueTrackReferenceSchema }).strict(),
  'focus.granted': z.object({ callId: callReferenceSchema, focusReference: opaqueServerReferenceSchema }).strict(),
  'focus.denied': z.object({ callId: callReferenceSchema, reason: z.enum(['not_allowed', 'unavailable']) }).strict(),
  'focus.revoked': z.object({ callId: callReferenceSchema, focusReference: opaqueServerReferenceSchema, reason: eventReasonSchema }).strict(),
} as const satisfies Record<SygSphereCommsEventKind, z.ZodType>

export const sygsphereCommsCommandEnvelopeSchema = z.object({
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
  commandId: uuidSchema,
  roomId: roomReferenceSchema.optional(),
  expectedRoomVersion: roomSequenceSchema.optional(),
  connectionEpoch: roomSequenceSchema,
  kind: z.enum(SYGSPHERE_COMMS_COMMAND_KINDS),
  payload: z.unknown(),
}).strict()

export type ValidatedSygSphereCommsCommand = Readonly<{
  protocolVersion: typeof SYGSPHERE_COMMS_PROTOCOL_VERSION
  commandId: string
  roomId?: string
  expectedRoomVersion?: number
  connectionEpoch: number
  kind: SygSphereCommsCommandKind
  payload: Record<string, unknown>
}>

export const sygsphereCommsEventEnvelopeSchema = z.object({
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
  eventId: uuidSchema,
  roomId: roomReferenceSchema,
  roomEpoch: roomSequenceSchema,
  roomSeq: roomSequenceSchema,
  serverTime: timestampSchema,
  kind: z.enum(SYGSPHERE_COMMS_EVENT_KINDS),
  payload: z.unknown(),
}).strict()

export type ValidatedSygSphereCommsEvent = Readonly<{
  protocolVersion: typeof SYGSPHERE_COMMS_PROTOCOL_VERSION
  eventId: string
  roomId: string
  roomEpoch: number
  roomSeq: number
  serverTime: string
  kind: SygSphereCommsEventKind
  payload: Record<string, unknown>
}>

/**
 * Parse transport input before coordinator authorization. The parse never
 * treats payload data as authority and intentionally excludes all identity,
 * tenancy, permission, and provider fields from every payload schema.
 */
export const parseSygSphereCommsCommand = (input: unknown): ValidatedSygSphereCommsCommand => {
  const envelope = sygsphereCommsCommandEnvelopeSchema.parse(input)
  const payloadSchema = SYGSPHERE_COMMS_COMMAND_PAYLOAD_SCHEMAS[envelope.kind]
  const payload = payloadSchema.parse(envelope.payload) as Record<string, unknown>
  return { ...envelope, payload }
}

/** Validate server-to-browser events before a client changes local media UI. */
export const parseSygSphereCommsEvent = (input: unknown): ValidatedSygSphereCommsEvent => {
  const envelope = sygsphereCommsEventEnvelopeSchema.parse(input)
  const payloadSchema = SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS[envelope.kind]
  const payload = payloadSchema.parse(envelope.payload) as Record<string, unknown>
  return { ...envelope, payload }
}

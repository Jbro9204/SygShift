/**
 * SygShift-owned shared communications contract.
 * This artifact contains transport-safe shapes only. Canonical authorization
 * derives actor, tenant, room membership, permissions, and provider handles
 * from the authenticated server-side binding.
 */
import { z } from 'zod'

export const SYGSPHERE_COMMS_CONTRACT_VERSION = '1.0.0-draft.3' as const
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
    answer: z.string().min(1).max(65_536),
  }).strict(),
  'media.ready': z.object({
    callId: uuidSchema,
    inputKind: z.enum(['audio', 'video']),
  }).strict(),
  'media.layout': z.object({
    callId: uuidSchema,
    layout: z.enum(['speaker', 'grid']),
  }).strict(),
  'media.stop': z.object({
    callId: uuidSchema,
    trackKind: z.enum(['audio', 'video', 'screen']),
  }).strict(),
  'camera.request': z.object({ callId: uuidSchema }).strict(),
  'camera.release': z.object({ callId: uuidSchema }).strict(),
  'screen.request': z.object({ callId: uuidSchema }).strict(),
  'screen.release': z.object({ callId: uuidSchema }).strict(),
  'focus.request': z.object({ callId: uuidSchema }).strict(),
  'focus.release': z.object({ callId: uuidSchema }).strict(),
} as const satisfies Record<SygSphereCommsCommandKind, z.ZodType>

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

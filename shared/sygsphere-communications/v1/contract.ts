/**
 * SygShift-owned shared communications contract.
 * This artifact contains transport-safe shapes only. Canonical authorization
 * derives actor, tenant, room membership, permissions, and provider handles
 * from the authenticated server-side binding.
 */

export const SYGSPHERE_COMMS_CONTRACT_VERSION = '1.0.0-draft.1' as const
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
  'call.accept',
  'call.decline',
  'call.cancel',
  'call.end',
  'media.answer',
  'media.ready',
  'media.layout',
  'media.stop',
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
  'call.accepted',
  'call.ended',
  'call.missed',
  'participant.changed',
  'media.negotiation',
  'media.policy',
  'media.failed',
  'media.closed',
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

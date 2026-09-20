/**
 * Server-owned meeting and publication lifecycle. It intentionally models a
 * bounded room (up to the approved 50-participant pilot ceiling), moderator
 * actions, and publication grants before any media provider action occurs.
 */
export type MeetingParticipant = Readonly<{
  connectionId: string
  muted: boolean
}>

export type ServerMeeting = Readonly<{
  hostConnectionId: string
  maxParticipants: 5 | 10 | 20 | 50
  meetingId: string
  participants: ReadonlyMap<string, MeetingParticipant>
  state: 'active' | 'ended'
}>

export type MeetingMediaKind = 'camera' | 'screen'

export type ServerMeetingEvent =
  | Readonly<{ kind: 'meeting.created'; payload: Readonly<{ meetingId: string }> }>
  | Readonly<{ kind: 'meeting.joined'; payload: Readonly<{ meetingId: string, participantConnectionId: string }> }>
  | Readonly<{ kind: 'meeting.ended'; payload: Readonly<{ meetingId: string, reason: 'ended' | 'moderated' | 'unavailable' }> }>
  | Readonly<{ kind: 'participant.changed'; payload: Readonly<{ meetingId: string, participantConnectionId: string, state: 'joined' | 'left' }> }>
  | Readonly<{ kind: 'participant.removed'; payload: Readonly<{ meetingId: string, participantConnectionId: string }> }>
  | Readonly<{ kind: 'participant.muted'; payload: Readonly<{ meetingId: string, participantConnectionId: string }> }>
  | Readonly<{ kind: 'camera.granted'; payload: Readonly<{ callId: string, generation: number, trackReference: string }> }>
  | Readonly<{ kind: 'camera.denied'; payload: Readonly<{ callId: string, reason: 'not_allowed' | 'not_supported' | 'unavailable' }> }>
  | Readonly<{ kind: 'screen.granted'; payload: Readonly<{ callId: string, generation: number, trackReference: string }> }>
  | Readonly<{ kind: 'screen.denied'; payload: Readonly<{ callId: string, reason: 'not_allowed' | 'not_supported' | 'unavailable' }> }>

export type ServerMeetingMediaGrant = Readonly<{
  event: Extract<ServerMeetingEvent, { kind: 'camera.granted' | 'screen.granted' }>
  publication: Readonly<{
    callId: string
    generation: number
    kind: MeetingMediaKind
    participantConnectionId: string
    trackReference: string
  }>
}>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const opaqueReferencePattern = /^[A-Za-z0-9_-]{1,128}$/
const validUuid = (value: string): boolean => uuidPattern.test(value)
const validCapacity = (value: number): value is ServerMeeting['maxParticipants'] => value === 5 || value === 10 || value === 20 || value === 50

const participantMap = (participants: Iterable<MeetingParticipant>): ReadonlyMap<string, MeetingParticipant> => new Map(
  [...participants].map((participant) => [participant.connectionId, participant]),
)

export const createServerMeeting = (input: Readonly<{
  hostConnectionId: string
  maxParticipants: 5 | 10 | 20 | 50
  meetingId: string
}>): Readonly<{ event: ServerMeetingEvent, state: ServerMeeting }> => {
  if (!validUuid(input.meetingId) || !validUuid(input.hostConnectionId) || !validCapacity(input.maxParticipants)) {
    throw new Error('The server meeting creation is invalid.')
  }
  const state: ServerMeeting = {
    hostConnectionId: input.hostConnectionId,
    maxParticipants: input.maxParticipants,
    meetingId: input.meetingId,
    participants: participantMap([{ connectionId: input.hostConnectionId, muted: false }]),
    state: 'active',
  }
  return { event: { kind: 'meeting.created', payload: { meetingId: state.meetingId } }, state }
}

/** The coordinator supplies member eligibility; this function never infers it from browser input. */
export const joinServerMeeting = (
  meeting: ServerMeeting,
  input: Readonly<{ coordinatorAuthorized: boolean, participantConnectionId: string }>,
): Readonly<{ event: ServerMeetingEvent | null, state: ServerMeeting }> => {
  if (meeting.state !== 'active' || !input.coordinatorAuthorized || !validUuid(input.participantConnectionId) || meeting.participants.has(input.participantConnectionId)) {
    return { event: null, state: meeting }
  }
  if (meeting.participants.size >= meeting.maxParticipants) return { event: null, state: meeting }
  const participants = participantMap([...meeting.participants.values(), { connectionId: input.participantConnectionId, muted: false }])
  const state: ServerMeeting = { ...meeting, participants }
  return {
    event: { kind: 'meeting.joined', payload: { meetingId: state.meetingId, participantConnectionId: input.participantConnectionId } },
    state,
  }
}

export const leaveServerMeeting = (
  meeting: ServerMeeting,
  participantConnectionId: string,
): Readonly<{ event: ServerMeetingEvent | null, state: ServerMeeting }> => {
  if (meeting.state !== 'active' || !meeting.participants.has(participantConnectionId)) return { event: null, state: meeting }
  const participants = participantMap([...meeting.participants.values()].filter((participant) => participant.connectionId !== participantConnectionId))
  const state: ServerMeeting = { ...meeting, participants }
  return {
    event: { kind: 'participant.changed', payload: { meetingId: state.meetingId, participantConnectionId, state: 'left' } },
    state,
  }
}

/** Moderator authority is resolved before this boundary; a host is not implied to be a moderator. */
export const removeServerMeetingParticipant = (
  meeting: ServerMeeting,
  input: Readonly<{ coordinatorMayModerate: boolean, participantConnectionId: string }>,
): Readonly<{ event: ServerMeetingEvent | null, state: ServerMeeting }> => {
  if (meeting.state !== 'active' || !input.coordinatorMayModerate || input.participantConnectionId === meeting.hostConnectionId || !meeting.participants.has(input.participantConnectionId)) {
    return { event: null, state: meeting }
  }
  const participants = participantMap([...meeting.participants.values()].filter((participant) => participant.connectionId !== input.participantConnectionId))
  const state: ServerMeeting = { ...meeting, participants }
  return {
    event: { kind: 'participant.removed', payload: { meetingId: state.meetingId, participantConnectionId: input.participantConnectionId } },
    state,
  }
}

export const muteServerMeetingParticipant = (
  meeting: ServerMeeting,
  input: Readonly<{ coordinatorMayModerate: boolean, participantConnectionId: string }>,
): Readonly<{ event: ServerMeetingEvent | null, state: ServerMeeting }> => {
  const participant = meeting.participants.get(input.participantConnectionId)
  if (meeting.state !== 'active' || !input.coordinatorMayModerate || !participant || participant.muted) return { event: null, state: meeting }
  const participants = participantMap([...meeting.participants.values()].map((current) => current.connectionId === input.participantConnectionId ? { ...current, muted: true } : current))
  const state: ServerMeeting = { ...meeting, participants }
  return {
    event: { kind: 'participant.muted', payload: { meetingId: state.meetingId, participantConnectionId: input.participantConnectionId } },
    state,
  }
}

export const endServerMeeting = (
  meeting: ServerMeeting,
  input: Readonly<{ coordinatorMayModerate: boolean, reason: 'ended' | 'moderated' | 'unavailable' }>,
): Readonly<{ event: ServerMeetingEvent | null, state: ServerMeeting }> => {
  if (meeting.state !== 'active' || !input.coordinatorMayModerate) return { event: null, state: meeting }
  const state: ServerMeeting = { ...meeting, state: 'ended' }
  return { event: { kind: 'meeting.ended', payload: { meetingId: state.meetingId, reason: input.reason } }, state }
}

/**
 * Publishing a camera or screen remains denied unless the coordinator already
 * checked membership, role, current meeting state, and device capability.
 */
export const grantServerMeetingMedia = (input: Readonly<{
  callId: string
  coordinatorAuthorized: boolean
  deviceSupported: boolean
  generation: number
  kind: MeetingMediaKind
  meeting: ServerMeeting
  participantConnectionId: string
  trackReference: string
}>): ServerMeetingMediaGrant | Extract<ServerMeetingEvent, { kind: 'camera.denied' | 'screen.denied' }> => {
  const eventKind = input.kind === 'camera' ? 'camera' : 'screen'
  const denied = (reason: 'not_allowed' | 'not_supported' | 'unavailable') => ({
    kind: `${eventKind}.denied` as 'camera.denied' | 'screen.denied',
    payload: { callId: input.callId, reason },
  })
  if (!validUuid(input.callId) || !Number.isSafeInteger(input.generation) || input.generation < 0 || !validUuid(input.participantConnectionId) || !opaqueReferencePattern.test(input.trackReference)) {
    return denied('unavailable')
  }
  if (input.meeting.state !== 'active' || !input.meeting.participants.has(input.participantConnectionId) || !input.coordinatorAuthorized) return denied('not_allowed')
  if (!input.deviceSupported) return denied('not_supported')
  const event = {
    kind: `${eventKind}.granted` as 'camera.granted' | 'screen.granted',
    payload: { callId: input.callId, generation: input.generation, trackReference: input.trackReference },
  } as Extract<ServerMeetingEvent, { kind: 'camera.granted' | 'screen.granted' }>
  return {
    event,
    publication: {
      callId: input.callId,
      generation: input.generation,
      kind: input.kind,
      participantConnectionId: input.participantConnectionId,
      trackReference: input.trackReference,
    },
  }
}

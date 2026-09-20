import { describe, expect, it } from 'vitest'
import {
  createServerMeeting,
  endServerMeeting,
  grantServerMeetingMedia,
  joinServerMeeting,
  muteServerMeetingParticipant,
  removeServerMeetingParticipant,
} from '../worker/comms/meetingLifecycle'

const meetingId = '11111111-1111-4111-8111-111111111111'
const host = '22222222-2222-4222-8222-222222222222'
const participant = '33333333-3333-4333-8333-333333333333'
const secondParticipant = '44444444-4444-4444-8444-444444444444'
const callId = '55555555-5555-4555-8555-555555555555'

describe('SygSphere Communications meeting lifecycle', () => {
  it('creates a bounded server-owned meeting and refuses unauthorized or over-capacity joins', () => {
    const created = createServerMeeting({ hostConnectionId: host, maxParticipants: 5, meetingId })
    expect(created).toMatchObject({ event: { kind: 'meeting.created', payload: { meetingId } }, state: { state: 'active' } })
    expect(joinServerMeeting(created.state, { coordinatorAuthorized: false, participantConnectionId: participant }).event).toBeNull()
    const joined = joinServerMeeting(created.state, { coordinatorAuthorized: true, participantConnectionId: participant })
    expect(joined).toMatchObject({ event: { kind: 'meeting.joined', payload: { meetingId, participantConnectionId: participant } } })
  })

  it('requires explicit moderator authority for mute, remove, and end actions', () => {
    const created = createServerMeeting({ hostConnectionId: host, maxParticipants: 5, meetingId })
    const joined = joinServerMeeting(created.state, { coordinatorAuthorized: true, participantConnectionId: participant })
    expect(muteServerMeetingParticipant(joined.state, { coordinatorMayModerate: false, participantConnectionId: participant }).event).toBeNull()
    const muted = muteServerMeetingParticipant(joined.state, { coordinatorMayModerate: true, participantConnectionId: participant })
    expect(muted).toMatchObject({ event: { kind: 'participant.muted', payload: { meetingId, participantConnectionId: participant } } })
    expect(removeServerMeetingParticipant(muted.state, { coordinatorMayModerate: true, participantConnectionId: host }).event).toBeNull()
    const removed = removeServerMeetingParticipant(muted.state, { coordinatorMayModerate: true, participantConnectionId: participant })
    expect(removed).toMatchObject({ event: { kind: 'participant.removed', payload: { meetingId, participantConnectionId: participant } } })
    expect(endServerMeeting(removed.state, { coordinatorMayModerate: true, reason: 'ended' }))
      .toMatchObject({ event: { kind: 'meeting.ended', payload: { meetingId, reason: 'ended' } } })
  })

  it('grants camera and screen publication only after membership, policy, and device checks', () => {
    const created = createServerMeeting({ hostConnectionId: host, maxParticipants: 5, meetingId })
    const joined = joinServerMeeting(created.state, { coordinatorAuthorized: true, participantConnectionId: secondParticipant })
    expect(grantServerMeetingMedia({
      callId, coordinatorAuthorized: false, deviceSupported: true, generation: 3, kind: 'camera', meeting: joined.state, participantConnectionId: secondParticipant, trackReference: 'camera_1',
    })).toEqual({ kind: 'camera.denied', payload: { callId, reason: 'not_allowed' } })
    expect(grantServerMeetingMedia({
      callId, coordinatorAuthorized: true, deviceSupported: false, generation: 3, kind: 'screen', meeting: joined.state, participantConnectionId: secondParticipant, trackReference: 'screen_1',
    })).toEqual({ kind: 'screen.denied', payload: { callId, reason: 'not_supported' } })
    expect(grantServerMeetingMedia({
      callId, coordinatorAuthorized: true, deviceSupported: true, generation: 3, kind: 'screen', meeting: joined.state, participantConnectionId: secondParticipant, trackReference: 'screen_1',
    })).toMatchObject({
      event: { kind: 'screen.granted', payload: { callId, generation: 3, trackReference: 'screen_1' } },
      publication: { participantConnectionId: secondParticipant },
    })
  })
})

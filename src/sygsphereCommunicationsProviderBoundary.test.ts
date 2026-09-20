import { describe, expect, it } from 'vitest'
import { closedCloudflareRealtimeAdapter } from '../worker/comms/cloudflareRealtimeAdapter'
import { activateProviderSession, closeProviderSession, createProviderSession, forceCloseProviderTrack, registerProviderTrack } from '../worker/comms/providerSessionRegistry'

describe('SygSphere Communications provider boundary', () => {
  it('remains closed without provider configuration or browser media authority', async () => {
    await expect(closedCloudflareRealtimeAdapter.execute({
      operation: 'create_session', requestId: 'request-1', roomId: 'room-1', tenantId: 'tenant-1',
    })).resolves.toEqual({ outcome: 'provider_unavailable', requestId: 'request-1' })
  })

  it('force-closes a single track and closes every remaining track when a session ends', () => {
    const active = activateProviderSession(createProviderSession('session-1', 'tenant-1'))
    const withTracks = registerProviderTrack(registerProviderTrack(active, { id: 'audio-1', kind: 'audio', state: 'active' }), { id: 'screen-1', kind: 'screen', state: 'active' })
    const forceClosed = forceCloseProviderTrack(withTracks, 'screen-1')
    expect(forceClosed.tracks.get('audio-1')?.state).toBe('active')
    expect(forceClosed.tracks.get('screen-1')?.state).toBe('closed')
    const closed = closeProviderSession(forceClosed)
    expect(closed.state).toBe('closed')
    expect([...closed.tracks.values()].every((track) => track.state === 'closed')).toBe(true)
  })
})

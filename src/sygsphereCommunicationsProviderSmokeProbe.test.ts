import { describe, expect, it, vi } from 'vitest'
import { runSygSphereProviderSmokeProbe } from '../worker/comms/tenantCommsDurableObject'

describe('SygSphere provider smoke probe', () => {
  it('uses a 60-second credential and discards every provider value', async () => {
    const adapter = {
      createSession: vi.fn().mockResolvedValue({
        outcome: 'accepted',
        value: { sessionId: 'provider-session-that-must-not-escape' },
      }),
      generateIceServers: vi.fn().mockResolvedValue({
        outcome: 'accepted',
        value: {
          iceServers: [{
            credential: 'turn-password-that-must-not-escape',
            urls: ['turns:private.example.invalid:5349'],
            username: 'turn-user-that-must-not-escape',
          }],
        },
      }),
    }

    const result = await runSygSphereProviderSmokeProbe(
      adapter as Parameters<typeof runSygSphereProviderSmokeProbe>[0],
      '10000000-0000-4000-8000-000000000001',
    )

    expect(adapter.generateIceServers).toHaveBeenCalledWith(60)
    expect(adapter.createSession).toHaveBeenCalledWith({ tenantId: '10000000-0000-4000-8000-000000000001' })
    expect(result).toEqual({ emptySfuSession: true, turnCredentials: true })
    expect(JSON.stringify(result)).not.toContain('turn-password')
    expect(JSON.stringify(result)).not.toContain('turn-user')
    expect(JSON.stringify(result)).not.toContain('provider-session')
  })

  it('returns independent sanitized failure flags when either provider check fails', async () => {
    const adapter = {
      createSession: vi.fn().mockResolvedValue({
        outcome: 'accepted',
        value: { sessionId: 'provider-session' },
      }),
      generateIceServers: vi.fn().mockResolvedValue({
        outcome: 'provider_rejected',
        reconciliationRequired: false,
      }),
    }

    await expect(runSygSphereProviderSmokeProbe(
      adapter as Parameters<typeof runSygSphereProviderSmokeProbe>[0],
      '10000000-0000-4000-8000-000000000001',
    )).resolves.toEqual({ emptySfuSession: true, turnCredentials: false })
  })
})

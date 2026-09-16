import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseClient } from '../lib/supabase'
import { getPlatformPresenceDirectory, platformPresenceLabels, recordPlatformPresence } from './platformPresence'

vi.mock('../lib/supabase', () => ({ getSupabaseClient: vi.fn() }))

describe('shared platform presence contract', () => {
  const employeeId = '11111111-1111-4111-8111-111111111111'
  const clientId = '22222222-2222-4222-8222-222222222222'
  const rpc = vi.fn()

  beforeEach(() => {
    rpc.mockReset()
    vi.mocked(getSupabaseClient).mockReturnValue({ rpc } as never)
  })

  it('records only the bounded application, client, and state contract', async () => {
    rpc.mockResolvedValue({ data: { status: 'active', lastActiveAt: '2026-09-16T12:00:00Z', applications: ['sygshift'], accountEnabled: true }, error: null })
    await expect(recordPlatformPresence(clientId, 'sygshift', 'active')).resolves.toMatchObject({ status: 'active' })
    expect(rpc).toHaveBeenCalledWith('record_platform_presence', {
      target_application: 'sygshift',
      target_client_instance_id: clientId,
      target_state: 'active',
    })
  })

  it('parses the compact admin directory without mixing presence with login history', async () => {
    rpc.mockResolvedValue({ data: { serverTimestamp: '2026-09-16T12:00:00Z', currentEmployeeId: employeeId, people: [{ employeeId, status: 'away', lastActiveAt: '2026-09-16T11:59:00Z', applications: ['sygilant'], accountEnabled: true }] }, error: null })
    await expect(getPlatformPresenceDirectory()).resolves.toMatchObject({ people: [{ status: 'away', applications: ['sygilant'] }] })
    expect(platformPresenceLabels.never_active).toBe('Never active')
  })

  it('fails closed when the live presence directory is unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'network' } })
    await expect(getPlatformPresenceDirectory()).rejects.toThrow('Live presence is temporarily unavailable.')
  })
})

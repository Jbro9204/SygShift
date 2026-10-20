import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getNotificationCenter } from './operations'
import { legacyNotificationCenterSchema } from '../test/legacyNotificationCenterContract'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => ({ rpc: mock.rpc }) }))

const legacyStates = ['queued', 'delivered', 'failed'] as const
const currentStates = [...legacyStates, 'suppressed', 'canceled', 'retry_exhausted'] as const
const evidencePath = process.env.NOTIFICATION_READER_CONTRACT_EVIDENCE
const response = (status: typeof currentStates[number]) => ({
  permissions: { canManage: true },
  summary: { pending: 1, delivered: 1, failed: 1, suppressed: 1, canceled: 1, retryExhausted: 1 },
  page: { number: 1, size: 10, total: 1, totalPages: 1 },
  batches: [{
    id: '10000000-0000-4000-8000-000000000001', messageType: 'schedule_published',
    aggregateType: 'reader_compatibility', aggregateId: null, subject: 'Reader contract fixture', status,
    recipientCount: 1, attemptCount: 1, availableAt: '2026-10-19T23:00:00Z', createdAt: '2026-10-19T23:00:00Z',
    deliveredAt: status === 'delivered' ? '2026-10-19T23:00:00Z' : null,
    failedAt: ['failed', 'suppressed', 'canceled', 'retry_exhausted'].includes(status) ? '2026-10-19T23:00:00Z' : null,
    lastError: null, channels: ['Email'],
  }],
})

describe('versioned notification reader compatibility', () => {
  beforeEach(() => mock.rpc.mockReset())

  it.each(currentStates)('new clients explicitly opt into v2 for %s', async (status) => {
    mock.rpc.mockResolvedValueOnce({ data: response(status), error: null })
    await expect(getNotificationCenter({ status, search: ' fixture ', page: 2, pageSize: 5 })).resolves.toEqual(response(status))
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('get_notification_center_v2', {
      target_date_from: null, target_date_through: null, target_page: 2, target_page_size: 5,
      target_search: 'fixture', target_status: status,
    })
  })

  it.each(legacyStates)('the deployed browser schema accepts legacy %s', (status) => {
    expect(legacyNotificationCenterSchema.parse(response(status)).batches[0].status).toBe(status)
  })

  it.each(['suppressed', 'canceled', 'retry_exhausted'] as const)('proves why %s must not reach the legacy reader', (status) => {
    expect(() => legacyNotificationCenterSchema.parse(response(status))).toThrow()
  })

  it('does not fall back to v1 or silently hide missing migration/authorization errors', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Versioned reader is unavailable.' } })
    await expect(getNotificationCenter()).rejects.toThrow('Versioned reader is unavailable.')
    expect(mock.rpc).toHaveBeenCalledTimes(1)
    expect(mock.rpc.mock.calls[0][0]).toBe('get_notification_center_v2')
  })

  it('preserves an explicit forward-recovery visibility notice without changing the legacy contract', async () => {
    const coarse = legacyNotificationCenterSchema.parse(response('failed'))
    mock.rpc.mockResolvedValueOnce({ data: { ...coarse, deliveryVisibility: 'legacy' }, error: null })
    await expect(getNotificationCenter()).resolves.toEqual({ ...coarse, deliveryVisibility: 'legacy' })
    expect(mock.rpc.mock.calls[0][0]).toBe('get_notification_center_v2')
  })

  it.skipIf(!evidencePath)('parses real rollback-only database results when the local rehearsal provides evidence', async () => {
    // The SQL harness exports only synthetic fixture batches; this does not load production rows.
    const evidence = JSON.parse(readFileSync(resolve(evidencePath!), 'utf8')) as { contracts: { phase: string, legacy: unknown, current: unknown }[] }
    expect(evidence.contracts.length).toBeGreaterThanOrEqual(5)
    for (const contract of evidence.contracts) {
      expect(legacyNotificationCenterSchema.safeParse(contract.legacy).success, contract.phase).toBe(true)
      mock.rpc.mockResolvedValueOnce({ data: contract.current, error: null })
      await expect(getNotificationCenter()).resolves.toEqual(contract.current)
    }
  })
})

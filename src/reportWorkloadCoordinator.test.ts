import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReportWorkloadCoordinator, reportWorkloadPolicy } from '../worker/reportWorkloadCoordinator'

type Row = { lease_id: string; lane: string; resource_key: string | null; expires_at_ms: number }
class MemorySql {
  rows: Row[] = []
  exec(query: string, ...bindings: unknown[]) {
    if (query.startsWith('create table')) return { toArray: () => [] }
    if (query.startsWith('select ')) return { toArray: () => this.rows.map((row) => ({ ...row })) }
    if (query.startsWith('insert ')) this.rows.push({
      lease_id: String(bindings[0]), lane: String(bindings[1]),
      resource_key: bindings[2] === null ? null : String(bindings[2]), expires_at_ms: Number(bindings[3]),
    })
    else if (query.includes('where expires_at_ms <= ?')) this.rows = this.rows.filter((row) => row.expires_at_ms > Number(bindings[0]))
    else if (query.startsWith('delete ')) this.rows = this.rows.filter((row) => row.lease_id !== bindings[0])
    else if (query.startsWith('update ')) this.rows = this.rows.map((row) => row.lease_id === bindings[1] ? { ...row, expires_at_ms: Number(bindings[0]) } : row)
    else throw new Error('Unexpected SQL')
    return { toArray: () => [] }
  }
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const resource = `report:${'a'.repeat(64)}`
function coordinator(sql = new MemorySql()) {
  return { sql, object: new ReportWorkloadCoordinator({
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(), storage: { sql },
  } as never, {}) }
}
afterEach(() => vi.useRealTimers())

describe('shared report workload admission', () => {
  it('atomically bounds concurrent callers and preserves active permits after replacement', async () => {
    const { sql, object } = coordinator()
    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => object.acquire({ leaseId: id(n), lane: 'read', resourceKey: null })))
    expect(results.filter((result) => result.allowed)).toHaveLength(reportWorkloadPolicy.capacity)
    const replacement = coordinator(sql).object
    expect(await replacement.getSnapshot()).toMatchObject({ active: 4 })
    expect(await replacement.acquire({ leaseId: id(22), lane: 'read', resourceKey: null })).toEqual({ allowed: false, retryAfterSeconds: 3 })
  })

  it('is idempotent for a duplicate lease but rejects changing its scope', async () => {
    const { object } = coordinator()
    const input = { leaseId: id(1), lane: 'write' as const, resourceKey: resource }
    expect(await object.acquire(input)).toEqual(await object.acquire(input))
    expect(await object.getSnapshot()).toMatchObject({ active: 1 })
    await expect(object.acquire({ ...input, lane: 'read' })).rejects.toThrow('scope cannot change')
  })

  it('serializes report mutations without blocking independent reads', async () => {
    const { object } = coordinator()
    expect((await object.acquire({ leaseId: id(1), lane: 'write', resourceKey: resource })).allowed).toBe(true)
    expect((await object.acquire({ leaseId: id(2), lane: 'write', resourceKey: resource })).allowed).toBe(false)
    expect((await object.acquire({ leaseId: id(3), lane: 'read', resourceKey: resource })).allowed).toBe(true)
    expect((await object.acquire({ leaseId: id(4), lane: 'write', resourceKey: `report:${'b'.repeat(64)}` })).allowed).toBe(true)
  })

  it('limits expensive exports to one within the shared capacity', async () => {
    const { object } = coordinator()
    expect((await object.acquire({ leaseId: id(1), lane: 'export', resourceKey: resource })).allowed).toBe(true)
    expect((await object.acquire({ leaseId: id(2), lane: 'export', resourceKey: null })).allowed).toBe(false)
    expect((await object.acquire({ leaseId: id(3), lane: 'read', resourceKey: null })).allowed).toBe(true)
  })

  it('renews persisted permits, reclaims expired ones and rejects late resurrection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { sql, object } = coordinator()
    await object.acquire({ leaseId: id(1), lane: 'write', resourceKey: resource })
    vi.setSystemTime(100_000)
    expect(await object.renew({ leaseId: id(1) })).toEqual({ renewed: true, leaseMs: 120_000, expiresAtMs: 220_000 })
    vi.setSystemTime(150_000)
    expect(await coordinator(sql).object.getSnapshot()).toMatchObject({ active: 1 })
    vi.setSystemTime(221_000)
    expect(await object.renew({ leaseId: id(1) })).toEqual({ renewed: false })
    expect(await object.getSnapshot()).toMatchObject({ active: 0 })
  })

  it('releases only the supplied lease and is safely repeatable', async () => {
    const { object } = coordinator()
    await object.acquire({ leaseId: id(1), lane: 'read', resourceKey: null })
    await object.acquire({ leaseId: id(2), lane: 'read', resourceKey: null })
    await object.release({ leaseId: id(1) })
    await object.release({ leaseId: id(1) })
    expect(await object.getSnapshot()).toMatchObject({ active: 1 })
  })

  it('rejects unbounded or identifying caller-controlled values', async () => {
    const { object } = coordinator()
    await expect(object.acquire({ leaseId: 'employee@example.test', lane: 'read', resourceKey: null })).rejects.toThrow('Invalid report permit')
    await expect(object.acquire({ leaseId: id(1), lane: 'write', resourceKey: 'private-report-title' })).rejects.toThrow('Invalid report workload scope')
    expect(await object.getSnapshot()).toMatchObject({ active: 0 })
  })
})

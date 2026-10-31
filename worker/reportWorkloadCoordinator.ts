import { DurableObject } from 'cloudflare:workers'

// This coordinates only the shared database's report workload, not all traffic.
// It grants resource permits, never identity, permissions, or report authority.
export const reportWorkloadPolicy = Object.freeze({
  capacity: 4,
  exportCapacity: 1,
  leaseMs: 120_000,
})

type ReportLane = 'read' | 'write' | 'export'
type PermitRow = { lease_id: string; lane: ReportLane; resource_key: string | null; expires_at_ms: number }
type PermitInput = { leaseId: string; lane: ReportLane; resourceKey: string | null }
type PermitResult =
  | { allowed: true; leaseId: string; expiresAtMs: number; leaseMs: number }
  | { allowed: false; retryAfterSeconds: number }

const leasePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const resourcePattern = /^report:[0-9a-f]{64}$/

export class ReportWorkloadCoordinator extends DurableObject<unknown> {
  private readonly initialization: Promise<void>

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    this.initialization = ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`create table if not exists report_workload_permits (
        lease_id text primary key,
        lane text not null,
        resource_key text,
        expires_at_ms integer not null
      )`)
    })
  }

  async acquire(input: PermitInput): Promise<PermitResult> {
    await this.initialization
    this.validateLease(input.leaseId)
    if (!['read', 'write', 'export'].includes(input.lane)
      || (input.resourceKey !== null && !resourcePattern.test(input.resourceKey))) {
      throw new Error('Invalid report workload scope.')
    }
    const now = Date.now()
    // No await between pruning, reading and inserting: the DO input gate keeps
    // the admission decision atomic. All state survives instance replacement.
    this.prune(now)
    const permits = this.rows()
    const existing = permits.find((row) => row.lease_id === input.leaseId)
    if (existing) {
      if (existing.lane !== input.lane || existing.resource_key !== input.resourceKey) {
        throw new Error('Report permit scope cannot change.')
      }
      return this.granted(existing)
    }
    const exportFull = input.lane === 'export'
      && permits.filter((row) => row.lane === 'export').length >= reportWorkloadPolicy.exportCapacity
    const conflicting = input.lane !== 'read' && input.resourceKey !== null
      && permits.some((row) => row.lane !== 'read' && row.resource_key === input.resourceKey)
    if (permits.length >= reportWorkloadPolicy.capacity || exportFull || conflicting) {
      return { allowed: false, retryAfterSeconds: 3 }
    }
    const row: PermitRow = {
      lease_id: input.leaseId,
      lane: input.lane,
      resource_key: input.resourceKey,
      expires_at_ms: now + reportWorkloadPolicy.leaseMs,
    }
    this.ctx.storage.sql.exec(
      'insert into report_workload_permits (lease_id, lane, resource_key, expires_at_ms) values (?, ?, ?, ?)',
      row.lease_id, row.lane, row.resource_key, row.expires_at_ms,
    )
    return this.granted(row)
  }

  async renew(input: { leaseId: string }): Promise<{ renewed: false } | { renewed: true; leaseMs: number; expiresAtMs: number }> {
    await this.initialization
    this.validateLease(input.leaseId)
    const now = Date.now()
    this.prune(now)
    if (!this.rows().some((row) => row.lease_id === input.leaseId)) return { renewed: false }
    this.ctx.storage.sql.exec(
      'update report_workload_permits set expires_at_ms = ? where lease_id = ?',
      now + reportWorkloadPolicy.leaseMs, input.leaseId,
    )
    return { renewed: true, leaseMs: reportWorkloadPolicy.leaseMs, expiresAtMs: now + reportWorkloadPolicy.leaseMs }
  }

  async release(input: { leaseId: string }): Promise<void> {
    await this.initialization
    this.validateLease(input.leaseId)
    this.ctx.storage.sql.exec('delete from report_workload_permits where lease_id = ?', input.leaseId)
  }

  async getSnapshot() {
    await this.initialization
    this.prune(Date.now())
    const permits = this.rows()
    return {
      capacity: reportWorkloadPolicy.capacity,
      exportCapacity: reportWorkloadPolicy.exportCapacity,
      leaseMs: reportWorkloadPolicy.leaseMs,
      active: permits.length,
      exports: permits.filter((row) => row.lane === 'export').length,
    }
  }

  private validateLease(value: string) {
    if (typeof value !== 'string' || !leasePattern.test(value)) throw new Error('Invalid report permit.')
  }

  private prune(now: number) {
    this.ctx.storage.sql.exec('delete from report_workload_permits where expires_at_ms <= ?', now)
  }

  private rows(): PermitRow[] {
    return this.ctx.storage.sql.exec<PermitRow>(
      'select lease_id, lane, resource_key, expires_at_ms from report_workload_permits',
    ).toArray()
  }

  private granted(row: PermitRow): PermitResult {
    return { allowed: true, leaseId: row.lease_id, expiresAtMs: row.expires_at_ms, leaseMs: reportWorkloadPolicy.leaseMs }
  }
}

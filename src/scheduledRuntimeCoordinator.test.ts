import { describe, expect, it, vi } from 'vitest'
import {
  ScheduledRuntimeCoordinator,
  acquireScheduledRuntimeCycle,
  completeScheduledRuntimeCycle,
  createInitialScheduledRuntimeState,
  failScheduledRuntimeCycle,
  recoverScheduledRuntimeCycle,
  releaseScheduledRuntimeCycle,
  renewScheduledRuntimeCycle,
  scheduledRuntimeCooldownsMs,
  scheduledRuntimeLeaseMs,
  scheduledRuntimeSnapshot,
  type ScheduledRuntimeState,
} from '../worker/scheduledRuntimeCoordinator'

const firstLease = '10000000-0000-4000-8000-000000000001'
const secondLease = '10000000-0000-4000-8000-000000000002'
const firstSourceCommit = '1'.repeat(40)
const secondSourceCommit = '2'.repeat(40)

function acquire(
  state: ScheduledRuntimeState,
  nowMs: number,
  leaseId: string,
) {
  return acquireScheduledRuntimeCycle(state, { scheduledTimeMs: nowMs }, nowMs, leaseId)
}

describe('scheduled runtime circuit policy', () => {
  it('grants one full-cycle lease and skips overlapping work', () => {
    const initial = createInitialScheduledRuntimeState(1_000)
    const first = acquire(initial, 1_000, firstLease)

    expect(first.result).toMatchObject({
      decision: 'run_full',
      leaseExpiresAtMs: 1_000 + scheduledRuntimeLeaseMs,
      leaseId: firstLease,
    })

    const overlap = acquire(first.state, 2_000, secondLease)
    expect(overlap.result).toMatchObject({
      decision: 'skip',
      reason: 'lease_active',
      retryAtMs: 1_000 + scheduledRuntimeLeaseMs,
    })
    expect(overlap.state.activeLeaseId).toBe(firstLease)
  })

  it('allows an expired lease to be replaced and rejects its stale completion', () => {
    const initial = createInitialScheduledRuntimeState(0)
    const first = acquire(initial, 1_000, firstLease)
    const replacementAt = 1_000 + scheduledRuntimeLeaseMs
    const replacement = acquire(first.state, replacementAt, secondLease)

    expect(replacement.result).toMatchObject({ decision: 'run_full', leaseId: secondLease })
    const staleCompletion = completeScheduledRuntimeCycle(
      replacement.state,
      { leaseId: firstLease, sourceCommit: firstSourceCommit },
      replacementAt + 1,
    )
    expect(staleCompletion.applied).toBe(false)
    expect(staleCompletion.state.activeLeaseId).toBe(secondLease)

    const currentCompletion = completeScheduledRuntimeCycle(
      staleCompletion.state,
      { leaseId: secondLease, sourceCommit: firstSourceCommit },
      replacementAt + 2,
    )
    expect(currentCompletion.applied).toBe(true)
    expect(currentCompletion.state.activeLeaseId).toBeNull()
  })

  it('opens immediately and limits recovery probes to one per minute', () => {
    let nowMs = 1_000
    let state = createInitialScheduledRuntimeState(nowMs)

    for (let failure = 0; failure < 7; failure += 1) {
      const leaseId = `10000000-0000-4000-8000-${String(failure + 1).padStart(12, '0')}`
      const acquired = acquire(state, nowMs, leaseId)
      expect(acquired.result.decision).toBe(failure === 0 ? 'run_full' : 'run_recovery_probe')

      const failed = failScheduledRuntimeCycle(acquired.state, {
        leaseId,
        operation: 'service_run_timekeeping_automation',
        status: 504,
        timedOut: true,
      }, nowMs + 1)
      const expectedCooldown = scheduledRuntimeCooldownsMs[Math.min(failure, scheduledRuntimeCooldownsMs.length - 1)]

      expect(failed.applied).toBe(true)
      expect(failed.state.mode).toBe('open')
      expect(failed.state.nextProbeAtMs).toBe(nowMs + expectedCooldown)
      expect(failed.state.openedAtMs).toBe(1_001)

      const contained = acquire(failed.state, nowMs + 2, secondLease)
      expect(contained.result).toMatchObject({ decision: 'skip', reason: 'cooldown' })
      state = failed.state
      nowMs = failed.state.nextProbeAtMs!
    }
  })

  it('renews a running cycle so the next minute cannot start overlapping work', () => {
    const acquired = acquire(createInitialScheduledRuntimeState(0), 1_000, firstLease)

    const nextMinute = acquire(acquired.state, 61_000, secondLease)
    expect(nextMinute.result).toMatchObject({
      decision: 'skip',
      reason: 'lease_active',
      retryAtMs: 1_000 + scheduledRuntimeLeaseMs,
    })

    const renewed = renewScheduledRuntimeCycle(acquired.state, { leaseId: firstLease }, 70_000)
    expect(renewed.applied).toBe(true)
    expect(renewed.state.leaseExpiresAtMs).toBe(70_000 + scheduledRuntimeLeaseMs)

    const followingMinute = acquire(renewed.state, 121_000, secondLease)
    expect(followingMinute.result).toMatchObject({
      decision: 'skip',
      reason: 'lease_active',
      retryAtMs: 70_000 + scheduledRuntimeLeaseMs,
    })

    const staleRenewal = renewScheduledRuntimeCycle(renewed.state, { leaseId: secondLease }, 121_001)
    expect(staleRenewal.applied).toBe(false)
    expect(staleRenewal.state.leaseExpiresAtMs).toBe(70_000 + scheduledRuntimeLeaseMs)
  })

  it('requires two consecutive recovery cycles before reopening full work', () => {
    const initialFull = acquire(createInitialScheduledRuntimeState(0), 1_000, firstLease)
    const completed = completeScheduledRuntimeCycle(
      initialFull.state,
      { leaseId: firstLease, sourceCommit: firstSourceCommit },
      1_500,
    )
    const full = acquire(completed.state, 1_600, firstLease)
    const failed = failScheduledRuntimeCycle(full.state, {
      leaseId: firstLease,
      operation: 'service_run_timekeeping_automation',
      status: 503,
      timedOut: false,
    }, 2_000)
    const firstRecoveryAt = failed.state.nextProbeAtMs!
    const firstRecoveryLease = acquire(failed.state, firstRecoveryAt, firstLease)
    expect(firstRecoveryLease.result.decision).toBe('run_recovery_probe')

    const firstRecovery = recoverScheduledRuntimeCycle(
      firstRecoveryLease.state,
      { leaseId: firstLease },
      firstRecoveryAt + 1,
    )
    expect(firstRecovery.state).toMatchObject({
      mode: 'recovering',
      recoverySuccesses: 1,
    })

    const premature = acquire(firstRecovery.state, firstRecoveryAt + 2, secondLease)
    expect(premature.result).toMatchObject({ decision: 'skip', reason: 'cooldown' })

    const secondRecoveryAt = firstRecovery.state.nextProbeAtMs!
    const secondRecoveryLease = acquire(firstRecovery.state, secondRecoveryAt, secondLease)
    expect(secondRecoveryLease.result.decision).toBe('run_recovery_probe')
    const recovered = recoverScheduledRuntimeCycle(
      secondRecoveryLease.state,
      { leaseId: secondLease },
      secondRecoveryAt + 1,
    )

    expect(recovered.state).toMatchObject({
      lastFullSuccessAtMs: 1_500,
      lastFullSuccessSourceCommit: firstSourceCommit,
      mode: 'closed',
      nextProbeAtMs: null,
      openedAtMs: null,
      recoverySuccesses: 0,
    })
    expect(recovered.state.lastSuccessAtMs).toBe(secondRecoveryAt + 1)
    expect(acquire(recovered.state, secondRecoveryAt + 2, firstLease).result.decision).toBe('run_full')
  })

  it('advances the full-cycle watermark only after a complete full cycle', () => {
    const initial = createInitialScheduledRuntimeState(0)
    const acquired = acquire(initial, 1_000, firstLease)
    const completed = completeScheduledRuntimeCycle(
      acquired.state,
      { leaseId: firstLease, sourceCommit: secondSourceCommit },
      2_000,
    )

    expect(completed.applied).toBe(true)
    expect(completed.state).toMatchObject({
      lastFullSuccessAtMs: 2_000,
      lastFullSuccessSourceCommit: secondSourceCommit,
      lastSuccessAtMs: 2_000,
    })
  })

  it('retains failure escalation until ten healthy full cycles prevent flapping', () => {
    let state = createInitialScheduledRuntimeState(0)
    let nowMs = 1_000
    let current = acquire(state, nowMs, firstLease)
    state = failScheduledRuntimeCycle(current.state, {
      leaseId: firstLease,
      operation: 'service_run_timekeeping_automation',
      status: 504,
      timedOut: true,
    }, nowMs + 1).state

    for (const leaseId of [firstLease, secondLease]) {
      nowMs = state.nextProbeAtMs!
      current = acquire(state, nowMs, leaseId)
      state = recoverScheduledRuntimeCycle(current.state, { leaseId }, nowMs + 1).state
    }
    expect(state.mode).toBe('closed')
    expect(state.consecutiveFailures).toBe(1)

    for (let healthyCycle = 0; healthyCycle < 10; healthyCycle += 1) {
      nowMs += 2
      const leaseId = `20000000-0000-4000-8000-${String(healthyCycle + 1).padStart(12, '0')}`
      current = acquire(state, nowMs, leaseId)
      state = completeScheduledRuntimeCycle(
        current.state,
        { leaseId, sourceCommit: firstSourceCommit },
        nowMs + 1,
      ).state
      expect(state.consecutiveFailures).toBe(healthyCycle === 9 ? 0 : 1)
    }
    expect(state.healthyCycles).toBe(0)
  })

  it('releases only the current unexpired lease and never exposes its identifier in a snapshot', () => {
    const acquired = acquire(createInitialScheduledRuntimeState(0), 1_000, firstLease)
    const staleRelease = releaseScheduledRuntimeCycle(acquired.state, { leaseId: secondLease }, 1_001)
    expect(staleRelease.applied).toBe(false)

    const snapshot = scheduledRuntimeSnapshot(staleRelease.state, 1_001)
    expect(snapshot.leaseActive).toBe(true)
    expect(snapshot).not.toHaveProperty('activeLeaseId')

    const released = releaseScheduledRuntimeCycle(staleRelease.state, { leaseId: firstLease }, 1_002)
    expect(released.applied).toBe(true)
    expect(scheduledRuntimeSnapshot(released.state, 1_002).leaseActive).toBe(false)
  })
})

type StoredRow = Record<string, number | string | null>

class MemorySqlStorage {
  row: StoredRow | null = null

  exec<Row = unknown>(query: string, ...bindings: unknown[]): { toArray(): Row[] } {
    const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.startsWith('insert into scheduled_runtime_state') && !this.row) {
      this.row = {
        active_lease_id: null,
        consecutive_failures: 0,
        healthy_cycles: 0,
        last_failure_at_ms: null,
        last_failure_operation: null,
        last_failure_status: null,
        last_failure_timed_out: 0,
        last_full_success_at_ms: null,
        last_full_success_source_commit: null,
        last_scheduled_time_ms: null,
        last_success_at_ms: null,
        lease_expires_at_ms: null,
        mode: 'closed',
        next_probe_at_ms: null,
        opened_at_ms: null,
        recovery_successes: 0,
        updated_at_ms: Number(bindings[0]),
      }
    } else if (normalized.startsWith('update scheduled_runtime_state set')) {
      if (!this.row) throw new Error('Missing scheduled runtime row.')
      const [
        mode,
        consecutiveFailures,
        recoverySuccesses,
        healthyCycles,
        openedAtMs,
        nextProbeAtMs,
        activeLeaseId,
        leaseExpiresAtMs,
        lastSuccessAtMs,
        lastFullSuccessAtMs,
        lastFullSuccessSourceCommit,
        lastFailureAtMs,
        lastFailureOperation,
        lastFailureStatus,
        lastFailureTimedOut,
        lastScheduledTimeMs,
        updatedAtMs,
      ] = bindings
      this.row = {
        active_lease_id: activeLeaseId as string | null,
        consecutive_failures: Number(consecutiveFailures),
        healthy_cycles: Number(healthyCycles),
        last_failure_at_ms: lastFailureAtMs as number | null,
        last_failure_operation: lastFailureOperation as string | null,
        last_failure_status: lastFailureStatus as number | null,
        last_failure_timed_out: Number(lastFailureTimedOut),
        last_full_success_at_ms: lastFullSuccessAtMs as number | null,
        last_full_success_source_commit: lastFullSuccessSourceCommit as string | null,
        last_scheduled_time_ms: lastScheduledTimeMs as number | null,
        last_success_at_ms: lastSuccessAtMs as number | null,
        lease_expires_at_ms: leaseExpiresAtMs as number | null,
        mode: String(mode),
        next_probe_at_ms: nextProbeAtMs as number | null,
        opened_at_ms: openedAtMs as number | null,
        recovery_successes: Number(recoverySuccesses),
        updated_at_ms: Number(updatedAtMs),
      }
    }

    return {
      toArray: () => normalized.startsWith('select') && this.row ? [{ ...this.row } as Row] : [],
    }
  }
}

function coordinatorContext(sql: MemorySqlStorage) {
  return {
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    storage: { sql },
  }
}

describe('ScheduledRuntimeCoordinator persistence boundary', () => {
  it('preserves an open circuit across Durable Object instance replacement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(10_000))
    const sql = new MemorySqlStorage()
    const first = new ScheduledRuntimeCoordinator(coordinatorContext(sql) as never, {})
    const permit = await first.acquireCycle({ scheduledTimeMs: 10_000 })
    if (permit.decision === 'skip') throw new Error('Expected a scheduled lease.')

    vi.setSystemTime(new Date(11_000))
    const failure = await first.recordFailure({
      leaseId: permit.leaseId,
      operation: 'service_run_timekeeping_automation',
      status: 504,
      timedOut: true,
    })
    expect(failure.applied).toBe(true)

    const replacement = new ScheduledRuntimeCoordinator(coordinatorContext(sql) as never, {})
    const persisted = await replacement.getSnapshot()
    expect(persisted).toMatchObject({
      consecutiveFailures: 1,
      lastFailureOperation: 'service_run_timekeeping_automation',
      lastFailureStatus: 504,
      lastFailureTimedOut: true,
      mode: 'open',
      nextProbeAtMs: 70_000,
    })

    const contained = await replacement.acquireCycle({ scheduledTimeMs: 12_000 })
    expect(contained).toMatchObject({ decision: 'skip', reason: 'cooldown' })
    vi.useRealTimers()
  })

  it('persists and normalizes the source commit only after a complete full cycle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(20_000))
    const sql = new MemorySqlStorage()
    const first = new ScheduledRuntimeCoordinator(coordinatorContext(sql) as never, {})
    const permit = await first.acquireCycle({ scheduledTimeMs: 20_000 })
    if (permit.decision === 'skip') throw new Error('Expected a scheduled lease.')

    vi.setSystemTime(new Date(21_000))
    const completion = await first.recordFullSuccess({
      leaseId: permit.leaseId,
      sourceCommit: firstSourceCommit.toUpperCase(),
    })
    expect(completion).toMatchObject({
      applied: true,
      state: {
        lastFullSuccessAtMs: 21_000,
        lastFullSuccessSourceCommit: firstSourceCommit,
      },
    })

    const replacement = new ScheduledRuntimeCoordinator(coordinatorContext(sql) as never, {})
    await expect(replacement.getSnapshot()).resolves.toMatchObject({
      lastFullSuccessAtMs: 21_000,
      lastFullSuccessSourceCommit: firstSourceCommit,
    })
    vi.useRealTimers()
  })

  it('rejects malformed source commits without consuming the active lease', async () => {
    const sql = new MemorySqlStorage()
    const coordinator = new ScheduledRuntimeCoordinator(coordinatorContext(sql) as never, {})
    const permit = await coordinator.acquireCycle({ scheduledTimeMs: 30_000 })
    if (permit.decision === 'skip') throw new Error('Expected a scheduled lease.')

    await expect(coordinator.recordFullSuccess({
      leaseId: permit.leaseId,
      sourceCommit: 'invalid',
    })).rejects.toThrow('40-character source commit')
    await expect(coordinator.getSnapshot()).resolves.toMatchObject({
      lastFullSuccessAtMs: null,
      lastFullSuccessSourceCommit: null,
      leaseActive: true,
    })
  })
})

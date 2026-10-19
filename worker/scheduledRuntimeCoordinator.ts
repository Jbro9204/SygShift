import { DurableObject } from 'cloudflare:workers'

export const scheduledRuntimeLeaseMs = 75_000
export const scheduledRuntimeLeaseHeartbeatMs = 15_000
export const scheduledRuntimeRecoverySuccessesRequired = 2
export const scheduledRuntimeHealthyCyclesToResetFailures = 10
export const scheduledRuntimeCooldownsMs = [60_000] as const

export type ScheduledRuntimeMode = 'closed' | 'open' | 'recovering'

export type ScheduledRuntimeSkipReason = 'cooldown' | 'lease_active'

export type ScheduledRuntimeRunDecision = 'run_full' | 'run_recovery_probe'

export interface ScheduledRuntimeState {
  activeLeaseId: string | null
  consecutiveFailures: number
  healthyCycles: number
  lastFailureAtMs: number | null
  lastFailureOperation: string | null
  lastFailureStatus: number | null
  lastFailureTimedOut: boolean
  lastFullSuccessAtMs: number | null
  lastFullSuccessSourceCommit: string | null
  lastScheduledTimeMs: number | null
  lastSuccessAtMs: number | null
  leaseExpiresAtMs: number | null
  mode: ScheduledRuntimeMode
  nextProbeAtMs: number | null
  openedAtMs: number | null
  recoverySuccesses: number
  updatedAtMs: number
}

export interface ScheduledRuntimeSnapshot {
  consecutiveFailures: number
  cooldownRemainingMs: number
  healthyCycles: number
  lastFailureAtMs: number | null
  lastFailureOperation: string | null
  lastFailureStatus: number | null
  lastFailureTimedOut: boolean
  lastFullSuccessAtMs: number | null
  lastFullSuccessSourceCommit: string | null
  lastScheduledTimeMs: number | null
  lastSuccessAtMs: number | null
  leaseActive: boolean
  leaseExpiresAtMs: number | null
  mode: ScheduledRuntimeMode
  nextProbeAtMs: number | null
  openedAtMs: number | null
  recoverySuccesses: number
  updatedAtMs: number
}

export type ScheduledRuntimeAcquireResult = {
  decision: ScheduledRuntimeRunDecision
  leaseExpiresAtMs: number
  leaseId: string
  state: ScheduledRuntimeSnapshot
} | {
  decision: 'skip'
  reason: ScheduledRuntimeSkipReason
  retryAtMs: number
  state: ScheduledRuntimeSnapshot
}

export interface ScheduledRuntimeAcquireInput {
  scheduledTimeMs: number
}

export interface ScheduledRuntimeFailureInput {
  leaseId: string
  operation: string
  status: number | null
  timedOut: boolean
}

export interface ScheduledRuntimeLeaseInput {
  leaseId: string
}

export interface ScheduledRuntimeFullSuccessInput extends ScheduledRuntimeLeaseInput {
  sourceCommit: string
}

export interface ScheduledRuntimeMutationResult {
  applied: boolean
  state: ScheduledRuntimeSnapshot
}

type ScheduledRuntimeStateRow = {
  active_lease_id: string | null
  consecutive_failures: number
  healthy_cycles: number
  last_failure_at_ms: number | null
  last_failure_operation: string | null
  last_failure_status: number | null
  last_failure_timed_out: number
  last_full_success_at_ms: number | null
  last_full_success_source_commit: string | null
  last_scheduled_time_ms: number | null
  last_success_at_ms: number | null
  lease_expires_at_ms: number | null
  mode: ScheduledRuntimeMode
  next_probe_at_ms: number | null
  opened_at_ms: number | null
  recovery_successes: number
  updated_at_ms: number
}

export function createInitialScheduledRuntimeState(nowMs: number): ScheduledRuntimeState {
  return {
    activeLeaseId: null,
    consecutiveFailures: 0,
    healthyCycles: 0,
    lastFailureAtMs: null,
    lastFailureOperation: null,
    lastFailureStatus: null,
    lastFailureTimedOut: false,
    lastFullSuccessAtMs: null,
    lastFullSuccessSourceCommit: null,
    lastScheduledTimeMs: null,
    lastSuccessAtMs: null,
    leaseExpiresAtMs: null,
    mode: 'closed',
    nextProbeAtMs: null,
    openedAtMs: null,
    recoverySuccesses: 0,
    updatedAtMs: nowMs,
  }
}

export function scheduledRuntimeCooldownMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, Math.trunc(consecutiveFailures))
  const index = Math.min(normalizedFailures - 1, scheduledRuntimeCooldownsMs.length - 1)
  return scheduledRuntimeCooldownsMs[index]
}

function nextScheduledRuntimeProbeAtMs(
  state: ScheduledRuntimeState,
  nowMs: number,
  consecutiveFailures: number,
): number {
  const intervalMs = scheduledRuntimeCooldownMs(consecutiveFailures)
  const nextWallClockWindowMs = (Math.floor(nowMs / intervalMs) + 1) * intervalMs
  const nextScheduledWindowMs = state.lastScheduledTimeMs === null
    ? nextWallClockWindowMs
    : state.lastScheduledTimeMs + intervalMs
  return Math.max(nextWallClockWindowMs, nextScheduledWindowMs)
}

export function scheduledRuntimeSnapshot(
  state: ScheduledRuntimeState,
  nowMs: number,
): ScheduledRuntimeSnapshot {
  const leaseActive = Boolean(
    state.activeLeaseId
    && state.leaseExpiresAtMs !== null
    && state.leaseExpiresAtMs > nowMs,
  )
  return {
    consecutiveFailures: state.consecutiveFailures,
    cooldownRemainingMs: state.nextProbeAtMs === null ? 0 : Math.max(0, state.nextProbeAtMs - nowMs),
    healthyCycles: state.healthyCycles,
    lastFailureAtMs: state.lastFailureAtMs,
    lastFailureOperation: state.lastFailureOperation,
    lastFailureStatus: state.lastFailureStatus,
    lastFailureTimedOut: state.lastFailureTimedOut,
    lastFullSuccessAtMs: state.lastFullSuccessAtMs,
    lastFullSuccessSourceCommit: state.lastFullSuccessSourceCommit,
    lastScheduledTimeMs: state.lastScheduledTimeMs,
    lastSuccessAtMs: state.lastSuccessAtMs,
    leaseActive,
    leaseExpiresAtMs: leaseActive ? state.leaseExpiresAtMs : null,
    mode: state.mode,
    nextProbeAtMs: state.nextProbeAtMs,
    openedAtMs: state.openedAtMs,
    recoverySuccesses: state.recoverySuccesses,
    updatedAtMs: state.updatedAtMs,
  }
}

export function acquireScheduledRuntimeCycle(
  state: ScheduledRuntimeState,
  input: ScheduledRuntimeAcquireInput,
  nowMs: number,
  leaseId: string,
): { result: ScheduledRuntimeAcquireResult, state: ScheduledRuntimeState } {
  const current = clearExpiredScheduledRuntimeLease(state, nowMs)
  if (current.activeLeaseId && current.leaseExpiresAtMs !== null) {
    return {
      result: {
        decision: 'skip',
        reason: 'lease_active',
        retryAtMs: current.leaseExpiresAtMs,
        state: scheduledRuntimeSnapshot(current, nowMs),
      },
      state: current,
    }
  }

  if (current.mode !== 'closed' && current.nextProbeAtMs !== null && current.nextProbeAtMs > nowMs) {
    return {
      result: {
        decision: 'skip',
        reason: 'cooldown',
        retryAtMs: current.nextProbeAtMs,
        state: scheduledRuntimeSnapshot(current, nowMs),
      },
      state: current,
    }
  }

  const leaseExpiresAtMs = nowMs + scheduledRuntimeLeaseMs
  const nextState: ScheduledRuntimeState = {
    ...current,
    activeLeaseId: leaseId,
    lastScheduledTimeMs: input.scheduledTimeMs,
    leaseExpiresAtMs,
    updatedAtMs: nowMs,
  }
  const decision: ScheduledRuntimeRunDecision = current.mode === 'closed'
    ? 'run_full'
    : 'run_recovery_probe'

  return {
    result: {
      decision,
      leaseExpiresAtMs,
      leaseId,
      state: scheduledRuntimeSnapshot(nextState, nowMs),
    },
    state: nextState,
  }
}

export function failScheduledRuntimeCycle(
  state: ScheduledRuntimeState,
  input: ScheduledRuntimeFailureInput,
  nowMs: number,
): { applied: boolean, state: ScheduledRuntimeState } {
  if (!matchingActiveLease(state, input.leaseId, nowMs)) return { applied: false, state }

  const consecutiveFailures = Math.min(state.consecutiveFailures + 1, Number.MAX_SAFE_INTEGER)
  return {
    applied: true,
    state: {
      ...state,
      activeLeaseId: null,
      consecutiveFailures,
      healthyCycles: 0,
      lastFailureAtMs: nowMs,
      lastFailureOperation: input.operation,
      lastFailureStatus: input.status,
      lastFailureTimedOut: input.timedOut,
      leaseExpiresAtMs: null,
      mode: 'open',
      nextProbeAtMs: nextScheduledRuntimeProbeAtMs(state, nowMs, consecutiveFailures),
      openedAtMs: state.openedAtMs ?? nowMs,
      recoverySuccesses: 0,
      updatedAtMs: nowMs,
    },
  }
}

export function recoverScheduledRuntimeCycle(
  state: ScheduledRuntimeState,
  input: ScheduledRuntimeLeaseInput,
  nowMs: number,
): { applied: boolean, state: ScheduledRuntimeState } {
  if (!matchingActiveLease(state, input.leaseId, nowMs) || state.mode === 'closed') {
    return { applied: false, state }
  }

  const recoverySuccesses = state.recoverySuccesses + 1
  const recovered = recoverySuccesses >= scheduledRuntimeRecoverySuccessesRequired
  return {
    applied: true,
    state: {
      ...state,
      activeLeaseId: null,
      healthyCycles: 0,
      lastSuccessAtMs: nowMs,
      leaseExpiresAtMs: null,
      mode: recovered ? 'closed' : 'recovering',
      nextProbeAtMs: recovered ? null : nextScheduledRuntimeProbeAtMs(state, nowMs, state.consecutiveFailures),
      openedAtMs: recovered ? null : state.openedAtMs,
      recoverySuccesses: recovered ? 0 : recoverySuccesses,
      updatedAtMs: nowMs,
    },
  }
}

export function completeScheduledRuntimeCycle(
  state: ScheduledRuntimeState,
  input: ScheduledRuntimeFullSuccessInput,
  nowMs: number,
): { applied: boolean, state: ScheduledRuntimeState } {
  if (!matchingActiveLease(state, input.leaseId, nowMs) || state.mode !== 'closed') {
    return { applied: false, state }
  }

  const healthyCycles = state.healthyCycles + 1
  const resetEscalation = healthyCycles >= scheduledRuntimeHealthyCyclesToResetFailures
  return {
    applied: true,
    state: {
      ...state,
      activeLeaseId: null,
      consecutiveFailures: resetEscalation ? 0 : state.consecutiveFailures,
      healthyCycles: resetEscalation ? 0 : healthyCycles,
      lastFullSuccessAtMs: nowMs,
      lastFullSuccessSourceCommit: input.sourceCommit,
      lastSuccessAtMs: nowMs,
      leaseExpiresAtMs: null,
      updatedAtMs: nowMs,
    },
  }
}

export function releaseScheduledRuntimeCycle(
  state: ScheduledRuntimeState,
  input: ScheduledRuntimeLeaseInput,
  nowMs: number,
): { applied: boolean, state: ScheduledRuntimeState } {
  if (!matchingActiveLease(state, input.leaseId, nowMs)) return { applied: false, state }
  return {
    applied: true,
    state: {
      ...state,
      activeLeaseId: null,
      leaseExpiresAtMs: null,
      updatedAtMs: nowMs,
    },
  }
}

export function renewScheduledRuntimeCycle(
  state: ScheduledRuntimeState,
  input: ScheduledRuntimeLeaseInput,
  nowMs: number,
): { applied: boolean, state: ScheduledRuntimeState } {
  if (!matchingActiveLease(state, input.leaseId, nowMs)) return { applied: false, state }
  return {
    applied: true,
    state: {
      ...state,
      leaseExpiresAtMs: nowMs + scheduledRuntimeLeaseMs,
      updatedAtMs: nowMs,
    },
  }
}

function clearExpiredScheduledRuntimeLease(
  state: ScheduledRuntimeState,
  nowMs: number,
): ScheduledRuntimeState {
  if (!state.activeLeaseId || state.leaseExpiresAtMs === null || state.leaseExpiresAtMs > nowMs) return state
  return {
    ...state,
    activeLeaseId: null,
    leaseExpiresAtMs: null,
    updatedAtMs: nowMs,
  }
}

function matchingActiveLease(state: ScheduledRuntimeState, leaseId: string, nowMs: number): boolean {
  return Boolean(
    leaseId
    && state.activeLeaseId === leaseId
    && state.leaseExpiresAtMs !== null
    && state.leaseExpiresAtMs > nowMs,
  )
}

function stateFromRow(row: ScheduledRuntimeStateRow): ScheduledRuntimeState {
  return {
    activeLeaseId: row.active_lease_id,
    consecutiveFailures: row.consecutive_failures,
    healthyCycles: row.healthy_cycles,
    lastFailureAtMs: row.last_failure_at_ms,
    lastFailureOperation: row.last_failure_operation,
    lastFailureStatus: row.last_failure_status,
    lastFailureTimedOut: row.last_failure_timed_out === 1,
    lastFullSuccessAtMs: row.last_full_success_at_ms,
    lastFullSuccessSourceCommit: storedSourceCommit(row.last_full_success_source_commit),
    lastScheduledTimeMs: row.last_scheduled_time_ms,
    lastSuccessAtMs: row.last_success_at_ms,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    mode: row.mode,
    nextProbeAtMs: row.next_probe_at_ms,
    openedAtMs: row.opened_at_ms,
    recoverySuccesses: row.recovery_successes,
    updatedAtMs: row.updated_at_ms,
  }
}

function validScheduledTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validLeaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function sanitizedOperation(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160) throw new Error('A valid scheduled operation is required.')
  return normalized
}

function sanitizedSourceCommit(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('A valid 40-character source commit is required.')
  }
  return normalized
}

function storedSourceCommit(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null
}

export class ScheduledRuntimeCoordinator extends DurableObject<unknown> {
  private readonly initialization: Promise<void>

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    this.initialization = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        create table if not exists scheduled_runtime_state (
          id integer primary key check (id = 1),
          mode text not null check (mode in ('closed', 'open', 'recovering')),
          consecutive_failures integer not null check (consecutive_failures >= 0),
          recovery_successes integer not null check (recovery_successes >= 0),
          healthy_cycles integer not null check (healthy_cycles >= 0),
          opened_at_ms integer,
          next_probe_at_ms integer,
          active_lease_id text,
          lease_expires_at_ms integer,
          last_success_at_ms integer,
          last_full_success_at_ms integer,
          last_full_success_source_commit text,
          last_failure_at_ms integer,
          last_failure_operation text,
          last_failure_status integer,
          last_failure_timed_out integer not null check (last_failure_timed_out in (0, 1)),
          last_scheduled_time_ms integer,
          updated_at_ms integer not null
        );
      `)
      const columns = new Set(
        this.ctx.storage.sql.exec<{ name: string }>('pragma table_info(scheduled_runtime_state)')
          .toArray()
          .map((column) => column.name),
      )
      if (!columns.has('last_full_success_at_ms')) {
        this.ctx.storage.sql.exec('alter table scheduled_runtime_state add column last_full_success_at_ms integer')
      }
      if (!columns.has('last_full_success_source_commit')) {
        this.ctx.storage.sql.exec('alter table scheduled_runtime_state add column last_full_success_source_commit text')
      }
      const nowMs = Date.now()
      this.ctx.storage.sql.exec(`
        insert into scheduled_runtime_state (
          id, mode, consecutive_failures, recovery_successes, healthy_cycles,
          opened_at_ms, next_probe_at_ms, active_lease_id, lease_expires_at_ms,
          last_success_at_ms, last_full_success_at_ms, last_full_success_source_commit,
          last_failure_at_ms, last_failure_operation,
          last_failure_status, last_failure_timed_out, last_scheduled_time_ms, updated_at_ms
        ) values (1, 'closed', 0, 0, 0, null, null, null, null, null, null, null, null, null, null, 0, null, ?)
        on conflict (id) do nothing
      `, nowMs)
    })
  }

  async acquireCycle(input: ScheduledRuntimeAcquireInput): Promise<ScheduledRuntimeAcquireResult> {
    await this.initialization
    if (!validScheduledTime(input.scheduledTimeMs)) throw new Error('A valid scheduled time is required.')
    const nowMs = Date.now()
    const transition = acquireScheduledRuntimeCycle(
      this.readState(),
      input,
      nowMs,
      crypto.randomUUID(),
    )
    this.writeState(transition.state)
    return transition.result
  }

  async recordFailure(input: ScheduledRuntimeFailureInput): Promise<ScheduledRuntimeMutationResult> {
    await this.initialization
    if (!validLeaseId(input.leaseId)) throw new Error('A valid scheduled lease is required.')
    if (input.status !== null && (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)) {
      throw new Error('A valid upstream status is required.')
    }
    const transition = failScheduledRuntimeCycle(this.readState(), {
      ...input,
      operation: sanitizedOperation(input.operation),
    }, Date.now())
    if (transition.applied) this.writeState(transition.state)
    return {
      applied: transition.applied,
      state: scheduledRuntimeSnapshot(transition.state, Date.now()),
    }
  }

  async recordRecoverySuccess(input: ScheduledRuntimeLeaseInput): Promise<ScheduledRuntimeMutationResult> {
    await this.initialization
    if (!validLeaseId(input.leaseId)) throw new Error('A valid scheduled lease is required.')
    return this.applyLeaseMutation(input, recoverScheduledRuntimeCycle)
  }

  async recordFullSuccess(input: ScheduledRuntimeFullSuccessInput): Promise<ScheduledRuntimeMutationResult> {
    await this.initialization
    if (!validLeaseId(input.leaseId)) throw new Error('A valid scheduled lease is required.')
    return this.applyLeaseMutation({
      ...input,
      sourceCommit: sanitizedSourceCommit(input.sourceCommit),
    }, completeScheduledRuntimeCycle)
  }

  async releaseCycle(input: ScheduledRuntimeLeaseInput): Promise<ScheduledRuntimeMutationResult> {
    await this.initialization
    if (!validLeaseId(input.leaseId)) throw new Error('A valid scheduled lease is required.')
    return this.applyLeaseMutation(input, releaseScheduledRuntimeCycle)
  }

  async renewCycle(input: ScheduledRuntimeLeaseInput): Promise<ScheduledRuntimeMutationResult> {
    await this.initialization
    if (!validLeaseId(input.leaseId)) throw new Error('A valid scheduled lease is required.')
    return this.applyLeaseMutation(input, renewScheduledRuntimeCycle)
  }

  async getSnapshot(): Promise<ScheduledRuntimeSnapshot> {
    await this.initialization
    return scheduledRuntimeSnapshot(this.readState(), Date.now())
  }

  private applyLeaseMutation<Input extends ScheduledRuntimeLeaseInput>(
    input: Input,
    transition: (
      state: ScheduledRuntimeState,
      lease: Input,
      nowMs: number,
    ) => { applied: boolean, state: ScheduledRuntimeState },
  ): ScheduledRuntimeMutationResult {
    const nowMs = Date.now()
    const result = transition(this.readState(), input, nowMs)
    if (result.applied) this.writeState(result.state)
    return {
      applied: result.applied,
      state: scheduledRuntimeSnapshot(result.state, nowMs),
    }
  }

  private readState(): ScheduledRuntimeState {
    const [row] = this.ctx.storage.sql.exec<ScheduledRuntimeStateRow>(`
      select
        active_lease_id,
        consecutive_failures,
        healthy_cycles,
        last_failure_at_ms,
        last_failure_operation,
        last_failure_status,
        last_failure_timed_out,
        last_full_success_at_ms,
        last_full_success_source_commit,
        last_scheduled_time_ms,
        last_success_at_ms,
        lease_expires_at_ms,
        mode,
        next_probe_at_ms,
        opened_at_ms,
        recovery_successes,
        updated_at_ms
      from scheduled_runtime_state
      where id = 1
    `).toArray()
    if (!row) throw new Error('The scheduled runtime state is unavailable.')
    return stateFromRow(row)
  }

  private writeState(state: ScheduledRuntimeState): void {
    this.ctx.storage.sql.exec(`
      update scheduled_runtime_state set
        mode = ?,
        consecutive_failures = ?,
        recovery_successes = ?,
        healthy_cycles = ?,
        opened_at_ms = ?,
        next_probe_at_ms = ?,
        active_lease_id = ?,
        lease_expires_at_ms = ?,
        last_success_at_ms = ?,
        last_full_success_at_ms = ?,
        last_full_success_source_commit = ?,
        last_failure_at_ms = ?,
        last_failure_operation = ?,
        last_failure_status = ?,
        last_failure_timed_out = ?,
        last_scheduled_time_ms = ?,
        updated_at_ms = ?
      where id = 1
    `,
    state.mode,
    state.consecutiveFailures,
    state.recoverySuccesses,
    state.healthyCycles,
    state.openedAtMs,
    state.nextProbeAtMs,
    state.activeLeaseId,
    state.leaseExpiresAtMs,
    state.lastSuccessAtMs,
    state.lastFullSuccessAtMs,
    state.lastFullSuccessSourceCommit,
    state.lastFailureAtMs,
    state.lastFailureOperation,
    state.lastFailureStatus,
    state.lastFailureTimedOut ? 1 : 0,
    state.lastScheduledTimeMs,
    state.updatedAtMs)
  }
}

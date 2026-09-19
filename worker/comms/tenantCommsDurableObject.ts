import { DurableObject } from 'cloudflare:workers'
import {
  authorizeCoordinatorCommand,
  coordinatorRuntimeMayDispatch,
  type AuthorizedCoordinatorCommand,
} from './tenantCoordinatorCore'
import {
  closedSygSphereCommsProviderRegistry,
  closedProviderOutcome,
} from './providerRegistry'

type CoordinatorLedgerRow = {
  command_id: string
  result_json: string
}

type CoordinatorRateWindowRow = {
  request_count: number
}

type CoordinatorCommandRow = {
  command_id: string
}

type CoordinatorEnvironment = Env & Readonly<{
  SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED?: string
}>

export type TenantCommsCoordinatorResult = Readonly<{
  outcome: 'runtime_disabled' | 'rate_limited' | 'provider_unavailable'
  requestId: string
}>

const commandRateWindowMilliseconds = 10_000
const maximumCommandsPerWindow = 8
const rateWindowRetentionMilliseconds = 60_000
const commandReplayRetentionMilliseconds = 86_400_000
const maximumRecordsPurgedPerDispatch = 50

const runtimeEnabled = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'true'

const replayKey = (command: AuthorizedCoordinatorCommand): string =>
  `${command.authorization.tenantId}:${command.authorization.authUserId}:${command.command.commandId}`

const parseStoredCoordinatorResult = (value: string): TenantCommsCoordinatorResult | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as { outcome?: unknown }).outcome === 'string'
      && ['runtime_disabled', 'rate_limited', 'provider_unavailable'].includes((parsed as { outcome: string }).outcome)
      && typeof (parsed as { requestId?: unknown }).requestId === 'string'
    ) {
      return parsed as TenantCommsCoordinatorResult
    }
  } catch {
    // The ledger has no user-controlled JSON. A malformed stored row remains
    // unavailable rather than allowing an ambiguous replay result.
  }
  return null
}

/**
 * One SQLite-backed coordinator exists per server-derived tenant name. It has
 * no public fetch handler; a later protected Worker route may call this RPC
 * only after database authorization and all release evidence are present.
 */
export class TenantCommsDurableObject extends DurableObject<CoordinatorEnvironment> {
  private readonly initialization: Promise<void>

  constructor(ctx: DurableObjectState, env: CoordinatorEnvironment) {
    super(ctx, env)
    this.initialization = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        create table if not exists coordinator_commands (
          command_id text primary key,
          result_json text not null,
          created_at_ms integer not null
        );
        create table if not exists coordinator_rate_windows (
          rate_key text not null,
          window_started_at_ms integer not null,
          request_count integer not null check (request_count >= 0),
          primary key (rate_key, window_started_at_ms)
        );
        create index if not exists coordinator_commands_created_at_idx
          on coordinator_commands (created_at_ms);
        create index if not exists coordinator_rate_windows_started_at_idx
          on coordinator_rate_windows (window_started_at_ms);
      `)
    })
  }

  private purgeExpiredState(now: number): void {
    const expiredCommandIds = this.ctx.storage.sql
      .exec<CoordinatorCommandRow>(
        'select command_id from coordinator_commands where created_at_ms < ? order by created_at_ms asc limit ?',
        now - commandReplayRetentionMilliseconds,
        maximumRecordsPurgedPerDispatch,
      )
      .toArray()
    for (const expired of expiredCommandIds) {
      this.ctx.storage.sql.exec('delete from coordinator_commands where command_id = ?', expired.command_id)
    }

    const expiredRateWindows = this.ctx.storage.sql
      .exec<CoordinatorRateWindowRow & { rate_key: string, window_started_at_ms: number }>(
        'select rate_key, window_started_at_ms, request_count from coordinator_rate_windows where window_started_at_ms < ? order by window_started_at_ms asc limit ?',
        now - rateWindowRetentionMilliseconds,
        maximumRecordsPurgedPerDispatch,
      )
      .toArray()
    for (const expired of expiredRateWindows) {
      this.ctx.storage.sql.exec(
        'delete from coordinator_rate_windows where rate_key = ? and window_started_at_ms = ?',
        expired.rate_key,
        expired.window_started_at_ms,
      )
    }
  }

  async dispatch(input: unknown): Promise<TenantCommsCoordinatorResult> {
    await this.initialization
    const authorized = authorizeCoordinatorCommand(input)

    if (!runtimeEnabled(this.env.SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED) || !coordinatorRuntimeMayDispatch(authorized.release)) {
      return { outcome: 'runtime_disabled', requestId: authorized.requestId }
    }

    const commandId = replayKey(authorized)
    const previous = this.ctx.storage.sql
      .exec<CoordinatorLedgerRow>('select command_id, result_json from coordinator_commands where command_id = ? limit 1', commandId)
      .toArray()[0]
    if (previous) {
      const storedResult = parseStoredCoordinatorResult(previous.result_json)
      if (storedResult) return storedResult
      throw new Error('The communications command replay record is invalid.')
    }

    const now = Date.now()
    this.purgeExpiredState(now)
    const windowStartedAt = Math.floor(now / commandRateWindowMilliseconds) * commandRateWindowMilliseconds
    const rateKey = `${authorized.authorization.tenantId}:${authorized.authorization.employeeId}:${authorized.command.kind}`
    this.ctx.storage.sql.exec(
      `insert into coordinator_rate_windows (rate_key, window_started_at_ms, request_count)
       values (?, ?, 1)
       on conflict (rate_key, window_started_at_ms)
       do update set request_count = request_count + 1`,
      rateKey,
      windowStartedAt,
    )
    const rate = this.ctx.storage.sql
      .exec<CoordinatorRateWindowRow>(
        'select request_count from coordinator_rate_windows where rate_key = ? and window_started_at_ms = ? limit 1',
        rateKey,
        windowStartedAt,
      )
      .toArray()[0]
    if (!rate || rate.request_count > maximumCommandsPerWindow) {
      return { outcome: 'rate_limited', requestId: authorized.requestId }
    }

    const result: TenantCommsCoordinatorResult = {
      outcome: closedProviderOutcome(closedSygSphereCommsProviderRegistry),
      requestId: authorized.requestId,
    }
    this.ctx.storage.sql.exec(
      'insert into coordinator_commands (command_id, result_json, created_at_ms) values (?, ?, ?)',
      commandId,
      JSON.stringify(result),
      now,
    )
    return result
  }
}

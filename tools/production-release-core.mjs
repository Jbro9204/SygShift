import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const gitShaPattern = /^[0-9a-f]{40}$/i
const safeTagPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const sourceTagPattern = /^source-([0-9a-f]{40})$/i
const productionProject = 'eqkdfrbwtioiqtjsyglg'
const coordinatedMaintenanceFeatures = Object.freeze([
  'availability',
  'communications',
  'directory',
  'events_openings',
  'licensing',
  'patrol',
  'payroll',
  'requests',
  'roles_permissions',
  'schedule',
  'sites_posts',
  'time_attendance',
  'training',
  'user_accounts',
])
const readinessConfigurationChecks = Object.freeze([
  'assetsBinding',
  'scheduledRuntimeCoordinator',
  'scheduledRuntimeSourceCommit',
  'sharedIdentityConsumerSecret',
  'sharedIdentitySessionSecret',
  'supabasePublishableKey',
  'supabaseServiceRoleKey',
  'supabaseUrl',
  'sygilantSharedIdentityConsumerSecret',
  'sygilantSharedIdentityKeySeparation',
  'sygilantSharedIdentitySigningSecret',
])

export const releaseOutcomes = Object.freeze({
  badCandidate: 'bad_candidate',
  badRelease: 'bad_release',
  dryRun: 'dry_run',
  manualIntervention: 'manual_intervention',
  providerOutage: 'provider_outage',
  promotionNotApplied: 'promotion_not_applied',
  released: 'released',
})

export class CommandTerminationUnconfirmedError extends Error {
  constructor() {
    super(
      'The release command timed out, and Windows process-tree termination could not be confirmed; '
      + 'manual release intervention is required.',
    )
    this.code = 'SYGSHIFT_RELEASE_TERMINATION_UNCONFIRMED'
    this.name = 'CommandTerminationUnconfirmedError'
  }
}

function isCommandTerminationUnconfirmedError(error) {
  return error instanceof CommandTerminationUnconfirmedError
    || error?.code === 'SYGSHIFT_RELEASE_TERMINATION_UNCONFIRMED'
}

function abortAfter(milliseconds) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), milliseconds)
  return { controller, dispose: () => clearTimeout(timeout) }
}

function normalizedOrigin(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be a valid HTTPS origin.`)
  }
  return url.origin
}

function publicFailure(error) {
  if (error instanceof DOMException && error.name === 'AbortError') return 'request_timeout'
  if (error instanceof TypeError) return 'network_unavailable'
  return 'request_failed'
}

async function requestStatus(fetchImplementation, url, init, acceptedStatuses, timeoutMs) {
  const timeout = abortAfter(timeoutMs)
  try {
    const response = await fetchImplementation(url, { ...init, redirect: 'error', signal: timeout.controller.signal })
    return {
      ok: acceptedStatuses.includes(response.status),
      status: response.status,
    }
  } catch (error) {
    return { error: publicFailure(error), ok: false, status: null }
  } finally {
    timeout.dispose()
  }
}

async function requestJson(fetchImplementation, url, init, acceptedStatuses, timeoutMs) {
  const timeout = abortAfter(timeoutMs)
  try {
    const response = await fetchImplementation(url, { ...init, redirect: 'error', signal: timeout.controller.signal })
    if (!acceptedStatuses.includes(response.status)) return { ok: false, status: response.status, value: null }
    let value
    try {
      value = await response.json()
    } catch {
      return { error: 'invalid_json', ok: false, status: response.status, value: null }
    }
    return { ok: true, status: response.status, value }
  } catch (error) {
    return { error: publicFailure(error), ok: false, status: null, value: null }
  } finally {
    timeout.dispose()
  }
}

async function requestHtml(fetchImplementation, url, timeoutMs) {
  const timeout = abortAfter(timeoutMs)
  try {
    const response = await fetchImplementation(url, {
      headers: { accept: 'text/html' },
      method: 'GET',
      redirect: 'error',
      signal: timeout.controller.signal,
    })
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (response.status !== 200 || !contentType.includes('text/html')) {
      return { error: 'unexpected_html_response', ok: false, status: response.status }
    }
    const body = await response.text()
    const isApplicationShell = /<!doctype\s+html/i.test(body)
      && /<html(?:\s|>)/i.test(body)
      && /id=["']root["']/i.test(body)
    return {
      error: isApplicationShell ? undefined : 'unexpected_html_response',
      ok: isApplicationShell,
      status: response.status,
    }
  } catch (error) {
    return { error: publicFailure(error), ok: false, status: null }
  } finally {
    timeout.dispose()
  }
}

function headersForSupabase(publishableKey, accessToken) {
  return {
    apikey: publishableKey,
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  }
}

async function signInCanary(fetchImplementation, config) {
  const result = await requestJson(
    fetchImplementation,
    `${config.supabaseOrigin}/auth/v1/token?grant_type=password`,
    {
      body: JSON.stringify({ email: config.canaryEmail, password: config.canaryPassword }),
      headers: {
        ...headersForSupabase(config.publishableKey),
        'content-type': 'application/json',
      },
      method: 'POST',
    },
    [200],
    config.timeoutMs,
  )
  const payload = result.value && typeof result.value === 'object' ? result.value : null
  const accessToken = payload && typeof payload.access_token === 'string' ? payload.access_token : ''
  return { ...result, accessToken }
}

async function signOutCanary(fetchImplementation, config, accessToken) {
  if (!accessToken) return
  await requestStatus(
    fetchImplementation,
    `${config.supabaseOrigin}/auth/v1/logout?scope=local`,
    {
      headers: headersForSupabase(config.publishableKey, accessToken),
      method: 'POST',
    },
    [204],
    config.timeoutMs,
  )
}

async function probeCanarySession(fetchImplementation, config) {
  if (!config.canaryEmail || !config.canaryPassword) {
    if (!config.allowBoundaryProbe) return { error: 'canary_not_configured', ok: false, status: null }
    const boundary = await requestStatus(
      fetchImplementation,
      `${config.supabaseOrigin}/rest/v1/rpc/get_session_context`,
      {
        body: '{}',
        headers: {
          ...headersForSupabase(config.publishableKey),
          'content-type': 'application/json',
        },
        method: 'POST',
      },
      [401, 403],
      config.timeoutMs,
    )
    return { ...boundary, mode: 'unauthenticated_boundary' }
  }

  const signIn = await signInCanary(fetchImplementation, config)
  if (!signIn.ok || !signIn.accessToken) {
    return { error: signIn.error ?? 'canary_sign_in_failed', ok: false, status: signIn.status }
  }

  try {
    const session = await requestJson(
      fetchImplementation,
      `${config.supabaseOrigin}/rest/v1/rpc/get_session_context`,
      {
        body: '{}',
        headers: {
          ...headersForSupabase(config.publishableKey, signIn.accessToken),
          'content-type': 'application/json',
        },
        method: 'POST',
      },
      [200],
      config.timeoutMs,
    )
    const sessionPayload = Array.isArray(session.value) ? session.value[0] : session.value
    const username = sessionPayload && typeof sessionPayload === 'object' && typeof sessionPayload.username === 'string'
      ? sessionPayload.username
      : ''
    if (!session.ok || !username) return { error: session.error ?? 'invalid_session_context', ok: false, status: session.status }
    if (config.expectedCanaryUsername && username.toLowerCase() !== config.expectedCanaryUsername.toLowerCase()) {
      return { error: 'unexpected_canary_identity', ok: false, status: session.status }
    }

    const checkpoint = await requestStatus(
      fetchImplementation,
      `${config.supabaseOrigin}/rest/v1/rpc/get_required_action_checkpoint`,
      {
        body: '{}',
        headers: {
          ...headersForSupabase(config.publishableKey, signIn.accessToken),
          'content-type': 'application/json',
        },
        method: 'POST',
      },
      [200],
      config.timeoutMs,
    )
    return checkpoint.ok
      ? { mode: 'authenticated_canary', ok: true, status: checkpoint.status }
      : { error: checkpoint.error ?? 'checkpoint_failed', mode: 'authenticated_canary', ok: false, status: checkpoint.status }
  } finally {
    await signOutCanary(fetchImplementation, config, signIn.accessToken)
  }
}

export async function probeUpstream(config, dependencies = {}) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const supabaseOrigin = normalizedOrigin(config.supabaseOrigin, 'Supabase URL')
  const probeConfig = {
    ...config,
    supabaseOrigin,
    timeoutMs: config.timeoutMs ?? 8_000,
  }
  if (!probeConfig.publishableKey) throw new Error('A Supabase publishable key is required for release probes.')

  const auth = await requestStatus(
    fetchImplementation,
    `${supabaseOrigin}/auth/v1/health`,
    { headers: headersForSupabase(probeConfig.publishableKey), method: 'GET' },
    [200],
    probeConfig.timeoutMs,
  )
  const storage = await requestStatus(
    fetchImplementation,
    `${supabaseOrigin}/storage/v1/status`,
    { headers: headersForSupabase(probeConfig.publishableKey), method: 'GET' },
    [200],
    probeConfig.timeoutMs,
  )
  const secureAccess = await probeCanarySession(fetchImplementation, probeConfig)
  return {
    auth,
    ok: auth.ok && storage.ok && secureAccess.ok,
    secureAccess,
    storage,
  }
}

export async function probeWorker(origin, dependencies = {}, timeoutMs = 8_000, requirements = {}) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const workerOrigin = normalizedOrigin(origin, 'Worker origin')
  const [health, readiness, root] = await Promise.all([
    requestJson(
      fetchImplementation,
      `${workerOrigin}/api/v1/health`,
      { method: 'GET' },
      [200],
      timeoutMs,
    ),
    requestJson(
      fetchImplementation,
      `${workerOrigin}/api/v1/ready`,
      { method: 'GET' },
      [200],
      timeoutMs,
    ),
    requestHtml(fetchImplementation, `${workerOrigin}/`, timeoutMs),
  ])
  const healthPayload = health.value && typeof health.value === 'object' ? health.value : null
  const readinessPayload = readiness.value && typeof readiness.value === 'object' ? readiness.value : null
  const validHealth = health.ok && healthPayload?.status === 'ok'
  const lastScheduledSuccessAt = typeof readinessPayload?.scheduledRuntime?.lastSuccessAt === 'string'
    ? readinessPayload.scheduledRuntime.lastSuccessAt
    : null
  const lastFullSuccessAt = typeof readinessPayload?.scheduledRuntime?.lastFullSuccessAt === 'string'
    ? readinessPayload.scheduledRuntime.lastFullSuccessAt
    : null
  const lastFullSuccessSourceCommit = typeof readinessPayload?.scheduledRuntime?.lastFullSuccessSourceCommit === 'string'
    ? readinessPayload.scheduledRuntime.lastFullSuccessSourceCommit.toLowerCase()
    : null
  const consecutiveFailures = readinessPayload?.scheduledRuntime?.consecutiveFailures
  const lastFullSuccessAtMs = lastFullSuccessAt ? Date.parse(lastFullSuccessAt) : Number.NaN
  const requiresFullSuccessProof = Object.hasOwn(requirements, 'requiredFullSuccessAfter')
    || Object.hasOwn(requirements, 'requiredSourceCommit')
  const requiredFullSuccessAfter = requirements.requiredFullSuccessAfter
  const previousFullSuccessAtMs = typeof requiredFullSuccessAfter === 'string'
    ? Date.parse(requiredFullSuccessAfter)
    : Number.NaN
  const requiredSourceCommit = typeof requirements.requiredSourceCommit === 'string'
    ? requirements.requiredSourceCommit.toLowerCase()
    : null
  const fullSuccessProven = !requiresFullSuccessProof
    || (Number.isFinite(lastFullSuccessAtMs)
      && (Number.isFinite(previousFullSuccessAtMs)
        ? lastFullSuccessAtMs > previousFullSuccessAtMs
        : lastFullSuccessAt !== requiredFullSuccessAfter)
      && lastFullSuccessSourceCommit === requiredSourceCommit
      && readinessPayload?.checks?.scheduledRuntimeFresh === true)
  const zeroFailuresProven = requirements.requireZeroConsecutiveFailures !== true
    || consecutiveFailures === 0
  const strictReadinessProven = requirements.requireStrictReadiness !== true
    || (readinessPayload?.status === 'ready'
      && readinessPayload?.scheduledRuntime?.mode === 'closed'
      && readinessPayload?.checks?.scheduledRuntimeFresh === true
      && readinessPayload?.checks?.scheduledRuntimeNoFailures === true
      && readinessConfigurationChecks.every((name) => readinessPayload?.checks?.[name] === true)
      && Object.values(readinessPayload?.checks ?? {}).every((value) => value === true))
  const validReadiness = readiness.ok
    && readinessPayload?.ready === true
    && fullSuccessProven
    && zeroFailuresProven
    && strictReadinessProven
  const deliveryOk = validHealth && root.ok
  return {
    delivery: { ok: deliveryOk },
    health: { error: health.error, ok: validHealth, status: health.status },
    ok: deliveryOk && validReadiness,
    readiness: {
      error: readiness.error,
      lastFullSuccessAt,
      lastFullSuccessSourceCommit,
      lastScheduledSuccessAt,
      ok: validReadiness,
      scheduledSuccessSatisfied: fullSuccessProven,
      status: readiness.status,
    },
    root,
  }
}

function candidateReadinessIsConfigured(
  payload,
  expectedSourceCommit,
  allowMaintenanceDegradation = false,
  expectedPriorSourceCommit = null,
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const checks = payload.checks
  const scheduledRuntime = payload.scheduledRuntime
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return false
  if (!scheduledRuntime || typeof scheduledRuntime !== 'object' || Array.isArray(scheduledRuntime)) return false
  if (!['closed', 'open', 'recovering'].includes(scheduledRuntime.mode)) return false
  if (typeof checks.scheduledRuntimeFresh !== 'boolean') return false
  if (allowMaintenanceDegradation && typeof checks.scheduledRuntimeNoFailures !== 'boolean') return false
  if (allowMaintenanceDegradation
    && (!Number.isInteger(scheduledRuntime.consecutiveFailures)
      || scheduledRuntime.consecutiveFailures < 0
      || checks.scheduledRuntimeNoFailures !== (scheduledRuntime.consecutiveFailures === 0))) return false
  if (!readinessConfigurationChecks.every((name) => checks[name] === true)) return false
  const allowedFalseChecks = allowMaintenanceDegradation
    ? new Set(['scheduledRuntimeFresh', 'scheduledRuntimeNoFailures'])
    : new Set(['scheduledRuntimeFresh'])
  if (Object.entries(checks).some(([name, value]) => !allowedFalseChecks.has(name) && value !== true)) return false
  if (allowMaintenanceDegradation
    && (typeof scheduledRuntime.lastFullSuccessAt !== 'string'
      || !Number.isFinite(Date.parse(scheduledRuntime.lastFullSuccessAt)))) return false
  const recordedSourceCommit = scheduledRuntime.lastFullSuccessSourceCommit
  if (recordedSourceCommit !== null
    && (typeof recordedSourceCommit !== 'string' || !gitShaPattern.test(recordedSourceCommit))) return false
  const normalizedRecordedSourceCommit = typeof recordedSourceCommit === 'string'
    ? recordedSourceCommit.toLowerCase()
    : null
  if (payload.ready === true) {
    return payload.status === 'ready'
      && checks.scheduledRuntimeFresh === true
      && (!allowMaintenanceDegradation || checks.scheduledRuntimeNoFailures === true)
      && scheduledRuntime.mode === 'closed'
      && normalizedRecordedSourceCommit === expectedSourceCommit
  }
  return payload.ready === false
    && payload.status === 'degraded'
    && checks.scheduledRuntimeFresh === false
    && (allowMaintenanceDegradation || scheduledRuntime.mode === 'closed')
    && (allowMaintenanceDegradation
      ? normalizedRecordedSourceCommit === expectedPriorSourceCommit
      : normalizedRecordedSourceCommit !== expectedSourceCommit)
}

export async function probeCandidateWorker(
  origin,
  expectedSourceCommit,
  dependencies = {},
  timeoutMs = 8_000,
  allowMaintenanceDegradation = false,
  expectedPriorSourceCommit = null,
) {
  const normalizedExpectedSourceCommit = typeof expectedSourceCommit === 'string'
    ? expectedSourceCommit.toLowerCase()
    : ''
  if (!gitShaPattern.test(normalizedExpectedSourceCommit)) {
    throw new Error('Candidate preview requires the exact candidate source commit.')
  }
  const normalizedExpectedPriorSourceCommit = typeof expectedPriorSourceCommit === 'string'
    ? expectedPriorSourceCommit.toLowerCase()
    : null
  if (allowMaintenanceDegradation && !gitShaPattern.test(normalizedExpectedPriorSourceCommit ?? '')) {
    throw new Error('Coordinated candidate preview requires the exact prior source commit.')
  }
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const workerOrigin = normalizedOrigin(origin, 'Worker origin')
  const [health, readiness, root] = await Promise.all([
    requestJson(
      fetchImplementation,
      `${workerOrigin}/api/v1/health`,
      { method: 'GET' },
      [200],
      timeoutMs,
    ),
    requestJson(
      fetchImplementation,
      `${workerOrigin}/api/v1/ready`,
      { method: 'GET' },
      [200, 503],
      timeoutMs,
    ),
    requestHtml(fetchImplementation, `${workerOrigin}/`, timeoutMs),
  ])
  const healthPayload = health.value && typeof health.value === 'object' ? health.value : null
  const readinessPayload = readiness.value && typeof readiness.value === 'object' ? readiness.value : null
  const validHealth = health.ok && healthPayload?.status === 'ok'
  const validReadiness = readiness.ok
    && candidateReadinessIsConfigured(
      readinessPayload,
      normalizedExpectedSourceCommit,
      allowMaintenanceDegradation,
      normalizedExpectedPriorSourceCommit,
    )
  const deliveryOk = validHealth && root.ok
  return {
    delivery: { ok: deliveryOk },
    health: { error: health.error, ok: validHealth, status: health.status },
    ok: deliveryOk && validReadiness,
    readiness: {
      error: readiness.error,
      ok: validReadiness,
      status: readiness.status,
    },
    root,
  }
}

function maintenanceReadinessIsSafe(payload, allowedSourceCommits = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const checks = payload.checks
  const scheduledRuntime = payload.scheduledRuntime
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return false
  if (!scheduledRuntime || typeof scheduledRuntime !== 'object' || Array.isArray(scheduledRuntime)) return false
  if (!['closed', 'open', 'recovering'].includes(scheduledRuntime.mode)) return false
  if (!Number.isInteger(scheduledRuntime.consecutiveFailures) || scheduledRuntime.consecutiveFailures < 0) return false
  if (!readinessConfigurationChecks.every((name) => checks[name] === true)) return false
  if (Object.entries(checks).some(([name, value]) => (
    name !== 'scheduledRuntimeFresh'
    && name !== 'scheduledRuntimeNoFailures'
    && value !== true
  ))) return false
  if (typeof checks.scheduledRuntimeFresh !== 'boolean'
    || typeof checks.scheduledRuntimeNoFailures !== 'boolean') return false
  if (checks.scheduledRuntimeNoFailures !== (scheduledRuntime.consecutiveFailures === 0)) return false
  const recordedSourceCommit = scheduledRuntime.lastFullSuccessSourceCommit
  if (typeof recordedSourceCommit !== 'string' || !gitShaPattern.test(recordedSourceCommit)) return false
  if (typeof scheduledRuntime.lastFullSuccessAt !== 'string'
    || !Number.isFinite(Date.parse(scheduledRuntime.lastFullSuccessAt))) return false
  const normalizedSourceCommit = recordedSourceCommit.toLowerCase()
  if (allowedSourceCommits.some((commit) => !gitShaPattern.test(commit))) return false
  if (allowedSourceCommits.length > 0 && !allowedSourceCommits.includes(normalizedSourceCommit)) return false
  if (payload.ready === true) {
    return payload.status === 'ready'
      && checks.scheduledRuntimeFresh === true
      && checks.scheduledRuntimeNoFailures === true
      && scheduledRuntime.mode === 'closed'
      && scheduledRuntime.consecutiveFailures === 0
  }
  return payload.ready === false
    && payload.status === 'degraded'
    && checks.scheduledRuntimeFresh === false
}

export async function probeWorkerDuringMaintenance(
  origin,
  dependencies = {},
  timeoutMs = 8_000,
  requirements = {},
) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch
  const workerOrigin = normalizedOrigin(origin, 'Worker origin')
  const [health, readiness, root] = await Promise.all([
    requestJson(fetchImplementation, `${workerOrigin}/api/v1/health`, { method: 'GET' }, [200], timeoutMs),
    requestJson(fetchImplementation, `${workerOrigin}/api/v1/ready`, { method: 'GET' }, [200, 503], timeoutMs),
    requestHtml(fetchImplementation, `${workerOrigin}/`, timeoutMs),
  ])
  const healthPayload = health.value && typeof health.value === 'object' ? health.value : null
  const readinessPayload = readiness.value && typeof readiness.value === 'object' ? readiness.value : null
  const validHealth = health.ok && healthPayload?.status === 'ok'
  const allowedSourceCommits = Array.isArray(requirements.allowedSourceCommits)
    ? requirements.allowedSourceCommits.map((commit) => String(commit).toLowerCase())
    : []
  const validReadiness = readiness.ok
    && maintenanceReadinessIsSafe(readinessPayload, allowedSourceCommits)
  const lastFullSuccessAt = typeof readinessPayload?.scheduledRuntime?.lastFullSuccessAt === 'string'
    ? readinessPayload.scheduledRuntime.lastFullSuccessAt
    : null
  const lastFullSuccessSourceCommit = typeof readinessPayload?.scheduledRuntime?.lastFullSuccessSourceCommit === 'string'
    ? readinessPayload.scheduledRuntime.lastFullSuccessSourceCommit.toLowerCase()
    : null
  const deliveryOk = validHealth && root.ok
  return {
    delivery: { ok: deliveryOk },
    health: { error: health.error, ok: validHealth, status: health.status },
    ok: deliveryOk && validReadiness,
    readiness: {
      error: readiness.error,
      lastFullSuccessAt,
      lastFullSuccessSourceCommit,
      ok: validReadiness,
      status: readiness.status,
    },
    root,
  }
}

export async function probeProduction(config, dependencies = {}, workerRequirements = {}) {
  const [worker, upstream] = await Promise.all([
    probeWorker(config.productionOrigin, dependencies, config.timeoutMs, workerRequirements),
    probeUpstream(config, dependencies),
  ])
  return { ok: worker.ok && upstream.ok, upstream, worker }
}

async function probeProductionDuringMaintenance(config, dependencies = {}) {
  const [worker, upstream] = await Promise.all([
    probeWorkerDuringMaintenance(config.productionOrigin, dependencies, config.timeoutMs),
    probeUpstream(config, dependencies),
  ])
  return { ok: worker.ok && upstream.ok, upstream, worker }
}

export function parseCoordinatedMaintenanceWindow(stdout, expectedId, expectedReleaseVersion) {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error('The coordinated maintenance query returned invalid JSON.')
  }
  if (!Array.isArray(payload?.rows) || payload.rows.length !== 1) {
    throw new Error('The exact coordinated maintenance window could not be verified.')
  }
  const row = payload.rows[0]
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || row.id !== expectedId
    || row.release_version !== expectedReleaseVersion
    || row.access_mode !== 'read_only'
    || !['scheduled', 'completed', 'canceled'].includes(row.status)
    || !Array.isArray(row.feature_codes)) {
    throw new Error('The coordinated maintenance window does not match this release.')
  }
  const features = [...new Set(row.feature_codes)].sort()
  if (features.length !== coordinatedMaintenanceFeatures.length
    || features.some((feature, index) => feature !== coordinatedMaintenanceFeatures[index])) {
    throw new Error('The coordinated maintenance window does not protect the exact required feature set.')
  }
  const startsAtMs = Date.parse(row.starts_at)
  const endsAtMs = Date.parse(row.ends_at)
  const serverTimeMs = Date.parse(row.server_time)
  if (![startsAtMs, endsAtMs, serverTimeMs].every(Number.isFinite) || endsAtMs <= startsAtMs) {
    throw new Error('The coordinated maintenance window has invalid server timestamps.')
  }
  return {
    active: row.status === 'scheduled' && startsAtMs <= serverTimeMs && serverTimeMs < endsAtMs,
    endsAt: row.ends_at,
    remainingMs: Math.max(0, endsAtMs - serverTimeMs),
    status: row.status,
  }
}

function coordinatedMaintenanceQuery(windowId) {
  return `select id::text, release_version, access_mode, status, feature_codes, starts_at, ends_at, now() as server_time from public.maintenance_windows where id = '${windowId}'::uuid`
}

async function readCoordinatedMaintenanceWindow(
  dependencies,
  commandOptions,
  options,
  timeoutMs = 45_000,
) {
  let result
  try {
    result = await dependencies.run([
      'dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', productionProject,
      coordinatedMaintenanceQuery(options.maintenanceWindowId), '-o', 'json',
    ], { ...commandOptions, timeoutMs: Math.max(1, Math.min(45_000, timeoutMs)) })
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    throw new Error('The exact coordinated maintenance window could not be read; release state was not assumed.')
  }
  return parseCoordinatedMaintenanceWindow(result.stdout, options.maintenanceWindowId, options.tag)
}

async function requireActiveCoordinatedMaintenance(dependencies, commandOptions, options) {
  const maintenance = await readCoordinatedMaintenanceWindow(dependencies, commandOptions, options)
  if (!maintenance.active) {
    throw new Error('The exact coordinated maintenance window is not active; the release cannot cross the version boundary.')
  }
  if (maintenance.remainingMs < options.maintenanceMinimumRemainingMs) {
    throw new Error('The coordinated maintenance window does not have enough remaining time for a safe release.')
  }
  return maintenance
}

export function parseCurrentDeployment(stdout) {
  let value
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('Wrangler returned an invalid deployment status payload.')
  }
  const versions = Array.isArray(value?.versions) ? value.versions : []
  const current = versions.filter((entry) => Number(entry?.percentage) === 100)
  if (current.length !== 1 || typeof current[0].version_id !== 'string' || !uuidPattern.test(current[0].version_id)) {
    throw new Error('Production must have one exact 100% Worker version before release.')
  }
  return current[0].version_id
}

export function parseVersionIds(stdout) {
  let value
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('Wrangler returned an invalid Worker version list.')
  }
  if (!Array.isArray(value)) throw new Error('Wrangler returned an invalid Worker version list.')
  return value.map((entry) => entry?.id).filter((id) => typeof id === 'string' && uuidPattern.test(id))
}

export function parseSourceCommitFromVersion(stdout, expectedVersionId) {
  let value
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('Wrangler returned an invalid Worker version payload.')
  }
  if (!value || typeof value !== 'object' || value.id !== expectedVersionId) {
    throw new Error('The deployed Worker version metadata did not match the requested version.')
  }
  const tag = value.annotations?.['workers/tag']
  const match = typeof tag === 'string' ? tag.match(sourceTagPattern) : null
  if (!match) throw new Error('The deployed Worker version does not have a valid source commit tag.')
  return match[1].toLowerCase()
}

export function identifyUploadedVersion(beforeIds, afterIds) {
  const before = new Set(beforeIds)
  const added = afterIds.filter((id) => !before.has(id))
  if (added.length !== 1) throw new Error('The uploaded Worker version could not be identified unambiguously.')
  return added[0]
}

export function extractVersionUrl(output) {
  const matches = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\/?/gi) ?? []
  return matches.length ? matches.at(-1).replace(/\/$/, '') : null
}

async function runConsecutiveProbes(
  config,
  dependencies,
  requiredPasses,
  maximumAttempts,
  delayMs,
  workerRequirements = {},
  upstreamProbeIntervalMs = 30_000,
  minimumUpstreamSamplesForSuccess = 1,
) {
  let consecutive = 0
  let consecutiveDeliveryFailures = 0
  let upstreamHealthyWorkerFailures = 0
  let upstreamProbeCount = 0
  let upstreamVerifiedAfterOperationalSuccess = requirementsDoNotNeedOperationalProof(workerRequirements)
  let lastUpstream = null
  let last = null
  const upstreamSampleEveryAttempts = Math.max(1, Math.ceil(upstreamProbeIntervalMs / Math.max(1, delayMs)))
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const shouldProbeUpstream = attempt === 1
      || attempt === maximumAttempts
      || (attempt - 1) % upstreamSampleEveryAttempts === 0
    const worker = await probeWorker(config.productionOrigin, dependencies, config.timeoutMs, workerRequirements)
    // Sample upstream after the Worker response so a successful sample can
    // prove the dependency boundary after a newly observed scheduler success.
    const upstream = shouldProbeUpstream ? await probeUpstream(config, dependencies) : null
    if (upstream) {
      upstreamProbeCount += 1
      lastUpstream = upstream
      if (!upstream.ok || worker.ok) upstreamHealthyWorkerFailures = 0
      else upstreamHealthyWorkerFailures += 1
      if (upstream.ok && worker.ok) {
        upstreamVerifiedAfterOperationalSuccess = true
      }
    } else if (worker.ok) upstreamHealthyWorkerFailures = 0
    last = {
      ok: worker.ok && lastUpstream?.ok === true,
      upstream: lastUpstream,
      worker,
    }
    consecutiveDeliveryFailures = last.worker.delivery.ok ? 0 : consecutiveDeliveryFailures + 1
    consecutive = last.ok ? consecutive + 1 : 0
    if (consecutiveDeliveryFailures >= 2) {
      return {
        attempts: attempt,
        last,
        ok: false,
        releaseLocalFailureObserved: true,
        upstreamHealthyWorkerFailures,
        upstreamProbeCount,
      }
    }
    if (consecutive >= requiredPasses
      && upstreamProbeCount >= minimumUpstreamSamplesForSuccess
      && upstreamVerifiedAfterOperationalSuccess) {
      return {
        attempts: attempt,
        last,
        ok: true,
        releaseLocalFailureObserved: consecutiveDeliveryFailures >= 2,
        upstreamHealthyWorkerFailures,
        upstreamProbeCount,
      }
    }
    if (attempt < maximumAttempts) await dependencies.sleep(delayMs)
  }
  return {
    attempts: maximumAttempts,
    last,
    ok: false,
    releaseLocalFailureObserved: consecutiveDeliveryFailures >= 2,
    upstreamHealthyWorkerFailures,
    upstreamProbeCount,
  }
}

async function runConsecutiveMaintenanceProbes(
  config,
  dependencies,
  requiredPasses,
  maximumAttempts,
  delayMs,
  workerRequirements = {},
) {
  let consecutive = 0
  let last = null
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const [worker, upstream] = await Promise.all([
      probeWorkerDuringMaintenance(
        config.productionOrigin,
        dependencies,
        config.timeoutMs,
        workerRequirements,
      ),
      probeUpstream(config, dependencies),
    ])
    last = { ok: worker.ok && upstream.ok, upstream, worker }
    consecutive = last.ok ? consecutive + 1 : 0
    if (consecutive >= requiredPasses) return { attempts: attempt, last, ok: true }
    if (attempt < maximumAttempts) await dependencies.sleep(delayMs)
  }
  return { attempts: maximumAttempts, last, ok: false }
}

function requirementsDoNotNeedOperationalProof(workerRequirements) {
  return !Object.hasOwn(workerRequirements, 'requiredFullSuccessAfter')
    && !Object.hasOwn(workerRequirements, 'requiredSourceCommit')
}

function packageManagerCli() {
  const candidate = process.env.npm_execpath ?? ''
  if (!candidate || !isAbsolute(candidate) || !existsSync(candidate) || !/\.(?:cjs|mjs|js)$/i.test(candidate)) {
    throw new Error('Run the production release through pnpm so its verified CLI path is available.')
  }
  return candidate
}

export function createCommandRunner(injected = {}) {
  const spawnImplementation = injected.spawn ?? spawn
  const resolvePackageManagerCli = injected.packageManagerCli ?? packageManagerCli
  const runtimePlatform = injected.platform ?? process.platform
  const processKill = injected.processKill ?? process.kill.bind(process)
  const treeKillSpawn = injected.treeKillSpawn ?? spawn
  const treeKillTimeoutMs = injected.treeKillTimeoutMs ?? 5_000
  return (arguments_, options = {}) => new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 20 * 60_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('The release command timeout must be a positive number.'))
      return
    }
    const childEnvironment = commandEnvironment(options.env)
    const child = spawnImplementation(process.execPath, [resolvePackageManagerCli(), ...arguments_], {
      cwd: options.cwd,
      ...(runtimePlatform === 'win32' ? {} : { detached: true }),
      env: childEnvironment,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', () => finish(() => reject(new Error('The release command could not be started.'))))
    child.once('close', (code) => {
      finish(() => {
        if (code === 0) resolve({ stderr, stdout })
        else reject(new Error(`The release command failed with exit code ${code ?? 'unknown'}.`))
      })
    })
    timeout = setTimeout(() => {
      finish(() => {
        const timeoutError = () => reject(new Error('The release command timed out.'))
        const terminationUnconfirmedError = () => reject(new CommandTerminationUnconfirmedError())
        const killDirectChild = () => {
          try {
            child.kill()
          } catch {
            // The generic timeout error below remains safe to expose.
          }
        }
        if (runtimePlatform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
          try {
            const killer = treeKillSpawn(
              'taskkill.exe',
              ['/PID', String(child.pid), '/T', '/F'],
              {
                env: childEnvironment,
                shell: false,
                stdio: 'ignore',
                windowsHide: true,
              },
            )
            let treeKillSettled = false
            const treeKillDeadline = setTimeout(() => {
              if (treeKillSettled) return
              treeKillSettled = true
              killDirectChild()
              terminationUnconfirmedError()
            }, treeKillTimeoutMs)
            const completeTreeKill = (succeeded) => {
              if (treeKillSettled) return
              treeKillSettled = true
              clearTimeout(treeKillDeadline)
              if (!succeeded) killDirectChild()
              if (succeeded) timeoutError()
              else terminationUnconfirmedError()
            }
            killer.once('error', () => completeTreeKill(false))
            killer.once('close', (code) => {
              completeTreeKill(code === 0)
            })
          } catch {
            killDirectChild()
            terminationUnconfirmedError()
          }
        } else if (runtimePlatform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
          try {
            // A detached POSIX child is the leader of its own process group.
            // SIGKILL cannot be caught or ignored, so a successful group signal
            // prevents a pnpm-spawned Wrangler descendant from applying a late
            // deploy, promotion, or rollback after reconciliation has ended.
            processKill(-child.pid, 'SIGKILL')
            timeoutError()
          } catch {
            killDirectChild()
            terminationUnconfirmedError()
          }
        } else {
          killDirectChild()
          timeoutError()
        }
      })
    }, timeoutMs)
  })
}

export function commandEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment ?? {}).filter(([key]) => !key.toUpperCase().startsWith('SYGSHIFT_RELEASE_')),
  )
}

function validatedOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('Release options are required.')
  if (!safeTagPattern.test(options.tag ?? '')) throw new Error('Release tag contains unsupported characters.')
  if (!options.dryRun && options.rollbackSafe !== true) {
    throw new Error('A live release requires an explicit rollback-safe decision.')
  }
  const hasCanaryEmail = Boolean(options.canaryEmail)
  const hasCanaryPassword = Boolean(options.canaryPassword)
  if (hasCanaryEmail !== hasCanaryPassword) throw new Error('Both release canary credentials must be configured together.')
  if (!hasCanaryEmail && options.allowBoundaryProbe !== true) {
    throw new Error('Configure a release canary or explicitly allow the weaker anonymous boundary probe.')
  }
  const maintenanceCoordinated = options.maintenanceCoordinated === true
  const maintenanceWindowId = options.maintenanceWindowId ?? null
  if (maintenanceCoordinated && options.dryRun) {
    throw new Error('Coordinated maintenance mode is available only for a live release.')
  }
  if (maintenanceCoordinated !== Boolean(maintenanceWindowId)) {
    throw new Error('Coordinated maintenance mode requires one exact maintenance window ID.')
  }
  if (maintenanceWindowId && !uuidPattern.test(maintenanceWindowId)) {
    throw new Error('The coordinated maintenance window ID must be a UUID.')
  }
  const commandTimeoutMs = options.commandTimeoutMs ?? 20 * 60_000
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error('The release command timeout must be a positive number.')
  }
  const reconciliationAttempts = options.reconciliationAttempts ?? 5
  const reconciliationPasses = options.reconciliationPasses ?? 2
  if (!Number.isInteger(reconciliationAttempts) || reconciliationAttempts < reconciliationPasses) {
    throw new Error('Release reconciliation attempts must cover the required confirmation passes.')
  }
  if (!Number.isInteger(reconciliationPasses) || reconciliationPasses < 2) {
    throw new Error('Release reconciliation requires at least two matching production status checks.')
  }
  const upstreamProbeIntervalMs = options.upstreamProbeIntervalMs ?? 30_000
  if (!Number.isFinite(upstreamProbeIntervalMs) || upstreamProbeIntervalMs <= 0) {
    throw new Error('The upstream probe interval must be a positive number.')
  }
  const maximumProbeAttempts = options.maximumProbeAttempts ?? 76
  const postPromotionPasses = options.postPromotionPasses ?? 3
  const probeDelayMs = options.probeDelayMs ?? 2_000
  if (!Number.isInteger(maximumProbeAttempts) || maximumProbeAttempts < 2) {
    throw new Error('Post-promotion verification requires at least two probe attempts.')
  }
  if (!Number.isInteger(postPromotionPasses)
    || postPromotionPasses < 1
    || postPromotionPasses > maximumProbeAttempts) {
    throw new Error('Post-promotion pass count must fit within the configured probe attempts.')
  }
  if (!Number.isFinite(probeDelayMs) || probeDelayMs < 0) {
    throw new Error('The production probe delay must be zero or a positive number.')
  }
  const maintenanceMaximumWaitMs = options.maintenanceMaximumWaitMs ?? 90 * 60_000
  const maintenanceMinimumRemainingMs = options.maintenanceMinimumRemainingMs ?? 5 * 60_000
  const maintenancePollDelayMs = options.maintenancePollDelayMs ?? 5_000
  const maintenanceRecoveryProbeAttempts = options.maintenanceRecoveryProbeAttempts
    ?? Math.max(maximumProbeAttempts, 180)
  if (maintenanceCoordinated) {
    if (!Number.isFinite(maintenanceMaximumWaitMs) || maintenanceMaximumWaitMs <= 0
      || maintenanceMaximumWaitMs > 24 * 60 * 60_000) {
      throw new Error('The coordinated maintenance wait must be positive and no more than 24 hours.')
    }
    if (!Number.isFinite(maintenancePollDelayMs) || maintenancePollDelayMs <= 0) {
      throw new Error('The coordinated maintenance poll delay must be positive.')
    }
    if (!Number.isFinite(maintenanceMinimumRemainingMs) || maintenanceMinimumRemainingMs <= 0
      || maintenanceMinimumRemainingMs > 24 * 60 * 60_000) {
      throw new Error('The coordinated maintenance minimum remaining time must be positive and no more than 24 hours.')
    }
    if (!Number.isInteger(maintenanceRecoveryProbeAttempts)
      || maintenanceRecoveryProbeAttempts < postPromotionPasses) {
      throw new Error('The maintenance recovery probes must cover the required confirmation passes.')
    }
  }
  return {
    ...options,
    candidateAlias: options.candidateAlias ?? null,
    commandTimeoutMs,
    // The first release that establishes the scheduler coordinator may need to
    // wait for the next minute trigger before readiness becomes verified.
    maximumProbeAttempts,
    maintenanceCoordinated,
    maintenanceMaximumWaitMs,
    maintenanceMinimumRemainingMs,
    maintenancePollDelayMs,
    maintenanceRecoveryProbeAttempts,
    maintenanceWindowId,
    postPromotionPasses,
    probeDelayMs,
    reconciliationAttempts,
    reconciliationDelayMs: options.reconciliationDelayMs ?? 1_000,
    reconciliationPasses,
    timeoutMs: options.timeoutMs ?? 8_000,
    upstreamProbeIntervalMs,
    workerName: options.workerName ?? 'sygshift',
  }
}

function summarizeProbe(probe) {
  return {
    upstream: {
      auth: probe.upstream.auth.status,
      secureAccess: probe.upstream.secureAccess.status,
      storage: probe.upstream.storage.status,
    },
    worker: {
      health: probe.worker.health.status,
      readiness: probe.worker.readiness.status,
      root: probe.worker.root.status,
    },
  }
}

async function requireReleaseCommit(dependencies, commandOptions) {
  await dependencies.run(['exec', 'git', 'fetch', '--quiet', 'origin', 'main'], commandOptions)
  const workerConfigurationDiff = await dependencies.run(
    ['exec', 'git', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'wrangler.jsonc'],
    commandOptions,
  )
  if (workerConfigurationDiff.stdout.trim()) {
    throw new Error(
      'wrangler.jsonc differs from HEAD. The normal safe-release path is blocked; use the documented lifecycle/config release path.',
    )
  }
  const status = await dependencies.run(
    ['exec', 'git', 'status', '--porcelain=v1', '--untracked-files=all'],
    commandOptions,
  )
  if (status.stdout.trim()) throw new Error('Production release requires a clean working tree.')

  const [local, remote] = await Promise.all([
    dependencies.run(['exec', 'git', 'rev-parse', 'HEAD'], commandOptions),
    dependencies.run(['exec', 'git', 'rev-parse', 'origin/main'], commandOptions),
  ])
  const localSha = local.stdout.trim()
  const remoteSha = remote.stdout.trim()
  if (!gitShaPattern.test(localSha) || !gitShaPattern.test(remoteSha)) {
    throw new Error('Production release could not verify the local and origin/main commits.')
  }
  if (localSha !== remoteSha) throw new Error('Production release commit must exactly match origin/main.')
  return localSha
}

async function requireConfigurationContinuity(dependencies, commandOptions, options, priorVersionId) {
  let version
  try {
    version = await dependencies.run([
      'exec', 'wrangler', 'versions', 'view', priorVersionId,
      '--json',
      '--name', options.workerName,
    ], commandOptions)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    throw new Error(
      'The deployed Worker source tag could not be inspected. Use the documented lifecycle/config release path.',
    )
  }

  let priorSourceCommit
  try {
    priorSourceCommit = parseSourceCommitFromVersion(version.stdout, priorVersionId)
  } catch {
    throw new Error(
      'The deployed Worker is missing a valid source-<commit> tag. Use the documented lifecycle/config release path.',
    )
  }

  let mergeBase
  try {
    mergeBase = await dependencies.run(
      ['exec', 'git', 'merge-base', priorSourceCommit, 'HEAD'],
      commandOptions,
    )
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    throw new Error(
      'The deployed Worker source commit could not be verified as an ancestor. Use the documented lifecycle/config release path.',
    )
  }
  if (mergeBase.stdout.trim().toLowerCase() !== priorSourceCommit) {
    throw new Error(
      'The deployed Worker source commit is not an ancestor of HEAD. Use the documented lifecycle/config release path.',
    )
  }

  const workerConfigurationDiff = await dependencies.run([
    'exec', 'git', 'diff', '--no-ext-diff', '--no-textconv',
    priorSourceCommit, 'HEAD', '--', 'wrangler.jsonc',
  ], commandOptions)
  if (workerConfigurationDiff.stdout.trim()) {
    throw new Error(
      'wrangler.jsonc changed after the deployed Worker source commit. Use the documented lifecycle/config release path.',
    )
  }
  return priorSourceCommit
}

async function reconcileProductionState(
  dependencies,
  commandOptions,
  options,
  priorVersionId,
  candidateVersionId,
  targetState,
) {
  let consecutiveState = 0
  let hadReadErrors = false
  let lastState = null
  for (let attempt = 1; attempt <= options.reconciliationAttempts; attempt += 1) {
    let currentVersionId
    try {
      const status = await dependencies.run(
        ['exec', 'wrangler', 'deployments', 'status', '--json', '--name', options.workerName],
        commandOptions,
      )
      currentVersionId = parseCurrentDeployment(status.stdout)
    } catch (error) {
      if (isCommandTerminationUnconfirmedError(error)) throw error
      hadReadErrors = true
      consecutiveState = 0
      lastState = null
      if (attempt < options.reconciliationAttempts) await dependencies.sleep(options.reconciliationDelayMs)
      continue
    }

    const state = currentVersionId === candidateVersionId
      ? 'candidate'
      : currentVersionId === priorVersionId
        ? 'prior'
        : 'unexpected'
    if (state === 'unexpected') {
      throw new Error('Production is running an unexpected Worker version; manual release reconciliation is required.')
    }
    consecutiveState = state === lastState ? consecutiveState + 1 : 1
    lastState = state
    const targetConfirmed = state === targetState && consecutiveState >= options.reconciliationPasses
    const nonTargetConfirmedAtDeadline = state !== targetState
      && attempt === options.reconciliationAttempts
      && consecutiveState >= options.reconciliationPasses
    if (targetConfirmed || nonTargetConfirmedAtDeadline) {
      return { attempts: attempt, hadReadErrors, state }
    }
    if (attempt < options.reconciliationAttempts) await dependencies.sleep(options.reconciliationDelayMs)
  }
  throw new Error('Production state could not be reconciled; manual release intervention is required.')
}

async function readActiveProductionVersion(dependencies, commandOptions, options) {
  try {
    const status = await dependencies.run(
      ['exec', 'wrangler', 'deployments', 'status', '--json', '--name', options.workerName],
      commandOptions,
    )
    return parseCurrentDeployment(status.stdout)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    throw new Error('Production version could not be confirmed; manual release intervention is required.')
  }
}

async function restoreExactPriorVersion(context) {
  const {
    candidateVersionId,
    commandOptions,
    dependencies,
    maintenanceActive = false,
    options,
    priorSourceCommit,
    priorVersionId,
  } = context
  const activeVersionId = await readActiveProductionVersion(dependencies, commandOptions, options)
  if (activeVersionId === priorVersionId) {
    const rollbackVerification = maintenanceActive
      ? await runConsecutiveMaintenanceProbes(
        options,
        dependencies,
        2,
        4,
        options.probeDelayMs,
        { allowedSourceCommits: [priorSourceCommit] },
      )
      : await runConsecutiveProbes(
        options,
        dependencies,
        2,
        4,
        options.probeDelayMs,
        {},
        options.upstreamProbeIntervalMs,
      )
    return {
      productionAlreadyRestored: true,
      rollbackCommandFailed: false,
      rollbackReconciliationAttempts: 0,
      rollbackStatusReadErrors: false,
      rollbackVerified: rollbackVerification.ok,
    }
  }
  if (activeVersionId !== candidateVersionId) {
    throw new Error('Production changed before rollback; manual release intervention is required.')
  }
  let rollbackCommandFailed = false
  try {
    await dependencies.run([
      'exec', 'wrangler', 'rollback', priorVersionId,
      '--name', options.workerName,
      '--message', `Automatic rollback after failed release ${options.tag}`,
      '--yes',
    ], commandOptions)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    rollbackCommandFailed = true
    dependencies.log('The rollback command did not complete cleanly; reconciling the actual production version.')
  }
  const rollbackState = await reconcileProductionState(
    dependencies,
    commandOptions,
    options,
    priorVersionId,
    candidateVersionId,
    'prior',
  )
  if (rollbackState.state !== 'prior') {
    throw new Error('Automatic rollback did not restore the exact prior Worker version; manual intervention is required.')
  }
  const rollbackVerification = maintenanceActive
    ? await runConsecutiveMaintenanceProbes(
      options,
      dependencies,
      2,
      4,
      options.probeDelayMs,
      { allowedSourceCommits: [priorSourceCommit] },
    )
    : await runConsecutiveProbes(
      options,
      dependencies,
      2,
      4,
      options.probeDelayMs,
      {},
      options.upstreamProbeIntervalMs,
    )
  return {
    rollbackCommandFailed,
    rollbackReconciliationAttempts: rollbackState.attempts,
    rollbackStatusReadErrors: rollbackState.hadReadErrors,
    rollbackVerified: rollbackVerification.ok,
  }
}

async function waitForCoordinatedMaintenanceToEnd(context) {
  const {
    commandOptions,
    dependencies,
    options,
    priorSourceCommit,
    sourceCommit,
  } = context
  const maximumAttempts = Math.max(
    1,
    Math.ceil(options.maintenanceMaximumWaitMs / options.maintenancePollDelayMs),
  )
  const deadlineAt = dependencies.now() + options.maintenanceMaximumWaitMs
  let consecutiveDeliveryFailures = 0
  let consecutiveUnsafeWorkerFailures = 0
  let observedActiveMaintenance = false
  let upstreamProbeCount = 0
  const timedOutResult = (attempts) => ({
    attempts,
    cleared: false,
    maintenanceActiveProven: false,
    observedActiveMaintenance,
    releaseLocalFailureObserved: false,
    timedOut: true,
    upstreamProbeCount,
  })
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const remainingBeforeReadMs = deadlineAt - dependencies.now()
    if (remainingBeforeReadMs <= 0) return timedOutResult(attempt - 1)
    let maintenance
    try {
      maintenance = await readCoordinatedMaintenanceWindow(
        dependencies,
        commandOptions,
        options,
        remainingBeforeReadMs,
      )
    } catch {
      return {
        attempts: attempt,
        cleared: false,
        maintenanceReadFailed: true,
        maintenanceActiveProven: false,
        observedActiveMaintenance,
        releaseLocalFailureObserved: true,
        timedOut: false,
        upstreamProbeCount,
      }
    }
    if (!maintenance.active) {
      if (!observedActiveMaintenance) {
        return {
          attempts: attempt,
          cleared: false,
          cutoverProofLost: true,
          endedAt: maintenance.endsAt,
          maintenanceActiveProven: false,
          observedActiveMaintenance: false,
          releaseLocalFailureObserved: false,
          timedOut: false,
          upstreamProbeCount,
        }
      }
      return {
        attempts: attempt,
        cleared: true,
        endedAt: maintenance.endsAt,
        maintenanceActiveProven: false,
        observedActiveMaintenance: true,
        releaseLocalFailureObserved: false,
        timedOut: false,
        upstreamProbeCount,
      }
    }
    observedActiveMaintenance = true

    const remainingBeforeProbeMs = deadlineAt - dependencies.now()
    // An authenticated upstream sample can perform six sequential requests;
    // reserve one additional share for event-loop and response parsing time.
    const probeDeadlineSlices = 7
    if (remainingBeforeProbeMs < probeDeadlineSlices) return timedOutResult(attempt)
    const boundedProbeOptions = {
      ...options,
      timeoutMs: Math.max(
        1,
        Math.min(options.timeoutMs, Math.floor(remainingBeforeProbeMs / probeDeadlineSlices)),
      ),
    }

    const [worker] = await Promise.all([
      probeWorkerDuringMaintenance(
        options.productionOrigin,
        dependencies,
        boundedProbeOptions.timeoutMs,
        { allowedSourceCommits: [priorSourceCommit, sourceCommit] },
      ),
      probeUpstream(boundedProbeOptions, dependencies),
    ])
    upstreamProbeCount += 1
    consecutiveDeliveryFailures = worker.delivery.ok ? 0 : consecutiveDeliveryFailures + 1
    consecutiveUnsafeWorkerFailures = !worker.ok
      ? consecutiveUnsafeWorkerFailures + 1
      : 0
    if (consecutiveDeliveryFailures >= 2 || consecutiveUnsafeWorkerFailures >= 2) {
      return {
        attempts: attempt,
        cleared: false,
        maintenanceActiveProven: true,
        observedActiveMaintenance: true,
        releaseLocalFailureObserved: true,
        timedOut: false,
        upstreamProbeCount,
      }
    }
    const remainingAfterProbeMs = deadlineAt - dependencies.now()
    if (remainingAfterProbeMs <= 0) return timedOutResult(attempt)
    if (attempt < maximumAttempts) {
      await dependencies.sleep(Math.min(options.maintenancePollDelayMs, remainingAfterProbeMs))
    }
  }
  return timedOutResult(maximumAttempts)
}

async function reconcileExactCandidateForManualIntervention(context) {
  const {
    candidateVersionId,
    commandOptions,
    dependencies,
    options,
    priorVersionId,
  } = context
  const candidateState = await reconcileProductionState(
    dependencies,
    commandOptions,
    options,
    priorVersionId,
    candidateVersionId,
    'candidate',
  )
  if (candidateState.state !== 'candidate') {
    throw new Error('The exact candidate is no longer active; manual release reconciliation is required.')
  }
  return {
    manualCandidateReconciliationAttempts: candidateState.attempts,
    manualCandidateStatusReadErrors: candidateState.hadReadErrors,
  }
}

async function finalizePromotion(context) {
  const {
    candidatePreview,
    candidateVersionId,
    commandOptions,
    dependencies,
    options,
    priorSourceCommit,
    priorVersionId,
    promotionCommandFailed,
    promotionWatermark,
    sourceCommit,
    versionUrl,
  } = context
  const productionState = await reconcileProductionState(
    dependencies,
    commandOptions,
    options,
    priorVersionId,
    candidateVersionId,
    'candidate',
  )
  const promotionAmbiguous = promotionCommandFailed || productionState.hadReadErrors
  const common = {
    candidatePreview,
    candidateVersionId,
    priorSourceCommit,
    priorVersionId,
    promotionFullSuccessWatermark: promotionWatermark,
    promotionAmbiguous,
    promotionReconciliationAttempts: productionState.attempts,
    promotionStatusReadErrors: productionState.hadReadErrors,
    sourceCommit,
    versionUrlAvailable: Boolean(versionUrl),
  }
  if (productionState.state === 'prior') {
    return {
      ...common,
      outcome: releaseOutcomes.promotionNotApplied,
      promoted: false,
      rolledBack: false,
    }
  }

  let coordinatedMaintenance = null
  if (options.maintenanceCoordinated) {
    dependencies.log('The exact candidate is active under coordinated maintenance; waiting for the audited window to close or expire.')
    coordinatedMaintenance = await waitForCoordinatedMaintenanceToEnd({
      commandOptions,
      dependencies,
      options,
      priorSourceCommit,
      sourceCommit,
    })
    if (!coordinatedMaintenance.cleared) {
      const rollbackMayBeSafe = !coordinatedMaintenance.maintenanceReadFailed
        && !coordinatedMaintenance.cutoverProofLost
        && (coordinatedMaintenance.releaseLocalFailureObserved || coordinatedMaintenance.timedOut)
      let freshMaintenanceProof = null
      if (rollbackMayBeSafe) {
        try {
          freshMaintenanceProof = await requireActiveCoordinatedMaintenance(
            dependencies,
            commandOptions,
            options,
          )
        } catch {
          freshMaintenanceProof = null
        }
      }
      if (freshMaintenanceProof) {
        dependencies.log('The candidate failed while the exact maintenance window remained active; restoring the exact prior Worker version.')
        const rollback = await restoreExactPriorVersion({
          candidateVersionId,
          commandOptions,
          dependencies,
          maintenanceActive: true,
          options,
          priorSourceCommit,
          priorVersionId,
        })
        return {
          ...common,
          ...rollback,
          coordinatedMaintenance: {
            ...coordinatedMaintenance,
            maintenanceActiveProven: true,
            observedActiveMaintenance: true,
            rollbackMaintenanceEndsAt: freshMaintenanceProof.endsAt,
            rollbackMaintenanceProof: 'fresh_exact_reread',
          },
          outcome: releaseOutcomes.badRelease,
          promoted: true,
          rolledBack: true,
          upstreamProbeCount: coordinatedMaintenance.upstreamProbeCount,
        }
      }

      dependencies.log('Coordinated cutover proof is incomplete; leaving the exact candidate active for manual intervention.')
      const manualReconciliation = await reconcileExactCandidateForManualIntervention({
        candidateVersionId,
        commandOptions,
        dependencies,
        options,
        priorVersionId,
      })
      return {
        ...common,
        ...manualReconciliation,
        coordinatedMaintenance,
        manualInterventionRequired: true,
        outcome: releaseOutcomes.manualIntervention,
        promoted: true,
        rolledBack: false,
        upstreamProbeCount: coordinatedMaintenance.upstreamProbeCount,
      }
    }
  }

  const verification = await runConsecutiveProbes(
    options,
    dependencies,
    options.postPromotionPasses,
    options.maintenanceCoordinated
      ? options.maintenanceRecoveryProbeAttempts
      : options.maximumProbeAttempts,
    options.probeDelayMs,
    {
      requiredFullSuccessAfter: promotionWatermark,
      requiredSourceCommit: sourceCommit,
      requireStrictReadiness: options.maintenanceCoordinated,
      requireZeroConsecutiveFailures: options.maintenanceCoordinated,
    },
    options.upstreamProbeIntervalMs,
    2,
  )
  if (verification.ok) {
    const activeVersionId = await readActiveProductionVersion(dependencies, commandOptions, options)
    if (activeVersionId !== candidateVersionId) {
      throw new Error('Production changed during release verification; manual release intervention is required.')
    }
    return {
      ...common,
      ...(coordinatedMaintenance ? { coordinatedMaintenance } : {}),
      outcome: releaseOutcomes.released,
      probeAttempts: verification.attempts,
      promoted: true,
      rolledBack: false,
      scheduledRuntimeFullSuccessAdvancedFrom: promotionWatermark,
      scheduledRuntimeFullSuccessAt: verification.last.worker.readiness.lastFullSuccessAt,
      scheduledRuntimeFullSuccessSourceCommit: verification.last.worker.readiness.lastFullSuccessSourceCommit,
      upstreamProbeCount: verification.upstreamProbeCount
        + (coordinatedMaintenance?.upstreamProbeCount ?? 0),
    }
  }

  if (options.maintenanceCoordinated) {
    dependencies.log('Post-maintenance proof did not complete; leaving the exact database-compatible candidate active for manual intervention.')
    const manualReconciliation = await reconcileExactCandidateForManualIntervention({
      candidateVersionId,
      commandOptions,
      dependencies,
      options,
      priorVersionId,
    })
    return {
      ...common,
      ...manualReconciliation,
      coordinatedMaintenance,
      manualInterventionRequired: true,
      outcome: releaseOutcomes.manualIntervention,
      probeAttempts: verification.attempts,
      promoted: true,
      rolledBack: false,
      upstreamProbeCount: verification.upstreamProbeCount
        + (coordinatedMaintenance?.upstreamProbeCount ?? 0),
    }
  }

  const rollbackRequired = promotionAmbiguous
    || verification.releaseLocalFailureObserved
    || verification.upstreamHealthyWorkerFailures >= 2
  if (!rollbackRequired) {
    const activeVersionId = await readActiveProductionVersion(dependencies, commandOptions, options)
    if (activeVersionId !== candidateVersionId) {
      throw new Error('Production changed during release verification; manual release intervention is required.')
    }
    return {
      ...common,
      ...(coordinatedMaintenance ? { coordinatedMaintenance } : {}),
      outcome: releaseOutcomes.providerOutage,
      probeAttempts: verification.attempts,
      promoted: true,
      rolledBack: false,
      upstreamProbeCount: verification.upstreamProbeCount
        + (coordinatedMaintenance?.upstreamProbeCount ?? 0),
    }
  }

  dependencies.log('The active candidate did not pass release verification; restoring the exact prior Worker version.')
  const rollback = await restoreExactPriorVersion({
    candidateVersionId,
    commandOptions,
    dependencies,
    options,
    priorSourceCommit,
    priorVersionId,
  })
  return {
    ...common,
    ...rollback,
    ...(coordinatedMaintenance ? { coordinatedMaintenance } : {}),
    outcome: releaseOutcomes.badRelease,
    probeAttempts: verification.attempts,
    promoted: true,
    rolledBack: true,
    upstreamProbeCount: verification.upstreamProbeCount
      + (coordinatedMaintenance?.upstreamProbeCount ?? 0),
  }
}

export async function runProductionRelease(inputOptions, injected = {}) {
  const options = validatedOptions(inputOptions)
  const dependencies = {
    fetch: injected.fetch ?? globalThis.fetch,
    log: injected.log ?? (() => undefined),
    now: injected.now ?? Date.now,
    run: injected.run ?? createCommandRunner(),
    sleep: injected.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  }
  const commandOptions = {
    cwd: options.cwd,
    env: commandEnvironment(options.environment ?? process.env),
    timeoutMs: options.commandTimeoutMs,
  }
  dependencies.log('Checking the existing production release and upstream services.')
  if (options.maintenanceCoordinated) {
    await requireActiveCoordinatedMaintenance(dependencies, commandOptions, options)
  }
  const baseline = options.maintenanceCoordinated
    ? await probeProductionDuringMaintenance(options, dependencies)
    : await probeProduction(options, dependencies)
  if (!baseline.upstream.ok) {
    return { baseline: summarizeProbe(baseline), outcome: releaseOutcomes.providerOutage, promoted: false, rolledBack: false }
  }
  if (!baseline.worker.ok) {
    return { baseline: summarizeProbe(baseline), outcome: releaseOutcomes.badRelease, promoted: false, rolledBack: false }
  }

  const sourceCommit = await requireReleaseCommit(dependencies, commandOptions)

  const deployment = await dependencies.run(
    ['exec', 'wrangler', 'deployments', 'status', '--json', '--name', options.workerName],
    commandOptions,
  )
  const priorVersionId = parseCurrentDeployment(deployment.stdout)
  const priorSourceCommit = await requireConfigurationContinuity(
    dependencies,
    commandOptions,
    options,
    priorVersionId,
  )

  dependencies.log('Running the complete local release gate.')
  await dependencies.run(['check'], commandOptions)
  await dependencies.run(['test:e2e:time-clock'], commandOptions)
  // Always regenerate the deployable bundle after the mandatory browser
  // verification so only a fresh production build can be promoted.
  await dependencies.run(['build'], commandOptions)

  if (options.dryRun) {
    const confirmedSourceCommit = await requireReleaseCommit(dependencies, commandOptions)
    if (confirmedSourceCommit !== sourceCommit) {
      throw new Error('The source commit changed during the release gate; no candidate was uploaded.')
    }
    await dependencies.run(
      ['exec', 'wrangler', 'versions', 'upload', '--dry-run', '--strict', '--name', options.workerName],
      commandOptions,
    )
    return {
      baseline: summarizeProbe(baseline),
      candidatePreview: { available: false, checked: false, reason: 'dry_run' },
      outcome: releaseOutcomes.dryRun,
      priorSourceCommit,
      priorVersionId,
      promoted: false,
      rolledBack: false,
      sourceCommit,
    }
  }

  const versionsBefore = await dependencies.run(
    ['exec', 'wrangler', 'versions', 'list', '--json', '--name', options.workerName],
    commandOptions,
  )
  const beforeIds = parseVersionIds(versionsBefore.stdout)
  const confirmedSourceCommit = await requireReleaseCommit(dependencies, commandOptions)
  if (confirmedSourceCommit !== sourceCommit) {
    throw new Error('The source commit changed during the release gate; no candidate was uploaded.')
  }
  dependencies.log('Uploading a candidate Worker version without changing production traffic.')
  const upload = await dependencies.run([
    'exec', 'wrangler', 'versions', 'upload',
    '--strict',
    '--name', options.workerName,
    '--tag', `source-${sourceCommit.toLowerCase()}`,
    '--var', `SYGSHIFT_SOURCE_COMMIT:${sourceCommit.toLowerCase()}`,
    '--message', options.message ?? `SygShift release ${options.tag}`,
    ...(options.candidateAlias ? ['--preview-alias', options.candidateAlias] : []),
  ], commandOptions)
  const versionsAfter = await dependencies.run(
    ['exec', 'wrangler', 'versions', 'list', '--json', '--name', options.workerName],
    commandOptions,
  )
  const candidateVersionId = identifyUploadedVersion(beforeIds, parseVersionIds(versionsAfter.stdout))
  const versionUrl = extractVersionUrl(`${upload.stdout}\n${upload.stderr}`)
  let candidatePreview = {
    available: false,
    checked: false,
    reason: 'wrangler_did_not_return_version_url',
  }

  if (versionUrl) {
    dependencies.log('Running read-only checks against the uploaded candidate Version URL.')
    const candidateProbe = await probeCandidateWorker(
      versionUrl,
      sourceCommit,
      dependencies,
      options.timeoutMs,
      options.maintenanceCoordinated,
      options.maintenanceCoordinated ? priorSourceCommit : null,
    )
    candidatePreview = { available: true, checked: true }
    if (!candidateProbe.ok) {
      return {
        candidatePreview,
        candidateVersionId,
        outcome: releaseOutcomes.badCandidate,
        priorSourceCommit,
        priorVersionId,
        promoted: false,
        rolledBack: false,
        sourceCommit,
        versionUrlAvailable: true,
      }
    }
  } else {
    dependencies.log('Wrangler did not provide a candidate Version URL; candidate-only smoke checks were not available.')
    if (options.maintenanceCoordinated) {
      return {
        candidatePreview: {
          ...candidatePreview,
          reason: 'required_for_coordinated_release',
        },
        candidateVersionId,
        outcome: releaseOutcomes.badCandidate,
        priorSourceCommit,
        priorVersionId,
        promoted: false,
        rolledBack: false,
        sourceCommit,
        versionUrlAvailable: false,
      }
    }
  }

  const statusBeforePromotion = await dependencies.run(
    ['exec', 'wrangler', 'deployments', 'status', '--json', '--name', options.workerName],
    commandOptions,
  )
  if (parseCurrentDeployment(statusBeforePromotion.stdout) !== priorVersionId) {
    throw new Error('Production changed during the release; the candidate was not promoted.')
  }
  if (options.maintenanceCoordinated) {
    await requireActiveCoordinatedMaintenance(dependencies, commandOptions, options)
  }
  const prePromotionWorker = options.maintenanceCoordinated
    ? await probeWorkerDuringMaintenance(
      options.productionOrigin,
      dependencies,
      options.timeoutMs,
      { allowedSourceCommits: [priorSourceCommit] },
    )
    : await probeWorker(options.productionOrigin, dependencies, options.timeoutMs)
  if (!prePromotionWorker.ok) {
    throw new Error('Production became unhealthy before promotion; the candidate was not promoted.')
  }
  const confirmedPromotionSourceCommit = await requireReleaseCommit(dependencies, commandOptions)
  if (confirmedPromotionSourceCommit !== sourceCommit) {
    throw new Error('The source commit changed during candidate verification; the candidate was not promoted.')
  }
  const promotionWatermark = prePromotionWorker.readiness.lastFullSuccessAt

  dependencies.log('Promoting the exact validated Worker version to production.')
  let promotionCommandFailed = false
  try {
    await dependencies.run([
      'exec', 'wrangler', 'versions', 'deploy', `${candidateVersionId}@100%`,
      '--name', options.workerName,
      '--message', options.message ?? `SygShift release ${options.tag}`,
      '--yes',
    ], commandOptions)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    promotionCommandFailed = true
    dependencies.log('The promotion command did not complete cleanly; reconciling the actual production version.')
  }
  return finalizePromotion({
    candidatePreview,
    candidateVersionId,
    commandOptions,
    dependencies,
    options,
    priorSourceCommit,
    priorVersionId,
    promotionCommandFailed,
    promotionWatermark,
    sourceCommit,
    versionUrl,
  })
}

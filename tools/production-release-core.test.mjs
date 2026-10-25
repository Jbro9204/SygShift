import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  CommandTerminationUnconfirmedError,
  extractVersionUrl,
  createCommandRunner,
  identifyUploadedVersion,
  parseCurrentDeployment,
  parseCoordinatedMaintenanceWindow,
  parseSourceCommitFromVersion,
  probeCandidateWorker,
  probeWorker,
  probeWorkerDuringMaintenance,
  releaseOutcomes,
  runProductionRelease,
} from './production-release-core.mjs'
import { parseProductionReleaseArguments } from './release-production.mjs'

const priorVersionId = '11111111-1111-4111-8111-111111111111'
const candidateVersionId = '22222222-2222-4222-8222-222222222222'
const concurrentVersionId = '33333333-3333-4333-8333-333333333333'
const releaseCommit = 'a'.repeat(40)
const priorSourceCommit = 'b'.repeat(40)
const maintenanceWindowId = '44444444-4444-4444-8444-444444444444'
const maintenanceCandidateOrigin = 'https://candidate-maintenance-sygshift.example.workers.dev'
const maintenanceFeatures = [
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
]

test('accepts the package-script separator used by documented production commands', () => {
  assert.deepEqual(parseProductionReleaseArguments([
    '--',
    '--tag=release-abc123',
    '--message=Reviewed production release',
    '--rollback-safe',
    '--allow-boundary-probe',
  ]), {
    allowBoundaryProbe: true,
    dryRun: false,
    message: 'Reviewed production release',
    rollbackSafe: true,
    tag: 'release-abc123',
  })
})

test('parses an explicit coordinated maintenance release without changing the normal defaults', () => {
  const maintenanceWindowId = '44444444-4444-4444-8444-444444444444'
  assert.deepEqual(parseProductionReleaseArguments([
    '--tag=stability-durability-20261024',
    '--rollback-safe',
    '--allow-boundary-probe',
    '--maintenance-coordinated',
    `--maintenance-window-id=${maintenanceWindowId}`,
  ]), {
    allowBoundaryProbe: true,
    dryRun: false,
    maintenanceCoordinated: true,
    maintenanceWindowId,
    rollbackSafe: true,
    tag: 'stability-durability-20261024',
  })
})

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  })
}

function htmlResponse(body = '<!doctype html><html><body><div id="root"></div></body></html>', status = 200) {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    status,
  })
}

function readinessPayload(overrides = {}) {
  const {
    checks: checkOverrides,
    scheduledRuntime: scheduledRuntimeOverrides,
    ...payloadOverrides
  } = overrides
  const checks = {
    assetsBinding: true,
    scheduledRuntimeCoordinator: true,
    scheduledRuntimeFresh: true,
    scheduledRuntimeNoFailures: true,
    scheduledRuntimeSourceCommit: true,
    sharedIdentityConsumerSecret: true,
    sharedIdentitySessionSecret: true,
    supabasePublishableKey: true,
    supabaseServiceRoleKey: true,
    supabaseUrl: true,
    sygilantSharedIdentityConsumerSecret: true,
    sygilantSharedIdentityKeySeparation: true,
    sygilantSharedIdentitySigningSecret: true,
    ...checkOverrides,
  }
  return {
    checks,
    ready: true,
    scheduledRuntime: {
      consecutiveFailures: 0,
      lastFullSuccessAt: '2026-10-19T12:00:00.000Z',
      lastFullSuccessSourceCommit: releaseCommit,
      lastSuccessAt: '2026-10-19T12:00:00.000Z',
      mode: 'closed',
      nextProbeAt: null,
      ...scheduledRuntimeOverrides,
    },
    status: 'ready',
    ...payloadOverrides,
  }
}

function healthyFetch(overrides = {}) {
  let readinessChecks = 0
  return async (input) => {
    const url = String(input)
    if (overrides[url]) return overrides[url]()
    if (url.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok' })
    if (url.endsWith('/api/v1/ready')) {
      readinessChecks += 1
      return jsonResponse({
        checks: { scheduledRuntimeFresh: true },
        ready: true,
        scheduledRuntime: {
          lastFullSuccessAt: new Date(Date.UTC(2026, 9, 19, 12, 0, readinessChecks)).toISOString(),
          lastFullSuccessSourceCommit: releaseCommit,
          lastSuccessAt: new Date(Date.UTC(2026, 9, 19, 12, 0, readinessChecks)).toISOString(),
        },
      })
    }
    if (url === 'https://app.example.com/' || url.endsWith('.workers.dev/')) return htmlResponse()
    if (url.includes('/auth/v1/health')) return jsonResponse({ name: 'GoTrue' })
    if (url.includes('/storage/v1/status')) return new Response(null, { status: 200 })
    if (url.includes('/rest/v1/rpc/get_session_context')) return jsonResponse({ message: 'Authentication required' }, 401)
    throw new Error(`Unexpected URL ${url}`)
  }
}

function maintenanceReadinessPayload(overrides = {}) {
  const {
    checks: checkOverrides,
    scheduledRuntime: scheduledRuntimeOverrides,
    ...payloadOverrides
  } = overrides
  return readinessPayload({
    checks: {
      scheduledRuntimeFresh: false,
      scheduledRuntimeNoFailures: false,
      ...checkOverrides,
    },
    ready: false,
    scheduledRuntime: {
      consecutiveFailures: 1,
      lastFullSuccessSourceCommit: priorSourceCommit,
      mode: 'open',
      nextProbeAt: '2026-10-24T23:55:00.000Z',
      ...scheduledRuntimeOverrides,
    },
    status: 'degraded',
    ...payloadOverrides,
  })
}

function maintenanceHealthyFetch(overrides = {}) {
  return healthyFetch({
    [`${maintenanceCandidateOrigin}/api/v1/ready`]: () => jsonResponse(
      maintenanceReadinessPayload(),
      503,
    ),
    ...overrides,
  })
}

function maintenanceWindowRow(overrides = {}) {
  return {
    access_mode: 'read_only',
    ends_at: '2026-10-25T02:00:00.000Z',
    feature_codes: maintenanceFeatures,
    id: maintenanceWindowId,
    release_version: 'stability-durability-20261024',
    server_time: '2026-10-25T01:00:00.000Z',
    starts_at: '2026-10-25T00:00:00.000Z',
    status: 'scheduled',
    ...overrides,
  }
}

test('accepts only the exact active coordinated maintenance contract', () => {
  const active = parseCoordinatedMaintenanceWindow(
    JSON.stringify({ rows: [maintenanceWindowRow()] }),
    maintenanceWindowId,
    'stability-durability-20261024',
  )
  assert.equal(active.active, true)
  assert.throws(() => parseCoordinatedMaintenanceWindow(
    JSON.stringify({ rows: [maintenanceWindowRow({ feature_codes: ['time_clock', ...maintenanceFeatures] })] }),
    maintenanceWindowId,
    'stability-durability-20261024',
  ), /exact required feature set/)
  assert.throws(() => parseCoordinatedMaintenanceWindow(
    JSON.stringify({ rows: [maintenanceWindowRow({ release_version: 'another-release' })] }),
    maintenanceWindowId,
    'stability-durability-20261024',
  ), /does not match/)
})

test('maintenance Worker probe accepts scheduler-only degradation and rejects configuration drift', async () => {
  const fetchFor = (payload) => async (input) => {
    const url = String(input)
    if (url.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok' })
    if (url.endsWith('/api/v1/ready')) return jsonResponse(payload, payload.ready ? 200 : 503)
    if (url === 'https://app.example.com/') return htmlResponse()
    throw new Error(`Unexpected URL ${url}`)
  }
  const expected = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload()) },
  )
  assert.equal(expected.ok, true)

  const misconfigured = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({ checks: { supabaseServiceRoleKey: false } })) },
  )
  assert.equal(misconfigured.ok, false)

  const incompleteSchedulerState = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({ checks: { scheduledRuntimeNoFailures: undefined } })) },
  )
  assert.equal(incompleteSchedulerState.ok, false)

  const missingSource = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({
      scheduledRuntime: { lastFullSuccessSourceCommit: null },
    })) },
  )
  assert.equal(missingSource.ok, false)

  const missingWatermark = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({
      scheduledRuntime: { lastFullSuccessAt: null },
    })) },
  )
  assert.equal(missingWatermark.ok, false)

  const malformedWatermark = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({
      scheduledRuntime: { lastFullSuccessAt: 'not-a-timestamp' },
    })) },
  )
  assert.equal(malformedWatermark.ok, false)

  const inconsistentFailureState = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({
      scheduledRuntime: { consecutiveFailures: 0 },
    })) },
  )
  assert.equal(inconsistentFailureState.ok, false)

  const unexpectedSource = await probeWorkerDuringMaintenance(
    'https://app.example.com',
    { fetch: fetchFor(maintenanceReadinessPayload({
      scheduledRuntime: { lastFullSuccessSourceCommit: 'c'.repeat(40) },
    })) },
    8_000,
    { allowedSourceCommits: [priorSourceCommit, releaseCommit] },
  )
  assert.equal(unexpectedSource.ok, false)
})

test('maintenance candidate preview accepts only explicit scheduler degradation', async () => {
  const origin = 'https://candidate-sygshift.example.workers.dev'
  const fetchFor = (payload) => async (input) => {
    const url = String(input)
    if (url.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok' })
    if (url.endsWith('/api/v1/ready')) return jsonResponse(payload, payload.ready ? 200 : 503)
    if (url === `${origin}/`) return htmlResponse()
    throw new Error(`Unexpected URL ${url}`)
  }
  const fetch = fetchFor(maintenanceReadinessPayload())

  const normal = await probeCandidateWorker(origin, releaseCommit, { fetch })
  await assert.rejects(
    probeCandidateWorker(origin, releaseCommit, { fetch }, 8_000, true),
    /exact prior source commit/,
  )
  const coordinated = await probeCandidateWorker(
    origin,
    releaseCommit,
    { fetch },
    8_000,
    true,
    priorSourceCommit,
  )
  const wrongPrior = await probeCandidateWorker(
    origin,
    releaseCommit,
    { fetch },
    8_000,
    true,
    'c'.repeat(40),
  )
  const missingWatermark = await probeCandidateWorker(
    origin,
    releaseCommit,
    { fetch: fetchFor(maintenanceReadinessPayload({
      scheduledRuntime: { lastFullSuccessAt: null },
    })) },
    8_000,
    true,
    priorSourceCommit,
  )
  const normalMalformedWatermark = await probeCandidateWorker(
    origin,
    releaseCommit,
    { fetch: fetchFor(readinessPayload({
      scheduledRuntime: { lastFullSuccessAt: 'not-a-timestamp' },
    })) },
  )
  const malformedReadyWatermark = await probeCandidateWorker(
    origin,
    releaseCommit,
    { fetch: fetchFor(readinessPayload({
      scheduledRuntime: { lastFullSuccessAt: 'not-a-timestamp' },
    })) },
    8_000,
    true,
    priorSourceCommit,
  )

  assert.equal(normal.ok, false)
  assert.equal(coordinated.ok, true)
  assert.equal(wrongPrior.ok, false)
  assert.equal(missingWatermark.ok, false)
  assert.equal(normalMalformedWatermark.ok, true)
  assert.equal(malformedReadyWatermark.ok, false)
})

test('post-maintenance proof requires an explicit zero scheduler failure count', async () => {
  const fetchFor = (consecutiveFailures) => async (input) => {
    const url = String(input)
    if (url.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok' })
    if (url.endsWith('/api/v1/ready')) return jsonResponse(readinessPayload({
      scheduledRuntime: {
        consecutiveFailures,
        lastFullSuccessAt: '2026-10-25T02:01:00.000Z',
      },
    }))
    if (url === 'https://app.example.com/') return htmlResponse()
    throw new Error(`Unexpected URL ${url}`)
  }
  const requirements = {
    requiredFullSuccessAfter: '2026-10-25T02:00:00.000Z',
    requiredSourceCommit: releaseCommit,
    requireStrictReadiness: true,
    requireZeroConsecutiveFailures: true,
  }

  const invalid = await probeWorker(
    'https://app.example.com',
    { fetch: fetchFor(1) },
    8_000,
    requirements,
  )
  const valid = await probeWorker(
    'https://app.example.com',
    { fetch: fetchFor(0) },
    8_000,
    requirements,
  )
  const misconfigured = await probeWorker(
    'https://app.example.com',
    { fetch: async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/health')) return jsonResponse({ status: 'ok' })
      if (url.endsWith('/api/v1/ready')) return jsonResponse(readinessPayload({
        checks: { supabaseServiceRoleKey: false },
        scheduledRuntime: { lastFullSuccessAt: '2026-10-25T02:01:00.000Z' },
      }))
      if (url === 'https://app.example.com/') return htmlResponse()
      throw new Error(`Unexpected URL ${url}`)
    } },
    8_000,
    requirements,
  )

  assert.equal(invalid.ok, false)
  assert.equal(valid.ok, true)
  assert.equal(misconfigured.ok, false)
})

function releaseOptions(overrides = {}) {
  return {
    allowBoundaryProbe: true,
    cwd: 'C:/repo',
    dryRun: false,
    maximumProbeAttempts: 3,
    postPromotionPasses: 2,
    probeDelayMs: 0,
    productionOrigin: 'https://app.example.com',
    publishableKey: 'public-key-not-a-secret',
    rollbackSafe: true,
    supabaseOrigin: 'https://project.supabase.co',
    tag: 'release-abc123',
    ...overrides,
  }
}

function commandHarness(overrides = {}) {
  const calls = []
  const options = []
  let currentVersionId = priorVersionId
  let listCount = 0
  const run = async (arguments_, commandOptions = {}) => {
    calls.push(arguments_)
    options.push(commandOptions)
    const joined = arguments_.join(' ')
    if (joined.includes('deployments status')) {
      return { stderr: '', stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: currentVersionId }] }) }
    }
    if (joined.includes('versions view')) {
      return {
        stderr: '',
        stdout: JSON.stringify({
          annotations: { 'workers/tag': `source-${priorSourceCommit}` },
          id: priorVersionId,
        }),
      }
    }
    if (joined.includes('git merge-base')) return { stderr: '', stdout: `${priorSourceCommit}\n` }
    if (joined.includes('git rev-parse')) return { stderr: '', stdout: `${releaseCommit}\n` }
    if (joined.includes('versions list')) {
      listCount += 1
      const versions = listCount === 1 ? [{ id: priorVersionId }] : [{ id: priorVersionId }, { id: candidateVersionId }]
      return { stderr: '', stdout: JSON.stringify(versions) }
    }
    if (joined.includes('versions upload') && !joined.includes('--dry-run')) {
      return {
        stderr: '',
        stdout: overrides.versionUrl
          ? `Version URL: ${overrides.versionUrl}`
          : 'Uploaded candidate without a Version URL.',
      }
    }
    if (joined.includes('versions deploy')) currentVersionId = candidateVersionId
    if (joined.includes('wrangler rollback')) currentVersionId = priorVersionId
    return { stderr: '', stdout: '' }
  }
  return { calls, options, run }
}

test('parses only an exact 100 percent production version', () => {
  assert.equal(parseCurrentDeployment(JSON.stringify({
    versions: [
      { percentage: 0, version_id: candidateVersionId },
      { percentage: 100, version_id: priorVersionId },
    ],
  })), priorVersionId)
  assert.throws(() => parseCurrentDeployment('{"versions":[]}'), /exact 100%/)
  assert.throws(() => parseCurrentDeployment(JSON.stringify({
    versions: [
      { percentage: 100, version_id: priorVersionId },
      { percentage: 100, version_id: candidateVersionId },
    ],
  })), /one exact 100%/)
})

test('requires deployed Worker metadata to contain an exact source commit tag', () => {
  assert.equal(parseSourceCommitFromVersion(JSON.stringify({
    annotations: { 'workers/tag': `source-${priorSourceCommit.toUpperCase()}` },
    id: priorVersionId,
  }), priorVersionId), priorSourceCommit)
  assert.throws(() => parseSourceCommitFromVersion(JSON.stringify({
    annotations: { 'workers/tag': 'release-friendly-name' },
    id: priorVersionId,
  }), priorVersionId), /valid source commit tag/)
  assert.throws(() => parseSourceCommitFromVersion(JSON.stringify({
    annotations: { 'workers/tag': `source-${priorSourceCommit}` },
    id: candidateVersionId,
  }), priorVersionId), /did not match/)
})

test('runs pnpm commands without a Windows shell or cmd shim', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  let invocation
  const packageManagerPath = 'C:/tools/pnpm.cjs'
  const runner = createCommandRunner({
    packageManagerCli: () => packageManagerPath,
    platform: 'win32',
    spawn: (command, arguments_, options) => {
      invocation = { arguments_, command, options }
      queueMicrotask(() => {
        child.stdout.emit('data', '11.25.0\n')
        child.emit('close', 0)
      })
      return child
    },
  })

  const result = await runner(['--version'], { cwd: 'C:/repo', env: { PATH: 'C:/toolchain/bin' } })

  assert.equal(result.stdout.trim(), '11.25.0')
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.arguments_, [packageManagerPath, '--version'])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.windowsHide, true)
  assert.equal('detached' in invocation.options, false)
})

test('terminates a command that exceeds its deadline', async () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = new EventEmitter()
  let killed = false
  child.stdout = stdout
  child.stderr = stderr
  child.kill = () => {
    killed = true
    return true
  }
  const runner = createCommandRunner({
    packageManagerCli: () => 'C:/tools/pnpm.cjs',
    spawn: () => child,
  })
  await assert.rejects(runner(['check'], { timeoutMs: 5 }), /timed out/)
  assert.equal(killed, true)
})

test('terminates the full POSIX process group on timeout', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => assert.fail('The direct child fallback should not run when process-group termination succeeds.')
  const processKillCalls = []
  let spawnOptions
  const runner = createCommandRunner({
    packageManagerCli: () => '/tools/pnpm.cjs',
    platform: 'linux',
    processKill: (pid, signal) => {
      processKillCalls.push({ pid, signal })
      return true
    },
    spawn: (_command, _arguments, options) => {
      spawnOptions = options
      return child
    },
  })

  await assert.rejects(runner(['check'], { timeoutMs: 5 }), /timed out/)
  assert.equal(spawnOptions.detached, true)
  assert.deepEqual(processKillCalls, [{ pid: -4321, signal: 'SIGKILL' }])
})

test('requires manual intervention when POSIX process-group termination cannot be confirmed', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let directKillCalls = 0
  child.kill = () => {
    directKillCalls += 1
    return true
  }
  const runner = createCommandRunner({
    packageManagerCli: () => '/tools/pnpm.cjs',
    platform: 'linux',
    processKill: () => { throw new Error('process group unavailable') },
    spawn: () => child,
  })

  await assert.rejects(
    runner(['check'], { timeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof CommandTerminationUnconfirmedError)
      assert.equal(error.code, 'SYGSHIFT_RELEASE_TERMINATION_UNCONFIRMED')
      return true
    },
  )
  assert.equal(directKillCalls, 1)
})

test('terminates the full Windows process tree and scrubs release secrets on timeout', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => assert.fail('The direct child fallback should not run when taskkill starts successfully.')
  const treeKillCalls = []
  let treeKillCompleted = false
  const runner = createCommandRunner({
    packageManagerCli: () => 'C:/tools/pnpm.cjs',
    platform: 'win32',
    spawn: () => child,
    treeKillSpawn: (command, arguments_, options) => {
      treeKillCalls.push({ arguments_, command, options })
      const killer = new EventEmitter()
      queueMicrotask(() => {
        treeKillCompleted = true
        killer.emit('close', 0)
      })
      return killer
    },
  })
  await assert.rejects(runner(['check'], {
    env: {
      NORMAL_VALUE: 'retained',
      SYGSHIFT_RELEASE_CANARY_PASSWORD: 'must-not-leak',
    },
    timeoutMs: 5,
  }), /timed out/)
  assert.equal(treeKillCalls.length, 1)
  assert.equal(treeKillCompleted, true)
  assert.equal(treeKillCalls[0].command, 'taskkill.exe')
  assert.deepEqual(treeKillCalls[0].arguments_, ['/PID', '4321', '/T', '/F'])
  assert.equal(treeKillCalls[0].options.shell, false)
  assert.equal(treeKillCalls[0].options.env.NORMAL_VALUE, 'retained')
  assert.equal('SYGSHIFT_RELEASE_CANARY_PASSWORD' in treeKillCalls[0].options.env, false)
})

function windowsTimeoutRunner(treeKillSpawn, overrides = {}) {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let directKillCalls = 0
  child.kill = () => {
    directKillCalls += 1
    return true
  }
  const runner = createCommandRunner({
    packageManagerCli: () => 'C:/tools/pnpm.cjs',
    platform: 'win32',
    spawn: () => child,
    treeKillSpawn,
    ...overrides,
  })
  return { directKillCalls: () => directKillCalls, runner }
}

async function assertTerminationUnconfirmed(runner) {
  await assert.rejects(
    runner(['check'], { timeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof CommandTerminationUnconfirmedError)
      assert.equal(error.code, 'SYGSHIFT_RELEASE_TERMINATION_UNCONFIRMED')
      assert.match(error.message, /termination could not be confirmed; manual release intervention is required/)
      return true
    },
  )
}

test('requires manual intervention when the Windows tree-kill process emits a spawn error', async () => {
  const harness = windowsTimeoutRunner(() => {
    const killer = new EventEmitter()
    queueMicrotask(() => killer.emit('error', new Error('taskkill unavailable')))
    return killer
  })
  await assertTerminationUnconfirmed(harness.runner)
  assert.equal(harness.directKillCalls(), 1)
})

test('requires manual intervention when Windows tree-kill exits nonzero', async () => {
  const harness = windowsTimeoutRunner(() => {
    const killer = new EventEmitter()
    queueMicrotask(() => killer.emit('close', 1))
    return killer
  })
  await assertTerminationUnconfirmed(harness.runner)
  assert.equal(harness.directKillCalls(), 1)
})

test('requires manual intervention when Windows tree-kill exceeds its own deadline', async () => {
  const harness = windowsTimeoutRunner(
    () => new EventEmitter(),
    { treeKillTimeoutMs: 5 },
  )
  await assertTerminationUnconfirmed(harness.runner)
  assert.equal(harness.directKillCalls(), 1)
})

test('identifies one uploaded version and extracts a safe Version URL', () => {
  assert.equal(identifyUploadedVersion([priorVersionId], [priorVersionId, candidateVersionId]), candidateVersionId)
  assert.throws(() => identifyUploadedVersion([priorVersionId], [priorVersionId]), /unambiguously/)
  assert.equal(extractVersionUrl('Preview: https://release-sygshift.example.workers.dev/'), 'https://release-sygshift.example.workers.dev')
})

test('rejects invalid post-promotion verification windows before probing production', async () => {
  await assert.rejects(runProductionRelease(releaseOptions({ maximumProbeAttempts: 1 })), /at least two probe attempts/)
  await assert.rejects(runProductionRelease(releaseOptions({
    maximumProbeAttempts: 2,
    postPromotionPasses: 3,
  })), /pass count must fit/)
  await assert.rejects(runProductionRelease(releaseOptions({ probeDelayMs: -1 })), /probe delay/)
})

test('requires an exact maintenance window ID for coordinated release mode', async () => {
  await assert.rejects(
    runProductionRelease(releaseOptions({ maintenanceCoordinated: true })),
    /requires one exact maintenance window ID/,
  )
  await assert.rejects(
    runProductionRelease(releaseOptions({
      maintenanceCoordinated: true,
      maintenanceWindowId: 'not-a-uuid',
    })),
    /must be a UUID/,
  )
  await assert.rejects(
    runProductionRelease(releaseOptions({ maintenanceWindowId })),
    /requires one exact maintenance window ID/,
  )
  await assert.rejects(
    runProductionRelease(releaseOptions({
      dryRun: true,
      maintenanceCoordinated: true,
      maintenanceWindowId,
    })),
    /only for a live release/,
  )
})

test('stops before build or upload when the baseline shows a provider outage', async () => {
  const harness = commandHarness()
  const fetch = healthyFetch({
    'https://project.supabase.co/auth/v1/health': () => new Response(null, { status: 503 }),
  })
  const result = await runProductionRelease(releaseOptions(), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.providerOutage)
  assert.equal(result.promoted, false)
  assert.deepEqual(harness.calls, [])
})

test('refuses to release a dirty or unpushed source tree', async () => {
  const harness = commandHarness()
  const run = async (arguments_) => {
    if (arguments_.join(' ').includes('git status')) {
      harness.calls.push(arguments_)
      return { stderr: '', stdout: ' M worker/index.ts\n' }
    }
    return harness.run(arguments_)
  }
  await assert.rejects(
    runProductionRelease(releaseOptions(), {
      fetch: healthyFetch(),
      run,
      sleep: async () => undefined,
    }),
    /clean working tree/,
  )
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('wrangler')), false)
})

test('blocks the normal release path when wrangler.jsonc differs from HEAD', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('git diff')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return { stderr: '', stdout: 'diff --git a/wrangler.jsonc b/wrangler.jsonc\n' }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(
    runProductionRelease(releaseOptions(), {
      fetch: healthyFetch(),
      run,
      sleep: async () => undefined,
    }),
    /documented lifecycle\/config release path/,
  )
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('wrangler')), false)
})

test('blocks the normal release path when wrangler.jsonc changed since the deployed source commit', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    const command = arguments_.join(' ')
    if (command.includes('git diff') && command.includes(`${priorSourceCommit} HEAD`)) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return { stderr: '', stdout: 'diff --git a/wrangler.jsonc b/wrangler.jsonc\n' }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(
    runProductionRelease(releaseOptions(), {
      fetch: healthyFetch(),
      run,
      sleep: async () => undefined,
    }),
    /changed after the deployed Worker source commit/,
  )
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('upload')), false)
})

test('fails closed when the deployed version is missing its source commit tag', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('versions view')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return { stderr: '', stdout: JSON.stringify({ annotations: {}, id: priorVersionId }) }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /missing a valid source-<commit> tag/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('upload')), false)
})

test('fails closed when the deployed source commit is not an ancestor of HEAD', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('git merge-base')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return { stderr: '', stdout: `${releaseCommit}\n` }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /not an ancestor of HEAD/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('upload')), false)
})

test('rechecks the working tree after local gates and blocks a mid-gate edit before upload', async () => {
  const harness = commandHarness()
  let statusChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('git status')) {
      statusChecks += 1
      if (statusChecks === 2) {
        harness.calls.push(arguments_)
        harness.options.push(options)
        return { stderr: '', stdout: ' M worker/index.ts\n' }
      }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /clean working tree/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('upload')), false)
})

test('rechecks exact HEAD after local gates and blocks a changed source commit before upload', async () => {
  const harness = commandHarness()
  const changedCommit = 'c'.repeat(40)
  let fetches = 0
  const run = async (arguments_, options) => {
    const command = arguments_.join(' ')
    if (command.includes('git fetch')) fetches += 1
    if (command.includes('git rev-parse') && fetches >= 2) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return { stderr: '', stdout: `${changedCommit}\n` }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /source commit changed during the release gate/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('upload')), false)
})

test('does not promote an uploaded candidate when origin/main advances during candidate verification', async () => {
  const harness = commandHarness()
  let fetches = 0
  const run = async (arguments_, options) => {
    const command = arguments_.join(' ')
    if (command.includes('git fetch')) fetches += 1
    if (command.includes('git rev-parse origin/main') && fetches >= 3) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return { stderr: '', stdout: 'cccccccccccccccccccccccccccccccccccccccc\n' }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /must exactly match origin\/main/)
  const commands = harness.calls.map((arguments_) => arguments_.join(' '))
  assert.ok(commands.some((command) => command.includes('versions upload')))
  assert.ok(!commands.some((command) => command.includes('versions deploy')))
})

test('requires the production root URL to return the SygShift HTML shell', async () => {
  const harness = commandHarness()
  const result = await runProductionRelease(releaseOptions(), {
    fetch: healthyFetch({
      'https://app.example.com/': () => new Response('Access check', {
        headers: { 'content-type': 'text/html' },
        status: 200,
      }),
    }),
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.promoted, false)
  assert.deepEqual(harness.calls, [])
})

test('uploads then explicitly promotes the identified candidate after a healthy baseline', async () => {
  const harness = commandHarness()
  const result = await runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.candidateVersionId, candidateVersionId)
  assert.equal(result.priorSourceCommit, priorSourceCommit)
  assert.equal(result.priorVersionId, priorVersionId)
  assert.equal(result.sourceCommit, releaseCommit)
  assert.equal(result.rolledBack, false)
  assert.equal(result.upstreamProbeCount, 2)
  assert.deepEqual(result.candidatePreview, {
    available: false,
    checked: false,
    reason: 'wrangler_did_not_return_version_url',
  })
  const commands = harness.calls.map((arguments_) => arguments_.join(' '))
  assert.ok(commands.some((command) => command.includes('versions upload')))
  assert.ok(commands.some((command) => command.includes(`--tag source-${releaseCommit}`)))
  assert.ok(commands.some((command) => command.includes(`--var SYGSHIFT_SOURCE_COMMIT:${releaseCommit}`)))
  assert.ok(commands.some((command) => command.includes(`versions deploy ${candidateVersionId}@100%`)))
  const playwrightIndex = commands.findIndex((command) => command === 'test:e2e:time-clock')
  const finalBuildIndex = commands.findLastIndex((command) => command === 'build')
  assert.ok(playwrightIndex >= 0 && finalBuildIndex > playwrightIndex)
  assert.ok(!commands.some((command) => command.includes('wrangler deploy ')))
})

test('blocks a coordinated promotion when Wrangler does not return a candidate Version URL', async () => {
  const harness = commandHarness()
  const fallbackFetch = maintenanceHealthyFetch()
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch: async (input) => {
      if (String(input) === 'https://app.example.com/api/v1/ready') {
        return jsonResponse(maintenanceReadinessPayload(), 503)
      }
      return fallbackFetch(input)
    },
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.badCandidate)
  assert.equal(result.promoted, false)
  assert.equal(result.versionUrlAvailable, false)
  assert.equal(result.candidatePreview.reason, 'required_for_coordinated_release')
  assert.equal(harness.calls.some((arguments_) => arguments_.join(' ').includes('versions deploy')), false)
})

test('blocks a coordinated promotion when the candidate Version URL probe fails', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fallbackFetch = maintenanceHealthyFetch({
    [`${maintenanceCandidateOrigin}/api/v1/health`]: () => jsonResponse({ status: 'degraded' }, 503),
  })
  const fetch = async (input) => {
    if (String(input) === 'https://app.example.com/api/v1/ready') {
      return jsonResponse(maintenanceReadinessPayload(), 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.badCandidate)
  assert.equal(result.promoted, false)
  assert.equal(result.versionUrlAvailable, true)
  assert.deepEqual(result.candidatePreview, { available: true, checked: true })
  assert.equal(harness.calls.some((arguments_) => arguments_.join(' ').includes('versions deploy')), false)
})

test('keeps the exact candidate under verified maintenance until normal cron proof returns', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  let readinessChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      const row = maintenanceReads <= 3
        ? maintenanceWindowRow()
        : maintenanceWindowRow({
          server_time: '2026-10-25T02:00:01.000Z',
          status: 'completed',
        })
      return { stderr: '', stdout: JSON.stringify({ rows: [row] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      if (readinessChecks <= 3) return jsonResponse(maintenanceReadinessPayload(), 503)
      const lastFullSuccessAt = new Date(Date.UTC(2026, 9, 25, 2, 1, readinessChecks)).toISOString()
      return jsonResponse(readinessPayload({
        scheduledRuntime: {
          consecutiveFailures: 0,
          lastFullSuccessAt,
          lastFullSuccessSourceCommit: releaseCommit,
          lastSuccessAt: lastFullSuccessAt,
          mode: 'closed',
        },
      }))
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 10,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.rolledBack, false)
  assert.equal(result.coordinatedMaintenance.cleared, true)
  assert.equal(result.coordinatedMaintenance.attempts, 2)
  assert.equal(maintenanceReads, 4)
  assert.equal(result.upstreamProbeCount, 3)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('bounds the coordinated maintenance wait by elapsed wall-clock time', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  let nowCalls = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    if (String(input) === 'https://app.example.com/api/v1/ready') {
      return jsonResponse(maintenanceReadinessPayload(), 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 10,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => {
      nowCalls += 1
      return nowCalls === 1 ? 0 : 20
    },
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
  assert.equal(result.coordinatedMaintenance.timedOut, true)
  assert.equal(result.coordinatedMaintenance.attempts, 0)
  assert.equal(result.coordinatedMaintenance.maintenanceActiveProven, true)
  assert.equal(result.coordinatedMaintenance.observedActiveMaintenance, true)
  assert.equal(result.coordinatedMaintenance.rollbackMaintenanceProof, 'fresh_exact_reread')
  assert.equal(maintenanceReads, 3)
})

test('leaves the exact candidate active when a timed-out wait cannot freshly prove maintenance remains active', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  let nowCalls = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      const row = maintenanceReads <= 2
        ? maintenanceWindowRow()
        : maintenanceWindowRow({
          server_time: '2026-10-25T02:00:01.000Z',
          status: 'completed',
        })
      return { stderr: '', stdout: JSON.stringify({ rows: [row] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    if (String(input) === 'https://app.example.com/api/v1/ready') {
      return jsonResponse(maintenanceReadinessPayload(), 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 10,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => {
      nowCalls += 1
      return nowCalls === 1 ? 0 : 20
    },
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.manualIntervention)
  assert.equal(result.manualInterventionRequired, true)
  assert.equal(result.rolledBack, false)
  assert.equal(result.coordinatedMaintenance.timedOut, true)
  assert.equal(maintenanceReads, 3)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('refuses promotion when the pre-promotion scheduler stamp is not the exact prior SHA', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let readinessChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    if (String(input) === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      const payload = readinessChecks === 2
        ? maintenanceReadinessPayload({
          scheduledRuntime: { lastFullSuccessSourceCommit: 'c'.repeat(40) },
        })
        : maintenanceReadinessPayload()
      return jsonResponse(payload, 503)
    }
    return fallbackFetch(input)
  }

  await assert.rejects(runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  }), /became unhealthy before promotion/)
  assert.equal(harness.calls.some((arguments_) => arguments_.join(' ').includes('versions deploy')), false)
})

test('leaves the exact candidate active when maintenance proof becomes unreadable after promotion', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      if (maintenanceReads >= 3) throw new Error('maintenance lookup unavailable')
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/ready') {
      return jsonResponse(maintenanceReadinessPayload(), 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 20,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.manualIntervention)
  assert.equal(result.manualInterventionRequired, true)
  assert.equal(result.rolledBack, false)
  assert.equal(result.coordinatedMaintenance.maintenanceReadFailed, true)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('rolls back when unrelated Worker configuration fails during coordinated maintenance', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  let readinessChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      const payload = readinessChecks === 3 || readinessChecks === 4
        ? maintenanceReadinessPayload({ checks: { supabaseServiceRoleKey: false } })
        : maintenanceReadinessPayload()
      return jsonResponse(payload, 503)
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 20,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
  assert.equal(result.rollbackVerified, true)
  assert.equal(result.coordinatedMaintenance.releaseLocalFailureObserved, true)
  assert.equal(maintenanceReads, 5)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), true)
})

test('requires the exact prior source stamp when verifying an active-maintenance rollback', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let readinessChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      if (readinessChecks === 3 || readinessChecks === 4) {
        return jsonResponse(
          maintenanceReadinessPayload({ checks: { supabaseServiceRoleKey: false } }),
          503,
        )
      }
      const payload = readinessChecks >= 5
        ? maintenanceReadinessPayload({
          scheduledRuntime: { lastFullSuccessSourceCommit: releaseCommit },
        })
        : maintenanceReadinessPayload()
      return jsonResponse(payload, 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 20,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
  assert.equal(result.rollbackVerified, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), true)
})

test('treats persistent maintenance Worker faults as local even during an upstream outage', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let authChecks = 0
  let readinessChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      return { stderr: '', stdout: JSON.stringify({ rows: [maintenanceWindowRow()] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks === 2 || authChecks === 3) return new Response(null, { status: 503 })
    }
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      const payload = readinessChecks === 3 || readinessChecks === 4
        ? maintenanceReadinessPayload({ checks: { supabaseServiceRoleKey: false } })
        : maintenanceReadinessPayload()
      return jsonResponse(payload, 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 20,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
  assert.equal(result.rollbackVerified, true)
  assert.equal(result.coordinatedMaintenance.releaseLocalFailureObserved, true)
})

test('leaves the exact candidate active when maintenance is already inactive at the first post-promotion read', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      const row = maintenanceReads <= 2
        ? maintenanceWindowRow()
        : maintenanceWindowRow({
          server_time: '2026-10-25T02:00:01.000Z',
          status: 'completed',
        })
      return { stderr: '', stdout: JSON.stringify({ rows: [row] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    if (String(input) === 'https://app.example.com/api/v1/ready') {
      return jsonResponse(maintenanceReadinessPayload(), 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 5,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.manualIntervention)
  assert.equal(result.manualInterventionRequired, true)
  assert.equal(result.coordinatedMaintenance.cleared, false)
  assert.equal(result.coordinatedMaintenance.cutoverProofLost, true)
  assert.equal(result.coordinatedMaintenance.observedActiveMaintenance, false)
  assert.equal(result.rolledBack, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('leaves the exact candidate active when strict proof fails after an observed maintenance close', async () => {
  const harness = commandHarness({ versionUrl: maintenanceCandidateOrigin })
  const fallbackFetch = maintenanceHealthyFetch()
  let maintenanceReads = 0
  const run = async (arguments_, options) => {
    if (arguments_[0] === 'dlx' && arguments_.includes('supabase@2.121.0')) {
      maintenanceReads += 1
      const row = maintenanceReads <= 3
        ? maintenanceWindowRow()
        : maintenanceWindowRow({
          server_time: '2026-10-25T02:00:01.000Z',
          status: 'completed',
        })
      return { stderr: '', stdout: JSON.stringify({ rows: [row] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    if (String(input) === 'https://app.example.com/api/v1/ready') {
      return jsonResponse(maintenanceReadinessPayload(), 503)
    }
    return fallbackFetch(input)
  }

  const result = await runProductionRelease(releaseOptions({
    maintenanceCoordinated: true,
    maintenanceMaximumWaitMs: 20,
    maintenancePollDelayMs: 1,
    maintenanceRecoveryProbeAttempts: 3,
    maintenanceWindowId,
    tag: 'stability-durability-20261024',
  }), {
    fetch,
    now: () => 0,
    run,
    sleep: async () => undefined,
  })

  assert.equal(result.outcome, releaseOutcomes.manualIntervention)
  assert.equal(result.manualInterventionRequired, true)
  assert.equal(result.coordinatedMaintenance.cleared, true)
  assert.equal(result.coordinatedMaintenance.observedActiveMaintenance, true)
  assert.equal(result.rolledBack, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('rejects a failed candidate Version URL before promotion', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    const result = await harness.run(arguments_, options)
    if (arguments_.includes('upload') && !arguments_.includes('--dry-run')) {
      return { stderr: '', stdout: 'Version URL: https://candidate-sygshift.example.workers.dev' }
    }
    return result
  }
  const fetch = healthyFetch({
    'https://candidate-sygshift.example.workers.dev/': () => new Response('not the application shell', {
      headers: { 'content-type': 'text/plain' },
      status: 200,
    }),
  })
  const result = await runProductionRelease(releaseOptions(), {
    fetch,
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badCandidate)
  assert.equal(result.priorSourceCommit, priorSourceCommit)
  assert.equal(result.promoted, false)
  assert.deepEqual(result.candidatePreview, { available: true, checked: true })
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('deploy')), false)
})

test('promotes a candidate whose preview readiness is degraded only by the shared scheduler source stamp', async () => {
  const origin = 'https://candidate-sygshift.example.workers.dev'
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    const result = await harness.run(arguments_, options)
    if (arguments_.includes('upload') && !arguments_.includes('--dry-run')) {
      return { stderr: '', stdout: `Version URL: ${origin}` }
    }
    return result
  }
  const fetch = healthyFetch({
    [`${origin}/api/v1/ready`]: () => jsonResponse(readinessPayload({
      checks: { scheduledRuntimeFresh: false },
      ready: false,
      scheduledRuntime: { lastFullSuccessSourceCommit: priorSourceCommit },
      status: 'degraded',
    }), 503),
  })

  const preview = await probeCandidateWorker(origin, releaseCommit, { fetch })
  const result = await runProductionRelease(releaseOptions(), {
    fetch,
    run,
    sleep: async () => undefined,
  })

  assert.equal(preview.ok, true)
  assert.equal(preview.readiness.status, 503)
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.promoted, true)
  assert.deepEqual(result.candidatePreview, { available: true, checked: true })
  assert.ok(harness.calls.some((arguments_) => arguments_.join(' ').includes(`versions deploy ${candidateVersionId}@100%`)))
})

test('rejects before promotion when candidate preview readiness has missing configuration', async () => {
  const origin = 'https://candidate-sygshift.example.workers.dev'
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    const result = await harness.run(arguments_, options)
    if (arguments_.includes('upload') && !arguments_.includes('--dry-run')) {
      return { stderr: '', stdout: `Version URL: ${origin}` }
    }
    return result
  }
  const fetch = healthyFetch({
    [`${origin}/api/v1/ready`]: () => jsonResponse(readinessPayload({
      checks: {
        scheduledRuntimeFresh: false,
        supabaseServiceRoleKey: false,
      },
      ready: false,
      status: 'misconfigured',
    }), 503),
  })

  const preview = await probeCandidateWorker(origin, releaseCommit, { fetch })
  const result = await runProductionRelease(releaseOptions(), {
    fetch,
    run,
    sleep: async () => undefined,
  })

  assert.equal(preview.ok, false)
  assert.equal(preview.delivery.ok, true)
  assert.equal(preview.health.ok, true)
  assert.equal(preview.readiness.ok, false)
  assert.equal(preview.readiness.status, 503)
  assert.equal(result.outcome, releaseOutcomes.badCandidate)
  assert.equal(result.promoted, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.join(' ').includes('versions deploy')), false)
})

test('keeps candidate preview fail-closed for malformed readiness and failed health delivery', async () => {
  const origin = 'https://candidate-sygshift.example.workers.dev'
  const validDegradedReadiness = readinessPayload({
    checks: { scheduledRuntimeFresh: false },
    ready: false,
    scheduledRuntime: { lastFullSuccessSourceCommit: priorSourceCommit },
    status: 'degraded',
  })
  const malformed = await probeCandidateWorker(origin, releaseCommit, {
    fetch: healthyFetch({
      [`${origin}/api/v1/ready`]: () => new Response('{', {
        headers: { 'content-type': 'application/json' },
        status: 503,
      }),
    }),
  })
  const unhealthy = await probeCandidateWorker(origin, releaseCommit, {
    fetch: healthyFetch({
      [`${origin}/api/v1/health`]: () => jsonResponse({ status: 'degraded' }, 503),
      [`${origin}/api/v1/ready`]: () => jsonResponse(validDegradedReadiness, 503),
    }),
  })

  assert.equal(malformed.ok, false)
  assert.equal(malformed.readiness.error, 'invalid_json')
  assert.equal(unhealthy.ok, false)
  assert.equal(unhealthy.delivery.ok, false)
  assert.equal(unhealthy.health.ok, false)
})

test('rejects an open or recovering scheduler as a candidate preview warmup', async () => {
  const origin = 'https://candidate-sygshift.example.workers.dev'
  for (const mode of ['open', 'recovering']) {
    const result = await probeCandidateWorker(origin, releaseCommit, {
      fetch: healthyFetch({
        [`${origin}/api/v1/ready`]: () => jsonResponse(readinessPayload({
          checks: { scheduledRuntimeFresh: false },
          ready: false,
          scheduledRuntime: {
            lastFullSuccessSourceCommit: priorSourceCommit,
            mode,
          },
          status: 'degraded',
        }), 503),
      }),
    })

    assert.equal(result.ok, false, `${mode} must not be accepted as candidate warmup`)
    assert.equal(result.readiness.ok, false)
  }
})

test('does not promote when production changes after the prior version is captured', async () => {
  const harness = commandHarness()
  let statusChecks = 0
  const run = async (arguments_) => {
    if (arguments_.join(' ').includes('deployments status')) {
      statusChecks += 1
      if (statusChecks === 2) {
        harness.calls.push(arguments_)
        return {
          stderr: '',
          stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: concurrentVersionId }] }),
        }
      }
    }
    return harness.run(arguments_)
  }
  await assert.rejects(
    runProductionRelease(releaseOptions(), {
      fetch: healthyFetch(),
      run,
      sleep: async () => undefined,
    }),
    /Production changed during the release/,
  )
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('deploy')), false)
})

test('rolls back the exact prior version only when Worker checks fail and upstream remains healthy', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let productionHealthChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      productionHealthChecks += 1
      if (productionHealthChecks > 2 && productionHealthChecks <= 4) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 3 }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
  const rollback = harness.calls.find((arguments_) => arguments_.includes('rollback'))
  assert.ok(rollback)
  assert.ok(rollback.includes(priorVersionId))
  assert.ok(!rollback.includes(candidateVersionId))
})

test('does not roll back a readiness-only degradation when upstream fails after promotion', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let authChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks > 1) return new Response(null, { status: 503 })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.providerOutage)
  assert.equal(result.promoted, true)
  assert.equal(result.rolledBack, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('does not report a provider outage if a third version becomes active during verification', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let providerOutageObserved = false
  let authChecks = 0
  const run = async (arguments_, options) => {
    if (providerOutageObserved && arguments_.join(' ').includes('deployments status')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return {
        stderr: '',
        stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: concurrentVersionId }] }),
      }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks > 1) {
        providerOutageObserved = true
        return new Response(null, { status: 503 })
      }
    }
    return fallbackFetch(input)
  }
  await assert.rejects(runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  }), /Production changed during release verification; manual release intervention is required/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('does not report a provider outage if the prior version becomes active during verification', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let providerOutageObserved = false
  let authChecks = 0
  const run = async (arguments_, options) => {
    if (providerOutageObserved && arguments_.join(' ').includes('deployments status')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return {
        stderr: '',
        stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: priorVersionId }] }),
      }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks > 1) {
        providerOutageObserved = true
        return new Response(null, { status: 503 })
      }
    }
    return fallbackFetch(input)
  }
  await assert.rejects(runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  }), /Production changed during release verification; manual release intervention is required/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('rolls back a persistent Worker health failure early even when upstream is also unavailable', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let authChecks = 0
  let healthChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks > 1) return new Response(null, { status: 503 })
    }
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 76 }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.probeAttempts, 2)
  assert.equal(result.rolledBack, true)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), true)
})

test('does not latch a transient delivery failure into rollback after a provider outage', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let authChecks = 0
  let healthChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks >= 3) return new Response(null, { status: 503 })
    }
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks === 3) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 3 }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.providerOutage)
  assert.equal(result.rolledBack, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('resets readiness-only rollback evidence after a later upstream outage', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  const baselineSuccessAt = '2026-10-19T12:00:00.000Z'
  let authChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks >= 4) return new Response(null, { status: 503 })
    }
    if (url === 'https://app.example.com/api/v1/ready') {
      return jsonResponse({
        checks: { scheduledRuntimeFresh: true },
        ready: true,
        scheduledRuntime: {
          lastFullSuccessAt: baselineSuccessAt,
          lastFullSuccessSourceCommit: releaseCommit,
          lastSuccessAt: baselineSuccessAt,
        },
      })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    maximumProbeAttempts: 4,
    upstreamProbeIntervalMs: 1,
  }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.providerOutage)
  assert.equal(result.rolledBack, false)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('rolls back when upstream recovers twice while the promoted Worker remains bad', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let authChecks = 0
  let productionHealthChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') {
      authChecks += 1
      if (authChecks === 2) return new Response(null, { status: 503 })
    }
    if (url === 'https://app.example.com/api/v1/health') {
      productionHealthChecks += 1
      if (productionHealthChecks > 2) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 3 }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), true)
})

test('waits for scheduled runtime success to advance beyond the pre-promotion value', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  const baseline = '2026-10-19T12:00:00.000Z'
  const before = '2026-10-19T12:00:30.000Z'
  const after = '2026-10-19T12:01:00.000Z'
  let readinessChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      const lastFullSuccessAt = readinessChecks === 1
        ? baseline
        : readinessChecks === 2
          ? before
          : readinessChecks === 3
          ? null
          : readinessChecks === 4
            ? before
            : after
      return jsonResponse({
        checks: { scheduledRuntimeFresh: true },
        ready: true,
        scheduledRuntime: {
          lastFullSuccessAt,
          lastFullSuccessSourceCommit: readinessChecks <= 2 ? priorSourceCommit : releaseCommit,
          lastSuccessAt: lastFullSuccessAt,
        },
      })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    maximumProbeAttempts: 4,
    upstreamProbeIntervalMs: 1,
  }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.probeAttempts, 4)
  assert.equal(result.scheduledRuntimeFullSuccessAdvancedFrom, before)
  assert.equal(result.scheduledRuntimeFullSuccessAt, after)
  assert.equal(result.scheduledRuntimeFullSuccessSourceCommit, releaseCommit)
  assert.ok(result.upstreamProbeCount >= 2)
})

test('requires full scheduler success to report the exact promoted source commit', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let readinessChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      const lastFullSuccessAt = new Date(Date.UTC(2026, 9, 19, 12, 0, readinessChecks)).toISOString()
      return jsonResponse({
        checks: { scheduledRuntimeFresh: true },
        ready: true,
        scheduledRuntime: {
          lastFullSuccessAt,
          lastFullSuccessSourceCommit: priorSourceCommit,
          lastSuccessAt: lastFullSuccessAt,
        },
      })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rolledBack, true)
})

test('waits for a healthy Worker and fresh upstream sample after an early delivery failure', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let healthChecks = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks === 3) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    maximumProbeAttempts: 4,
    upstreamProbeIntervalMs: 30_000,
  }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.probeAttempts, 4)
  assert.equal(result.upstreamProbeCount, 2)
})

test('bounds upstream canary traffic while allowing a full 150 second cron window', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  const unchangedSuccessAt = '2026-10-19T12:00:00.000Z'
  const sleeps = []
  let authChecks = 0
  let readinessChecks = 0
  let tokenGrants = 0
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://project.supabase.co/auth/v1/health') authChecks += 1
    if (url.includes('/auth/v1/token')) {
      tokenGrants += 1
      return jsonResponse({ access_token: 'bounded-test-token' })
    }
    if (url.includes('/rest/v1/rpc/get_session_context')) return jsonResponse({ username: 'release_canary' })
    if (url.includes('/rest/v1/rpc/get_required_action_checkpoint')) return jsonResponse({ items: [] })
    if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 })
    if (url === 'https://app.example.com/api/v1/ready') {
      readinessChecks += 1
      return jsonResponse({
        checks: { scheduledRuntimeFresh: true },
        ready: true,
        scheduledRuntime: {
          lastFullSuccessAt: unchangedSuccessAt,
          lastFullSuccessSourceCommit: releaseCommit,
          lastSuccessAt: unchangedSuccessAt,
        },
      })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    canaryEmail: 'release-canary@example.com',
    canaryPassword: 'not-logged',
    expectedCanaryUsername: 'release_canary',
    maximumProbeAttempts: undefined,
    postPromotionPasses: undefined,
    probeDelayMs: undefined,
  }), {
    fetch,
    run: harness.run,
    sleep: async (milliseconds) => { sleeps.push(milliseconds) },
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.probeAttempts, 76)
  assert.equal(result.upstreamProbeCount, 6)
  assert.equal(sleeps.filter((milliseconds) => milliseconds === 2_000).slice(0, 75)
    .reduce((sum, milliseconds) => sum + milliseconds, 0), 150_000)
  assert.ok(readinessChecks >= 76)
  assert.ok(authChecks <= 8)
  assert.ok(tokenGrants <= 8)
  assert.equal(tokenGrants, authChecks)
  assert.ok(readinessChecks > authChecks * 8)
})

test('reconciles a promotion timeout that applied the candidate and rolls back a bad release', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let healthChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('versions deploy')) {
      await harness.run(arguments_, options)
      throw new Error('client timed out after server applied promotion')
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2 && healthChecks <= 4) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.promotionAmbiguous, true)
  assert.equal(result.rolledBack, true)
  assert.ok(harness.calls.find((arguments_) => arguments_.includes('rollback'))?.includes(priorVersionId))
})

test('reports that promotion was not applied when the deploy command fails and prior remains active', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('versions deploy')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      throw new Error('promotion request failed before reaching the server')
    }
    return harness.run(arguments_, options)
  }
  const result = await runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.promotionNotApplied)
  assert.equal(result.promoted, false)
  assert.equal(result.promotionAmbiguous, true)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('does not reconcile an unconfirmed applied promotion into release success', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('versions deploy')) {
      await harness.run(arguments_, options)
      throw new CommandTerminationUnconfirmedError()
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /termination could not be confirmed; manual release intervention is required/)
  assert.equal(
    harness.calls.filter((arguments_) => arguments_.join(' ').includes('deployments status')).length,
    2,
  )
})

test('does not reconcile an unconfirmed unapplied promotion into promotion-not-applied', async () => {
  const harness = commandHarness()
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('versions deploy')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      throw new CommandTerminationUnconfirmedError()
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /termination could not be confirmed; manual release intervention is required/)
  assert.equal(
    harness.calls.filter((arguments_) => arguments_.join(' ').includes('deployments status')).length,
    2,
  )
})

test('reconciles an intermittent production status read after promotion', async () => {
  const harness = commandHarness()
  let statusChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('deployments status')) {
      statusChecks += 1
      if (statusChecks === 3) {
        harness.calls.push(arguments_)
        harness.options.push(options)
        throw new Error('temporary status read failure')
      }
    }
    return harness.run(arguments_, options)
  }
  const result = await runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.promotionAmbiguous, true)
  assert.equal(result.promotionStatusReadErrors, true)
})

test('waits through early prior-version reads when a promotion applies after propagation delay', async () => {
  const harness = commandHarness()
  let statusChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('deployments status')) {
      statusChecks += 1
      if (statusChecks === 3 || statusChecks === 4) {
        harness.calls.push(arguments_)
        harness.options.push(options)
        return {
          stderr: '',
          stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: priorVersionId }] }),
        }
      }
    }
    return harness.run(arguments_, options)
  }
  const result = await runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.released)
  assert.equal(result.promotionReconciliationAttempts, 4)
})

test('fails explicitly when reconciliation finds an unexpected active production version', async () => {
  const harness = commandHarness()
  let statusChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('deployments status')) {
      statusChecks += 1
      if (statusChecks === 3) {
        harness.calls.push(arguments_)
        harness.options.push(options)
        return {
          stderr: '',
          stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: concurrentVersionId }] }),
        }
      }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /unexpected Worker version; manual release reconciliation is required/)
})

test('fails explicitly when production status cannot be read after promotion', async () => {
  const harness = commandHarness()
  let statusChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.join(' ').includes('deployments status')) {
      statusChecks += 1
      if (statusChecks > 2) {
        harness.calls.push(arguments_)
        harness.options.push(options)
        throw new Error('status endpoint unavailable')
      }
    }
    return harness.run(arguments_, options)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch: healthyFetch(),
    run,
    sleep: async () => undefined,
  }), /Production state could not be reconciled; manual release intervention is required/)
})

test('reconciles a rollback command timeout after the server restored the exact prior version', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let healthChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.includes('rollback')) {
      await harness.run(arguments_, options)
      throw new Error('rollback response timed out after applying')
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2 && healthChecks <= 4) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rollbackCommandFailed, true)
  assert.equal(result.rolledBack, true)
})

test('does not reconcile an unconfirmed rollback-command termination into a completed rollback', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let healthChecks = 0
  const run = async (arguments_, options) => {
    if (arguments_.includes('rollback')) throw new CommandTerminationUnconfirmedError()
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2 && healthChecks <= 4) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  await assert.rejects(runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  }), /termination could not be confirmed; manual release intervention is required/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('waits through early candidate reads while an exact rollback propagates', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let healthChecks = 0
  let rollbackMode = false
  let rollbackStatusChecks = 0
  const run = async (arguments_, options) => {
    const command = arguments_.join(' ')
    if (command.includes('wrangler rollback')) {
      const result = await harness.run(arguments_, options)
      rollbackMode = true
      return result
    }
    if (rollbackMode && command.includes('deployments status')) {
      rollbackStatusChecks += 1
      harness.calls.push(arguments_)
      harness.options.push(options)
      const versionId = rollbackStatusChecks <= 2 ? candidateVersionId : priorVersionId
      return { stderr: '', stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: versionId }] }) }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2 && healthChecks <= 4) return jsonResponse({ status: 'broken' })
    }
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.badRelease)
  assert.equal(result.rollbackReconciliationAttempts, 4)
  assert.equal(result.rolledBack, true)
})

test('refuses to report success if a third version becomes active during verification', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let verificationStarted = false
  let healthChecks = 0
  const run = async (arguments_, options) => {
    if (verificationStarted && arguments_.join(' ').includes('deployments status')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return {
        stderr: '',
        stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: concurrentVersionId }] }),
      }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2) verificationStarted = true
    }
    return fallbackFetch(input)
  }
  await assert.rejects(runProductionRelease(releaseOptions(), {
    fetch,
    run,
    sleep: async () => undefined,
  }), /Production changed during release verification/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('never overwrites a third version that becomes active before rollback', async () => {
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  let verificationStarted = false
  let healthChecks = 0
  const run = async (arguments_, options) => {
    if (verificationStarted && arguments_.join(' ').includes('deployments status')) {
      harness.calls.push(arguments_)
      harness.options.push(options)
      return {
        stderr: '',
        stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: concurrentVersionId }] }),
      }
    }
    return harness.run(arguments_, options)
  }
  const fetch = async (input) => {
    const url = String(input)
    if (url === 'https://app.example.com/api/v1/health') {
      healthChecks += 1
      if (healthChecks > 2) {
        verificationStarted = true
        return jsonResponse({ status: 'broken' })
      }
    }
    return fallbackFetch(input)
  }
  await assert.rejects(runProductionRelease(releaseOptions({ maximumProbeAttempts: 2 }), {
    fetch,
    run,
    sleep: async () => undefined,
  }), /Production changed before rollback/)
  assert.equal(harness.calls.some((arguments_) => arguments_.includes('rollback')), false)
})

test('dry run performs local gates and Wrangler dry-run without uploading or promoting', async () => {
  const harness = commandHarness()
  const result = await runProductionRelease(releaseOptions({ dryRun: true, rollbackSafe: false }), {
    fetch: healthyFetch(),
    run: harness.run,
    sleep: async () => undefined,
  })
  assert.equal(result.outcome, releaseOutcomes.dryRun)
  const commands = harness.calls.map((arguments_) => arguments_.join(' '))
  assert.ok(commands.some((command) => command.includes('versions upload --dry-run')))
  assert.equal(commands.some((command) => command.includes('versions deploy')), false)
  assert.equal(commands.some((command) => command.includes('rollback')), false)
})

test('does not include canary credentials in results or command arguments', async () => {
  const secret = 'do-not-log-this-password'
  const token = 'temporary-access-token'
  const harness = commandHarness()
  const fallbackFetch = healthyFetch()
  const fetch = async (input) => {
    const url = String(input)
    if (url.includes('/auth/v1/token')) return jsonResponse({ access_token: token })
    if (url.includes('/rest/v1/rpc/get_session_context')) return jsonResponse({ username: 'release_canary' })
    if (url.includes('/rest/v1/rpc/get_required_action_checkpoint')) return jsonResponse({ items: [] })
    if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 })
    return fallbackFetch(input)
  }
  const result = await runProductionRelease(releaseOptions({
    canaryEmail: 'release-canary@example.com',
    canaryPassword: secret,
    environment: {
      NORMAL_RELEASE_VALUE: 'preserved',
      SYGSHIFT_RELEASE_CANARY_EMAIL: 'release-canary@example.com',
      SYGSHIFT_RELEASE_CANARY_PASSWORD: secret,
      SYGSHIFT_RELEASE_CANARY_USERNAME: 'release_canary',
    },
    expectedCanaryUsername: 'release_canary',
  }), {
    fetch,
    run: harness.run,
    sleep: async () => undefined,
  })
  const serialized = JSON.stringify({ calls: harness.calls, options: harness.options, result })
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes(token), false)
  assert.equal(harness.options.every((options) => options.env.NORMAL_RELEASE_VALUE === 'preserved'), true)
  assert.equal(harness.options.every((options) => options.timeoutMs === 20 * 60_000), true)
  assert.equal(harness.options.every((options) => (
    Object.keys(options.env).every((key) => !key.toUpperCase().startsWith('SYGSHIFT_RELEASE_'))
  )), true)
  assert.equal(result.outcome, releaseOutcomes.released)
})

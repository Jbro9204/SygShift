import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLifecycleBootstrapArguments } from './deploy-lifecycle-bootstrap.mjs'
import {
  lifecycleDeploymentOutcomes,
  runLifecycleBootstrapDeployment,
} from './lifecycle-bootstrap-core.mjs'
import { CommandTerminationUnconfirmedError } from './production-release-core.mjs'

const sourceCommit = 'a'.repeat(40)
const priorSourceCommit = 'b'.repeat(40)
const priorVersionId = '11111111-1111-4111-8111-111111111111'
const candidateVersionId = '22222222-2222-4222-8222-222222222222'
const concurrentVersionId = '33333333-3333-4333-8333-333333333333'

function lifecycleHarness(overrides = {}) {
  const calls = []
  const commandOptions = []
  let activeVersionId = priorVersionId
  let deploymentStatusChecks = 0
  let statusChecks = 0
  let headChecks = 0
  const control = {
    activeVersion: () => activeVersionId,
    setActiveVersion: (value) => { activeVersionId = value },
  }
  const run = async (arguments_, options_ = {}) => {
    calls.push(arguments_)
    commandOptions.push(options_)
    const joined = arguments_.join(' ')
    if (joined.includes('git status')) {
      statusChecks += 1
      return { stderr: '', stdout: overrides.status?.(statusChecks) ?? '' }
    }
    if (joined.includes('git rev-parse HEAD')) {
      headChecks += 1
      return { stderr: '', stdout: `${overrides.head?.(headChecks) ?? sourceCommit}\n` }
    }
    if (joined.includes('git rev-parse origin/main')) {
      return { stderr: '', stdout: `${overrides.remote?.(headChecks) ?? sourceCommit}\n` }
    }
    if (joined.includes('wrangler deployments status')) {
      deploymentStatusChecks += 1
      if (overrides.deploymentStatus) {
        return overrides.deploymentStatus(deploymentStatusChecks, control)
      }
      return {
        stderr: '',
        stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: activeVersionId }] }),
      }
    }
    if (joined.includes('wrangler versions view')) {
      const versionId = arguments_[4]
      if (overrides.versionView) return overrides.versionView(versionId, control)
      const taggedSource = versionId === candidateVersionId ? sourceCommit : priorSourceCommit
      return {
        stderr: '',
        stdout: JSON.stringify({
          annotations: { 'workers/tag': `source-${taggedSource}` },
          id: versionId,
        }),
      }
    }
    if (joined.includes('wrangler deploy')) {
      if (overrides.deploy) return overrides.deploy(arguments_, control)
      if (!arguments_.includes('--dry-run')) activeVersionId = candidateVersionId
      return { stderr: '', stdout: '' }
    }
    return { stderr: '', stdout: '' }
  }
  return { calls, commandOptions, run }
}

function options(overrides = {}) {
  return {
    cwd: 'C:/repo',
    environment: { PATH: 'safe' },
    message: 'Bootstrap scheduled runtime coordinator',
    reconciliationAttempts: 3,
    reconciliationDelayMs: 0,
    reconciliationPasses: 2,
    ...overrides,
  }
}

test('requires explicit lifecycle confirmation at the command boundary', () => {
  assert.throws(() => parseLifecycleBootstrapArguments([]), /confirm-lifecycle-bootstrap/)
  assert.deepEqual(
    parseLifecycleBootstrapArguments([
      '--',
      '--confirm-lifecycle-bootstrap',
      '--dry-run',
      '--message=Reviewed lifecycle bootstrap',
    ]),
    { confirmed: true, dryRun: true, message: 'Reviewed lifecycle bootstrap' },
  )
})

test('runs the full gate, rechecks source, and atomically deploys the exact commit', async () => {
  const harness = lifecycleHarness()
  const result = await runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined })

  const commands = harness.calls.map((call) => call.join(' '))
  assert.deepEqual(commands, [
    'exec git fetch --quiet origin main',
    'exec git status --porcelain=v1 --untracked-files=all',
    'exec git rev-parse HEAD',
    'exec git rev-parse origin/main',
    'check',
    'exec playwright test tests/e2e/time-clock-workflow.spec.ts',
    'build',
    'exec wrangler deployments status --json --name sygshift',
    'exec git fetch --quiet origin main',
    'exec git status --porcelain=v1 --untracked-files=all',
    'exec git rev-parse HEAD',
    'exec git rev-parse origin/main',
    'exec wrangler deployments status --json --name sygshift',
    `exec wrangler deploy --strict --name sygshift --tag source-${sourceCommit} --message Bootstrap scheduled runtime coordinator --var SYGSHIFT_SOURCE_COMMIT:${sourceCommit}`,
    'exec wrangler deployments status --json --name sygshift',
    `exec wrangler versions view ${candidateVersionId} --json --name sygshift`,
    'exec wrangler deployments status --json --name sygshift',
    `exec wrangler versions view ${candidateVersionId} --json --name sygshift`,
  ])
  assert.deepEqual(result, {
    activeVersionId: candidateVersionId,
    deployCommandFailed: false,
    deployed: true,
    dryRun: false,
    outcome: lifecycleDeploymentOutcomes.deployed,
    priorVersionId,
    reconciliationAttempts: 2,
    reconciliationStatusReadErrors: false,
    sourceCommit,
    sourceTag: `source-${sourceCommit}`,
    workerName: 'sygshift',
  })
})

test('refuses a dirty checkout before validation', async () => {
  const harness = lifecycleHarness({ status: () => ' M worker/index.ts\n' })
  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run }),
    /clean working tree/,
  )
  assert.equal(harness.calls.some((call) => call.includes('build')), false)
  assert.equal(harness.calls.some((call) => call.join(' ').includes('wrangler deploy ')), false)
})

test('refuses a checkout that does not exactly match origin main', async () => {
  const harness = lifecycleHarness({ remote: () => 'b'.repeat(40) })
  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run }),
    /exactly match origin\/main/,
  )
  assert.equal(harness.calls.some((call) => call.includes('build')), false)
})

test('rechecks cleanliness after the production build and does not deploy dirty output', async () => {
  const harness = lifecycleHarness({ status: (check) => check === 2 ? ' M tracked-output.js\n' : '' })
  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run }),
    /clean working tree/,
  )
  assert.equal(harness.calls.some((call) => call.join(' ').includes('wrangler deploy ')), false)
})

test('refuses a source change during validation', async () => {
  const harness = lifecycleHarness({
    head: (check) => check === 2 ? 'c'.repeat(40) : sourceCommit,
    remote: (check) => check === 2 ? 'c'.repeat(40) : sourceCommit,
  })
  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run }),
    /source changed during validation/,
  )
  assert.equal(harness.calls.some((call) => call.join(' ').includes('wrangler deploy ')), false)
})

test('does not overwrite a concurrent production deployment immediately before lifecycle deploy', async () => {
  const harness = lifecycleHarness({
    deploymentStatus: async (check) => ({
      stderr: '',
      stdout: JSON.stringify({
        versions: [{
          percentage: 100,
          version_id: check === 1 ? priorVersionId : concurrentVersionId,
        }],
      }),
    }),
  })

  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined }),
    /Production changed during lifecycle validation.*not started/,
  )
  assert.equal(
    harness.calls.some((call) => call.join(' ').includes('wrangler deploy ')),
    false,
  )
})

test('dry run preserves the exact source stamp without applying the deployment', async () => {
  const harness = lifecycleHarness()
  const result = await runLifecycleBootstrapDeployment(options({ dryRun: true }), { run: harness.run })
  const deploy = harness.calls.at(-1)
  assert.deepEqual(deploy.slice(-1), ['--dry-run'])
  assert.ok(deploy.includes(`source-${sourceCommit}`))
  assert.ok(deploy.includes(`SYGSHIFT_SOURCE_COMMIT:${sourceCommit}`))
  assert.deepEqual(result, {
    deployed: false,
    dryRun: true,
    outcome: lifecycleDeploymentOutcomes.dryRun,
    priorVersionId,
    sourceCommit,
    sourceTag: `source-${sourceCommit}`,
    workerName: 'sygshift',
  })
})

test('strips release probe credentials from every lifecycle child command', async () => {
  const harness = lifecycleHarness()
  await runLifecycleBootstrapDeployment(options({
    environment: {
      PATH: 'safe',
      SYGSHIFT_RELEASE_CANARY_PASSWORD: 'must-not-leak',
      SYGSHIFT_RELEASE_CANARY_USERNAME: 'must-not-leak',
      SYGSHIFT_RELEASE_SUPABASE_PUBLISHABLE_KEY: 'must-not-leak',
    },
  }), { run: harness.run, sleep: async () => undefined })

  assert.ok(harness.commandOptions.length > 0)
  for (const command of harness.commandOptions) {
    assert.equal(command.env.PATH, 'safe')
    assert.equal(Object.keys(command.env).some((key) => key.startsWith('SYGSHIFT_RELEASE_')), false)
  }
})

test('reconciles a timed-out deploy that completed remotely as deployed', async () => {
  const harness = lifecycleHarness({
    deploy: async (_arguments, control) => {
      control.setActiveVersion(candidateVersionId)
      throw new Error('The release command timed out.')
    },
  })
  const result = await runLifecycleBootstrapDeployment(
    options(),
    { run: harness.run, sleep: async () => undefined },
  )

  assert.equal(result.outcome, lifecycleDeploymentOutcomes.deployed)
  assert.equal(result.deployed, true)
  assert.equal(result.deployCommandFailed, true)
  assert.equal(result.activeVersionId, candidateVersionId)
})

test('returns an explicit not-applied result when a timed-out deploy left the exact prior version active', async () => {
  const harness = lifecycleHarness({
    deploy: async () => { throw new Error('The release command timed out.') },
  })
  const result = await runLifecycleBootstrapDeployment(
    options(),
    { run: harness.run, sleep: async () => undefined },
  )

  assert.equal(result.outcome, lifecycleDeploymentOutcomes.notApplied)
  assert.equal(result.deployed, false)
  assert.equal(result.deployCommandFailed, true)
  assert.equal(result.activeVersionId, priorVersionId)
  assert.equal(result.reconciliationAttempts, 3)
})

test('waits through early prior-version reads when a timed-out lifecycle deployment applies late', async () => {
  const harness = lifecycleHarness({
    deploy: async () => { throw new Error('The release command timed out.') },
    deploymentStatus: async (check, control) => {
      if (check === 5) control.setActiveVersion(candidateVersionId)
      return {
        stderr: '',
        stdout: JSON.stringify({
          versions: [{ percentage: 100, version_id: control.activeVersion() }],
        }),
      }
    },
  })
  const result = await runLifecycleBootstrapDeployment(
    options({ reconciliationAttempts: 5 }),
    { run: harness.run, sleep: async () => undefined },
  )

  assert.equal(result.outcome, lifecycleDeploymentOutcomes.deployed)
  assert.equal(result.activeVersionId, candidateVersionId)
  assert.equal(result.reconciliationAttempts, 4)
})

test('fails closed when deployment reconciliation observes an unexpected third version', async () => {
  const harness = lifecycleHarness({
    deploy: async (_arguments, control) => {
      control.setActiveVersion(concurrentVersionId)
      throw new Error('The release command timed out.')
    },
  })

  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined }),
    /unexpected Worker version.*manual lifecycle deployment reconciliation/,
  )
})

test('fails closed when post-deploy status remains unreadable', async () => {
  const harness = lifecycleHarness({
    deploymentStatus: async (check) => {
      if (check <= 2) {
        return {
          stderr: '',
          stdout: JSON.stringify({ versions: [{ percentage: 100, version_id: priorVersionId }] }),
        }
      }
      throw new Error('Cloudflare status unavailable')
    },
    deploy: async () => { throw new Error('The release command timed out.') },
  })

  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined }),
    /could not be reconciled.*manual intervention/,
  )
})

test('does not deploy when the exact prior active version cannot be captured', async () => {
  const harness = lifecycleHarness({
    deploymentStatus: async () => { throw new Error('Cloudflare status unavailable') },
  })

  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined }),
    /could not be captured.*manual intervention/,
  )
  assert.equal(
    harness.calls.some((call) => call.join(' ').includes('wrangler deploy ')),
    false,
  )
})

test('does not reconcile a timeout whose process-tree termination is unconfirmed', async () => {
  const harness = lifecycleHarness({
    deploy: async () => { throw new CommandTerminationUnconfirmedError() },
  })

  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined }),
    (error) => {
      assert.ok(error instanceof CommandTerminationUnconfirmedError)
      return true
    },
  )
  const statusReads = harness.calls.filter((call) => call.join(' ').includes('deployments status'))
  assert.equal(statusReads.length, 2)
})

test('does not report success when the active version lacks the exact bootstrap source tag', async () => {
  const harness = lifecycleHarness({
    versionView: async (versionId) => ({
      stderr: '',
      stdout: JSON.stringify({
        annotations: { 'workers/tag': `source-${priorSourceCommit}` },
        id: versionId,
      }),
    }),
  })

  await assert.rejects(
    runLifecycleBootstrapDeployment(options(), { run: harness.run, sleep: async () => undefined }),
    /unexpected Worker version.*manual lifecycle deployment reconciliation/,
  )
})

test('rejects multiline audit messages before running any command', async () => {
  const harness = lifecycleHarness()
  await assert.rejects(
    runLifecycleBootstrapDeployment(options({ message: 'line one\nline two' }), { run: harness.run }),
    /must be one line/,
  )
  assert.equal(harness.calls.length, 0)
})

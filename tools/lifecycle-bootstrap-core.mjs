import {
  CommandTerminationUnconfirmedError,
  commandEnvironment,
  createCommandRunner,
  parseCurrentDeployment,
  parseSourceCommitFromVersion,
} from './production-release-core.mjs'

const gitShaPattern = /^[0-9a-f]{40}$/i

export const lifecycleDeploymentOutcomes = Object.freeze({
  deployed: 'deployed',
  dryRun: 'dry_run',
})

class UnexpectedLifecycleVersionError extends Error {}

function isCommandTerminationUnconfirmedError(error) {
  return error instanceof CommandTerminationUnconfirmedError
    || error?.code === 'SYGSHIFT_RELEASE_TERMINATION_UNCONFIRMED'
}

function validatedOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('Lifecycle deployment options are required.')
  if (typeof options.cwd !== 'string' || !options.cwd.trim()) {
    throw new Error('Lifecycle deployment requires a repository directory.')
  }
  const unsafeMessage = typeof options.message === 'string'
    && ['\r', '\n', '\u0000'].some((character) => options.message.includes(character))
  if (options.message !== undefined
    && (typeof options.message !== 'string'
      || !options.message.trim()
      || options.message.length > 256
      || unsafeMessage)) {
    throw new Error('Lifecycle deployment message must be one line between 1 and 256 characters.')
  }
  const commandTimeoutMs = options.commandTimeoutMs ?? 20 * 60_000
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error('Lifecycle deployment command timeout must be a positive number.')
  }
  const reconciliationAttempts = options.reconciliationAttempts ?? 5
  const reconciliationPasses = options.reconciliationPasses ?? 2
  const reconciliationDelayMs = options.reconciliationDelayMs ?? 1_000
  if (!Number.isInteger(reconciliationAttempts) || reconciliationAttempts < reconciliationPasses) {
    throw new Error('Lifecycle deployment reconciliation attempts must cover the required confirmation passes.')
  }
  if (!Number.isInteger(reconciliationPasses) || reconciliationPasses < 1) {
    throw new Error('Lifecycle deployment reconciliation passes must be a positive integer.')
  }
  if (!Number.isFinite(reconciliationDelayMs) || reconciliationDelayMs < 0) {
    throw new Error('Lifecycle deployment reconciliation delay must be zero or greater.')
  }
  return {
    ...options,
    commandTimeoutMs,
    dryRun: options.dryRun === true,
    environment: options.environment ?? process.env,
    message: options.message?.trim() || null,
    reconciliationAttempts,
    reconciliationDelayMs,
    reconciliationPasses,
    workerName: options.workerName ?? 'sygshift',
  }
}

async function requireExactCleanMain(dependencies, commandOptions) {
  await dependencies.run(['exec', 'git', 'fetch', '--quiet', 'origin', 'main'], commandOptions)
  const status = await dependencies.run(
    ['exec', 'git', 'status', '--porcelain=v1', '--untracked-files=all'],
    commandOptions,
  )
  if (status.stdout.trim()) {
    throw new Error('Lifecycle deployment requires a clean working tree, including no untracked files.')
  }

  const local = await dependencies.run(['exec', 'git', 'rev-parse', 'HEAD'], commandOptions)
  const remote = await dependencies.run(['exec', 'git', 'rev-parse', 'origin/main'], commandOptions)
  const localSha = local.stdout.trim().toLowerCase()
  const remoteSha = remote.stdout.trim().toLowerCase()
  if (!gitShaPattern.test(localSha) || !gitShaPattern.test(remoteSha)) {
    throw new Error('Lifecycle deployment could not verify full local and origin/main commit identifiers.')
  }
  if (localSha !== remoteSha) {
    throw new Error('Lifecycle deployment commit must exactly match origin/main.')
  }
  return localSha
}

async function readActiveVersion(dependencies, commandOptions, options) {
  const status = await dependencies.run(
    ['exec', 'wrangler', 'deployments', 'status', '--json', '--name', options.workerName],
    commandOptions,
  )
  return parseCurrentDeployment(status.stdout)
}

async function readLifecycleState(
  dependencies,
  commandOptions,
  options,
  priorVersionId,
  sourceCommit,
) {
  const activeVersionId = await readActiveVersion(dependencies, commandOptions, options)
  if (activeVersionId === priorVersionId) return { activeVersionId, state: 'prior' }

  const version = await dependencies.run([
    'exec', 'wrangler', 'versions', 'view', activeVersionId,
    '--json',
    '--name', options.workerName,
  ], commandOptions)
  const activeSourceCommit = parseSourceCommitFromVersion(version.stdout, activeVersionId)
  if (activeSourceCommit !== sourceCommit) {
    throw new UnexpectedLifecycleVersionError(
      'Production is running an unexpected Worker version; manual lifecycle deployment reconciliation is required.',
    )
  }
  return { activeVersionId, state: 'candidate' }
}

async function reconcileLifecycleDeployment(
  dependencies,
  commandOptions,
  options,
  priorVersionId,
  sourceCommit,
) {
  let consecutiveState = 0
  let lastState = null
  let lastVersionId = null
  let hadReadErrors = false

  for (let attempt = 1; attempt <= options.reconciliationAttempts; attempt += 1) {
    let observation
    try {
      observation = await readLifecycleState(
        dependencies,
        commandOptions,
        options,
        priorVersionId,
        sourceCommit,
      )
    } catch (error) {
      if (isCommandTerminationUnconfirmedError(error)) throw error
      if (error instanceof UnexpectedLifecycleVersionError) throw error
      hadReadErrors = true
      consecutiveState = 0
      lastState = null
      lastVersionId = null
      if (attempt < options.reconciliationAttempts) {
        await dependencies.sleep(options.reconciliationDelayMs)
      }
      continue
    }

    const sameObservation = observation.state === lastState
      && observation.activeVersionId === lastVersionId
    consecutiveState = sameObservation ? consecutiveState + 1 : 1
    lastState = observation.state
    lastVersionId = observation.activeVersionId
    const candidateConfirmed = observation.state === 'candidate'
      && consecutiveState >= options.reconciliationPasses
    if (candidateConfirmed) {
      return {
        activeVersionId: observation.activeVersionId,
        attempts: attempt,
        hadReadErrors,
        state: observation.state,
      }
    }
    if (attempt < options.reconciliationAttempts) {
      await dependencies.sleep(options.reconciliationDelayMs)
    }
  }

  throw new Error(
    'Lifecycle deployment state could not be reconciled to the exact source-tagged version; '
    + 'the prior active version does not prove that migrations or other lifecycle changes were not applied. '
    + 'manual intervention is required.',
  )
}

export async function runLifecycleBootstrapDeployment(inputOptions, injected = {}) {
  const options = validatedOptions(inputOptions)
  const dependencies = {
    log: injected.log ?? (() => undefined),
    run: injected.run ?? createCommandRunner(),
    sleep: injected.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  }
  const commandOptions = {
    cwd: options.cwd,
    env: commandEnvironment(options.environment),
    timeoutMs: options.commandTimeoutMs,
  }

  dependencies.log('Verifying the clean, pushed lifecycle bootstrap source before validation.')
  const sourceCommit = await requireExactCleanMain(dependencies, commandOptions)

  dependencies.log('Running the complete quality gate and mandatory Time Clock workflow.')
  await dependencies.run(['check'], commandOptions)
  await dependencies.run(
    ['exec', 'playwright', 'test', 'tests/e2e/time-clock-workflow.spec.ts'],
    commandOptions,
  )

  dependencies.log('Building production artifacts after browser verification.')
  await dependencies.run(['build'], commandOptions)

  dependencies.log('Capturing the exact active Worker version before lifecycle deployment.')
  let priorVersionId
  try {
    priorVersionId = await readActiveVersion(dependencies, commandOptions, options)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    throw new Error(
      'The active Worker version could not be captured before lifecycle deployment; manual intervention is required.',
    )
  }

  // This is intentionally the final operation before Wrangler. It catches a
  // dirty build, a moved origin/main, or a checkout change during validation.
  const confirmedSourceCommit = await requireExactCleanMain(dependencies, commandOptions)
  if (confirmedSourceCommit !== sourceCommit) {
    throw new Error('The lifecycle bootstrap source changed during validation; nothing was deployed.')
  }

  let confirmedPriorVersionId
  try {
    confirmedPriorVersionId = await readActiveVersion(dependencies, commandOptions, options)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    throw new Error(
      'The active Worker version could not be rechecked immediately before lifecycle deployment; manual intervention is required.',
    )
  }
  if (confirmedPriorVersionId !== priorVersionId) {
    throw new Error(
      'Production changed during lifecycle validation; the lifecycle deployment was not started.',
    )
  }

  const sourceTag = `source-${sourceCommit}`
  const deployArguments = [
    'exec', 'wrangler', 'deploy',
    '--strict',
    '--name', options.workerName,
    '--tag', sourceTag,
    '--message', options.message ?? `SygShift lifecycle bootstrap ${sourceCommit}`,
    '--var', `SYGSHIFT_SOURCE_COMMIT:${sourceCommit}`,
    ...(options.dryRun ? ['--dry-run'] : []),
  ]
  dependencies.log(options.dryRun
    ? 'Validating the exact lifecycle deployment without applying it.'
    : 'Applying the lifecycle configuration and Worker source in one Wrangler deployment.')
  if (options.dryRun) {
    await dependencies.run(deployArguments, commandOptions)
    return {
      deployed: false,
      dryRun: true,
      outcome: lifecycleDeploymentOutcomes.dryRun,
      priorVersionId,
      sourceCommit,
      sourceTag,
      workerName: options.workerName,
    }
  }

  let deployCommandFailed = false
  try {
    await dependencies.run(deployArguments, commandOptions)
  } catch (error) {
    if (isCommandTerminationUnconfirmedError(error)) throw error
    deployCommandFailed = true
    dependencies.log(
      'The lifecycle deployment command did not complete cleanly; reconciling the actual active Worker version.',
    )
  }

  const reconciliation = await reconcileLifecycleDeployment(
    dependencies,
    commandOptions,
    options,
    priorVersionId,
    sourceCommit,
  )
  if (deployCommandFailed) {
    throw new Error(
      'The lifecycle deployment command did not complete cleanly. The exact source-tagged version is active, '
      + 'but traffic state alone cannot prove that all migrations, triggers, routes, and other lifecycle settings completed; '
      + 'manual intervention is required.',
    )
  }

  return {
    activeVersionId: reconciliation.activeVersionId,
    deployCommandFailed,
    deployed: true,
    dryRun: false,
    outcome: lifecycleDeploymentOutcomes.deployed,
    priorVersionId,
    reconciliationAttempts: reconciliation.attempts,
    reconciliationStatusReadErrors: reconciliation.hadReadErrors,
    sourceCommit,
    sourceTag,
    workerName: options.workerName,
  }
}

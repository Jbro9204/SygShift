import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { startTimeClockFixtureServer } from './time-clock-fixture-server.mjs'

const require = createRequire(import.meta.url)
const releasePlaywrightPortOffset = '1000'
const defaultWorkflowTimeoutMs = 10 * 60_000
const defaultTerminationTimeoutMs = 10_000
const projectSelectionEnvironmentKeys = new Set(['PLAYWRIGHT_BROWSER', 'PLAYWRIGHT_CHANNEL'])

export class TimeClockProcessTerminationUnconfirmedError extends Error {
  constructor(message = 'The Time Clock browser process tree could not be confirmed stopped.') {
    super(message)
    this.code = 'SYGSHIFT_TIME_CLOCK_TERMINATION_UNCONFIRMED'
    this.name = 'TimeClockProcessTerminationUnconfirmedError'
  }
}

export class TimeClockReleaseInterruptedError extends Error {
  constructor(signalName) {
    super(`The required Time Clock browser workflow was interrupted by ${signalName}.`)
    this.code = 'SYGSHIFT_TIME_CLOCK_INTERRUPTED'
    this.name = 'TimeClockReleaseInterruptedError'
    this.signal = signalName
  }
}

function positiveDuration(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`)
  return value
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error)
}

function combinedFailure(primaryError, cleanupError) {
  const failure = new AggregateError(
    [primaryError, cleanupError],
    `${messageFor(primaryError)} Cleanup also failed: ${messageFor(cleanupError)}`,
  )
  if (primaryError?.code) failure.code = primaryError.code
  if (primaryError?.signal) failure.signal = primaryError.signal
  return failure
}

function terminationIsUnconfirmed(error) {
  return error instanceof TimeClockProcessTerminationUnconfirmedError
    || error?.code === 'SYGSHIFT_TIME_CLOCK_TERMINATION_UNCONFIRMED'
}

function waitForChildClose(child, timeoutMs, label) {
  if ((child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined)) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      child.removeListener('close', onClose)
      callback()
    }
    const onClose = () => finish(resolvePromise)
    const deadline = setTimeout(
      () => finish(() => reject(new TimeClockProcessTerminationUnconfirmedError(label))),
      positiveDuration(timeoutMs, 'Time Clock process-exit confirmation timeout'),
    )
    child.once('close', onClose)
  })
}

function waitForKiller(killer, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      callback()
    }
    killer.once('error', (error) => finish(() => reject(error)))
    killer.once('close', (code) => finish(() => {
      if (code === 0) resolvePromise()
      else reject(new Error(`taskkill exited with code ${code}.`))
    }))
    const deadline = setTimeout(() => finish(() => {
      try {
        killer.kill()
      } catch {
        // The bounded termination failure below remains authoritative.
      }
      reject(new Error('taskkill did not finish before its deadline.'))
    }), positiveDuration(timeoutMs, 'Time Clock tree-kill timeout'))
  })
}

export async function terminateTimeClockProcessTree(child, options = {}) {
  const platform = options.platform ?? process.platform
  const processKill = options.processKill ?? process.kill.bind(process)
  const treeKillSpawn = options.treeKillSpawn ?? spawn
  const timeoutMs = positiveDuration(
    options.timeoutMs ?? defaultTerminationTimeoutMs,
    'Time Clock process-tree termination timeout',
  )
  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    throw new TimeClockProcessTerminationUnconfirmedError('The Time Clock browser process has no valid identifier.')
  }

  try {
    if (platform === 'win32') {
      const killer = treeKillSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      await waitForKiller(killer, timeoutMs)
    } else {
      processKill(-child.pid, 'SIGKILL')
    }
    await waitForChildClose(
      child,
      timeoutMs,
      'The Time Clock browser process did not exit after its process tree was terminated.',
    )
  } catch (error) {
    try {
      child.kill?.('SIGKILL')
    } catch {
      // Confirmation still fails closed below.
    }
    if (error instanceof TimeClockProcessTerminationUnconfirmedError) throw error
    throw new TimeClockProcessTerminationUnconfirmedError(
      `The Time Clock browser process tree could not be confirmed stopped: ${messageFor(error)}`,
    )
  }
}

export function timeClockReleaseEnvironment(environment = process.env, portOffset = releasePlaywrightPortOffset) {
  const normalizedOffset = String(portOffset)
  if (!/^\d+$/u.test(normalizedOffset) || Number(normalizedOffset) > 65_535 - 4186) {
    throw new Error('The Time Clock Playwright port offset must select a valid loopback fixture port.')
  }
  const retained = {}
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (projectSelectionEnvironmentKeys.has(key.toUpperCase())) continue
    retained[key] = value
  }
  return {
    ...retained,
    PLAYWRIGHT_PORT_OFFSET: normalizedOffset,
  }
}

export function createTimeClockPlaywrightRunner(injected = {}) {
  const spawnImplementation = injected.spawn ?? spawn
  const platform = injected.platform ?? process.platform
  const processExecutable = injected.processExecutable ?? process.execPath
  const resolvePlaywrightCli = injected.resolvePlaywrightCli ?? (() => require.resolve('@playwright/test/cli'))
  const terminateTree = injected.terminateTree ?? terminateTimeClockProcessTree
  const terminationOptions = {
    platform,
    processKill: injected.processKill,
    timeoutMs: injected.terminationTimeoutMs ?? defaultTerminationTimeoutMs,
    treeKillSpawn: injected.treeKillSpawn,
  }

  return ({
    additionalArguments = [],
    cwd,
    environment,
    signal,
    timeoutMs = defaultWorkflowTimeoutMs,
  }) => new Promise((resolvePromise, reject) => {
    const timeout = positiveDuration(timeoutMs, 'Time Clock browser release-test timeout')
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new TimeClockReleaseInterruptedError('abort'))
      return
    }
    if (!Array.isArray(additionalArguments) || additionalArguments.some((value) => typeof value !== 'string')) {
      reject(new Error('Additional Time Clock Playwright arguments must be strings.'))
      return
    }
    const forwardedArguments = additionalArguments[0] === '--'
      ? additionalArguments.slice(1)
      : additionalArguments

    let cliPath
    try {
      cliPath = resolvePlaywrightCli()
    } catch {
      reject(new Error('Could not resolve the repository-pinned @playwright/test/cli.js entry point.'))
      return
    }
    const arguments_ = [
      cliPath,
      'test',
      '--config',
      'playwright.time-clock.config.ts',
      'tests/e2e/time-clock-workflow.spec.ts',
      ...forwardedArguments,
    ]

    let child
    try {
      child = spawnImplementation(processExecutable, arguments_, {
        cwd,
        ...(platform === 'win32' ? {} : { detached: true }),
        env: environment,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      })
    } catch {
      reject(new Error('Could not start the required Time Clock browser workflow.'))
      return
    }

    let deadline
    let settled = false
    let terminating = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal?.removeEventListener?.('abort', onAbort)
      callback()
    }
    const stop = async (failure) => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(deadline)
      try {
        await terminateTree(child, terminationOptions)
        finish(() => reject(failure))
      } catch (terminationError) {
        finish(() => reject(terminationError))
      }
    }
    const onAbort = () => {
      const failure = signal?.reason instanceof Error
        ? signal.reason
        : new TimeClockReleaseInterruptedError('abort')
      void stop(failure)
    }

    child.once('error', () => {
      if (terminating) return
      finish(() => reject(new Error('Could not start the required Time Clock browser workflow.')))
    })
    child.once('close', (code, closeSignal) => {
      if (terminating) return
      finish(() => {
        if (code === 0) resolvePromise()
        else reject(new Error(
          `The required Time Clock browser workflow failed with ${code === null ? `signal ${closeSignal ?? 'unknown'}` : `exit code ${code}`}.`,
        ))
      })
    })
    deadline = setTimeout(() => {
      void stop(new Error('The required Time Clock browser workflow timed out after its bounded deadline.'))
    }, timeout)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function installSignalHandlers(processObject, controller) {
  const handlers = new Map()
  for (const signalName of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!controller.signal.aborted) controller.abort(new TimeClockReleaseInterruptedError(signalName))
    }
    handlers.set(signalName, handler)
    processObject.on(signalName, handler)
  }
  return () => {
    for (const [signalName, handler] of handlers) processObject.removeListener(signalName, handler)
  }
}

export async function runTimeClockReleaseVerification(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const environment = timeClockReleaseEnvironment(options.environment ?? process.env)
  const startFixture = options.startFixture ?? startTimeClockFixtureServer
  const runPlaywright = options.runPlaywright ?? createTimeClockPlaywrightRunner()
  const timeoutMs = options.timeoutMs ?? defaultWorkflowTimeoutMs
  const processObject = options.processObject ?? process
  const controller = new AbortController()
  const removeSignalHandlers = installSignalHandlers(processObject, controller)
  let fixture
  let playwrightEnvironment
  let workflowError
  let cleanupError

  try {
    fixture = await startFixture({ cwd, environment })
    if (controller.signal.aborted) throw controller.signal.reason
    if (!Number.isInteger(fixture?.offset)) {
      throw new Error('The Time Clock fixture did not provide its exact bound-port offset.')
    }
    playwrightEnvironment = timeClockReleaseEnvironment(environment, fixture?.offset)
    await runPlaywright({
      additionalArguments: options.additionalArguments ?? [],
      cwd,
      environment: playwrightEnvironment,
      signal: controller.signal,
      timeoutMs,
    })
  } catch (error) {
    workflowError = error
  } finally {
    // Preserve the fixture when a browser descendant may still be running.
    // The outer candidate gate can then kill this entire runner tree; closing
    // only the fixture would leave an unconfirmed browser orphan behind.
    if (!terminationIsUnconfirmed(workflowError)) {
      try {
        await fixture?.close()
      } catch (error) {
        cleanupError = error
      }
    }
    removeSignalHandlers()
  }

  if (workflowError && cleanupError) throw combinedFailure(workflowError, cleanupError)
  if (workflowError) throw workflowError
  if (cleanupError) throw cleanupError
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTimeClockReleaseVerification({ additionalArguments: process.argv.slice(2) }).catch((error) => {
    console.error(messageFor(error) || 'The required Time Clock browser workflow failed.')
    process.exitCode = error?.signal === 'SIGINT' ? 130 : error?.signal === 'SIGTERM' ? 143 : 1
  })
}

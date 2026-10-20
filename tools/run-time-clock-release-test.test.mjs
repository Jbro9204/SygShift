import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  createTimeClockPlaywrightRunner,
  runTimeClockReleaseVerification,
  terminateTimeClockProcessTree,
  TimeClockProcessTerminationUnconfirmedError,
  timeClockReleaseEnvironment,
} from './run-time-clock-release-test.mjs'

class FakeChild extends EventEmitter {
  constructor(pid = 4321) {
    super()
    this.exitCode = null
    this.killCalls = []
    this.pid = pid
    this.signalCode = null
  }

  kill(signal) {
    this.killCalls.push(signal)
    return true
  }

  close(code, signal = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code, signal)
  }
}

function fakeProcessObject() {
  return new EventEmitter()
}

test('reserves the isolated port range and removes browser-project override variables', () => {
  const environment = timeClockReleaseEnvironment({
    PATH: 'C:/toolchain/bin',
    PLAYWRIGHT_BROWSER: 'firefox',
    PLAYWRIGHT_CHANNEL: 'msedge',
    PLAYWRIGHT_PORT_OFFSET: '0',
  })
  assert.equal(environment.PLAYWRIGHT_PORT_OFFSET, '1000')
  assert.equal(environment.PATH, 'C:/toolchain/bin')
  assert.equal(Object.hasOwn(environment, 'PLAYWRIGHT_BROWSER'), false)
  assert.equal(Object.hasOwn(environment, 'PLAYWRIGHT_CHANNEL'), false)
})

test('launches the resolved Playwright CLI through process.execPath with shell disabled', async () => {
  const child = new FakeChild()
  let launch
  const runner = createTimeClockPlaywrightRunner({
    platform: 'win32',
    processExecutable: 'C:/Node/node.exe',
    resolvePlaywrightCli: () => 'C:/repo/node_modules/@playwright/test/cli.js',
    spawn: (command, arguments_, options) => {
      launch = { arguments_, command, options }
      queueMicrotask(() => child.close(0))
      return child
    },
  })
  await runner({
    additionalArguments: ['--list'],
    cwd: 'C:/repo',
    environment: { PATH: 'C:/Node' },
    timeoutMs: 1_000,
  })
  assert.equal(launch.command, 'C:/Node/node.exe')
  assert.deepEqual(launch.arguments_, [
    'C:/repo/node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.time-clock.config.ts',
    'tests/e2e/time-clock-workflow.spec.ts',
    '--list',
  ])
  assert.equal(launch.options.shell, false)
  assert.equal(launch.options.cwd, 'C:/repo')
})

test('strips one package-manager separator before forwarding Playwright arguments', async () => {
  const child = new FakeChild()
  let launchedArguments
  const runner = createTimeClockPlaywrightRunner({
    resolvePlaywrightCli: () => '/repo/node_modules/@playwright/test/cli.js',
    spawn: (_command, arguments_) => {
      launchedArguments = arguments_
      queueMicrotask(() => child.close(0))
      return child
    },
  })
  await runner({
    additionalArguments: ['--', '--list'],
    cwd: '/repo',
    environment: {},
    timeoutMs: 1_000,
  })
  assert.deepEqual(launchedArguments.slice(-1), ['--list'])
  assert.equal(launchedArguments.includes('--'), false)
})

test('reports a nonzero Playwright exit without weakening or rerunning the workflow', async () => {
  const child = new FakeChild()
  let launches = 0
  const runner = createTimeClockPlaywrightRunner({
    resolvePlaywrightCli: () => '/repo/node_modules/@playwright/test/cli.js',
    spawn: () => {
      launches += 1
      queueMicrotask(() => child.close(7))
      return child
    },
  })
  await assert.rejects(
    runner({ cwd: '/repo', environment: {}, timeoutMs: 1_000 }),
    /exit code 7/,
  )
  assert.equal(launches, 1)
})

test('reports a Playwright process launch error', async () => {
  const child = new FakeChild()
  const runner = createTimeClockPlaywrightRunner({
    resolvePlaywrightCli: () => '/repo/node_modules/@playwright/test/cli.js',
    spawn: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')))
      return child
    },
  })
  await assert.rejects(
    runner({ cwd: '/repo', environment: {}, timeoutMs: 1_000 }),
    /Could not start/,
  )
})

test('times out by killing the complete Windows process tree and confirming child exit', async () => {
  const child = new FakeChild(9876)
  const treeKillCalls = []
  const runner = createTimeClockPlaywrightRunner({
    platform: 'win32',
    resolvePlaywrightCli: () => 'C:/repo/node_modules/@playwright/test/cli.js',
    spawn: () => child,
    terminationTimeoutMs: 100,
    treeKillSpawn: (command, arguments_, options) => {
      treeKillCalls.push({ arguments_, command, options })
      const killer = new FakeChild(2222)
      queueMicrotask(() => {
        killer.close(0)
        child.close(null, 'SIGKILL')
      })
      return killer
    },
  })
  await assert.rejects(
    runner({ cwd: 'C:/repo', environment: {}, timeoutMs: 10 }),
    /timed out after its bounded deadline/,
  )
  assert.equal(treeKillCalls[0].command, 'taskkill.exe')
  assert.deepEqual(treeKillCalls[0].arguments_, ['/PID', '9876', '/T', '/F'])
  assert.equal(treeKillCalls[0].options.shell, false)
})

test('fails closed when a timed-out process tree cannot be confirmed stopped', async () => {
  const child = new FakeChild()
  const runner = createTimeClockPlaywrightRunner({
    resolvePlaywrightCli: () => '/repo/node_modules/@playwright/test/cli.js',
    spawn: () => child,
    terminateTree: async () => { throw new TimeClockProcessTerminationUnconfirmedError('still running') },
  })
  await assert.rejects(
    runner({ cwd: '/repo', environment: {}, timeoutMs: 10 }),
    (error) => error?.code === 'SYGSHIFT_TIME_CLOCK_TERMINATION_UNCONFIRMED' && /still running/.test(error.message),
  )
})

test('kills a detached POSIX process group and waits for the child close confirmation', async () => {
  const child = new FakeChild(2468)
  const kills = []
  await terminateTimeClockProcessTree(child, {
    platform: 'linux',
    processKill: (pid, signal) => {
      kills.push({ pid, signal })
      queueMicrotask(() => child.close(null, 'SIGKILL'))
    },
    timeoutMs: 100,
  })
  assert.deepEqual(kills, [{ pid: -2468, signal: 'SIGKILL' }])
})

test('reports a process-group kill failure without leaving an unobserved exit-confirmation rejection', async () => {
  const child = new FakeChild(1357)
  await assert.rejects(
    terminateTimeClockProcessTree(child, {
      platform: 'linux',
      processKill: () => { throw new Error('group kill denied') },
      timeoutMs: 15,
    }),
    (error) => error?.code === 'SYGSHIFT_TIME_CLOCK_TERMINATION_UNCONFIRMED'
      && /group kill denied/.test(error.message),
  )
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
})

test('runs after fixture readiness, forwards arguments, and always closes the fixture on success', async () => {
  const calls = []
  let closes = 0
  const processObject = fakeProcessObject()
  await runTimeClockReleaseVerification({
    additionalArguments: ['--list'],
    cwd: 'C:/repo',
    environment: { PLAYWRIGHT_BROWSER: 'firefox', PLAYWRIGHT_PORT_OFFSET: '0' },
    processObject,
    runPlaywright: async (options) => calls.push({ playwright: options }),
    startFixture: async (options) => {
      calls.push({ fixture: options })
      return { offset: 3210, async close() { closes += 1 } }
    },
    timeoutMs: 1234,
  })
  assert.equal(calls[0].fixture.environment.PLAYWRIGHT_PORT_OFFSET, '1000')
  assert.equal(Object.hasOwn(calls[0].fixture.environment, 'PLAYWRIGHT_BROWSER'), false)
  assert.equal(calls[1].playwright.timeoutMs, 1234)
  assert.equal(calls[1].playwright.environment.PLAYWRIGHT_PORT_OFFSET, '3210')
  assert.deepEqual(calls[1].playwright.additionalArguments, ['--list'])
  assert.equal(closes, 1)
  assert.equal(processObject.listenerCount('SIGINT'), 0)
  assert.equal(processObject.listenerCount('SIGTERM'), 0)
})

test('closes the fixture when Playwright fails and preserves that workflow error', async () => {
  let closes = 0
  await assert.rejects(
    runTimeClockReleaseVerification({
      processObject: fakeProcessObject(),
      runPlaywright: async () => { throw new Error('browser assertion failed') },
      startFixture: async () => ({ offset: 1000, async close() { closes += 1 } }),
    }),
    /browser assertion failed/,
  )
  assert.equal(closes, 1)
})

test('combines Playwright and fixture cleanup failures so neither is hidden', async () => {
  await assert.rejects(
    runTimeClockReleaseVerification({
      processObject: fakeProcessObject(),
      runPlaywright: async () => { throw new Error('browser assertion failed') },
      startFixture: async () => ({ offset: 1000, async close() { throw new Error('fixture cleanup failed') } }),
    }),
    /browser assertion failed.*fixture cleanup failed/,
  )
})

test('preserves the fixture when browser-tree termination cannot be confirmed', async () => {
  let closes = 0
  await assert.rejects(
    runTimeClockReleaseVerification({
      processObject: fakeProcessObject(),
      runPlaywright: async () => { throw new TimeClockProcessTerminationUnconfirmedError('browser may remain') },
      startFixture: async () => ({ offset: 1000, async close() { closes += 1 } }),
    }),
    (error) => error?.code === 'SYGSHIFT_TIME_CLOCK_TERMINATION_UNCONFIRMED',
  )
  assert.equal(closes, 0)
})

test('SIGTERM aborts the browser workflow, cleans the fixture, and removes signal handlers', async () => {
  const processObject = fakeProcessObject()
  let closes = 0
  const verification = runTimeClockReleaseVerification({
    processObject,
    runPlaywright: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      setImmediate(() => processObject.emit('SIGTERM'))
    }),
    startFixture: async () => ({ offset: 1000, async close() { closes += 1 } }),
  })
  await assert.rejects(
    verification,
    (error) => error?.code === 'SYGSHIFT_TIME_CLOCK_INTERRUPTED' && error?.signal === 'SIGTERM',
  )
  assert.equal(closes, 1)
  assert.equal(processObject.listenerCount('SIGINT'), 0)
  assert.equal(processObject.listenerCount('SIGTERM'), 0)
})

test('does not launch Playwright when fixture startup fails and removes signal handlers', async () => {
  let browserStarted = false
  const processObject = fakeProcessObject()
  await assert.rejects(
    runTimeClockReleaseVerification({
      processObject,
      runPlaywright: async () => { browserStarted = true },
      startFixture: async () => { throw new Error('fixture failed') },
    }),
    /fixture failed/,
  )
  assert.equal(browserStarted, false)
  assert.equal(processObject.listenerCount('SIGINT'), 0)
  assert.equal(processObject.listenerCount('SIGTERM'), 0)
})

test('does not launch Playwright when the fixture omits its exact bound-port offset', async () => {
  let browserStarted = false
  let closes = 0
  await assert.rejects(
    runTimeClockReleaseVerification({
      processObject: fakeProcessObject(),
      runPlaywright: async () => { browserStarted = true },
      startFixture: async () => ({ async close() { closes += 1 } }),
    }),
    /did not provide its exact bound-port offset/,
  )
  assert.equal(browserStarted, false)
  assert.equal(closes, 1)
})

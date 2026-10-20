import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  startTimeClockFixtureServer,
  timeClockFixtureOffsetForPort,
  timeClockFixturePort,
  waitForTimeClockFixture,
} from './time-clock-fixture-server.mjs'

const cwd = resolve('.')

function controlledTestRuntime(name) {
  return join(cwd, '.work', 'time-clock-release-fixture', name)
}

function markerProbe({
  body,
  contentType = 'text/html; charset=utf-8',
  statusCode = 200,
}) {
  let receivedRequest
  const requestImplementation = (requestOptions, callback) => {
    receivedRequest = requestOptions
    const probe = new EventEmitter()
    probe.destroy = (error) => queueMicrotask(() => probe.emit('error', error))
    probe.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.headers = { 'content-type': contentType }
      response.statusCode = statusCode
      callback(response)
      response.emit('data', Buffer.from(body))
      response.emit('end')
    })
    probe.setTimeout = () => undefined
    return probe
  }
  return {
    requestImplementation,
    requestOptions: () => receivedRequest,
  }
}

test('derives the Time Clock fixture port from a bounded numeric offset', () => {
  assert.equal(timeClockFixturePort({ PLAYWRIGHT_PORT_OFFSET: '1000' }), 5186)
  assert.equal(timeClockFixtureOffsetForPort(5186), 1000)
  assert.throws(() => timeClockFixturePort({ PLAYWRIGHT_PORT_OFFSET: '-1' }), /non-negative integer/)
  assert.throws(() => timeClockFixturePort({ PLAYWRIGHT_PORT_OFFSET: '70000' }), /valid TCP port range/)
  assert.throws(() => timeClockFixtureOffsetForPort(4185), /at or above 4186/)
})

test('requires the exact marker before declaring the loopback fixture ready', async () => {
  const valid = markerProbe({
    body: '<!doctype html><html><head><title>Time clock regression fixture</title></head><body></body></html>',
  })
  await waitForTimeClockFixture({
    port: 5186,
    readinessTimeoutMs: 250,
    requestImplementation: valid.requestImplementation,
  })
  assert.deepEqual(valid.requestOptions(), {
    headers: { accept: 'text/html' },
    host: '127.0.0.1',
    method: 'GET',
    path: '/tests/fixtures/clock-ui.html',
    port: 5186,
  })

  const invalid = markerProbe({ body: '<!doctype html><title>Different application</title>' })
  await assert.rejects(
    waitForTimeClockFixture({
      intervalMs: 5,
      port: 5186,
      readinessTimeoutMs: 30,
      requestImplementation: invalid.requestImplementation,
      requestTimeoutMs: 10,
    }),
    /not marker-ready.*exact Time Clock marker/,
  )
})

test('starts one loopback-only Time Clock fixture with an isolated Vite cache and cleans it once', async () => {
  const calls = []
  const runtimeDirectory = controlledTestRuntime('run-success')
  let closes = 0
  const fixture = await startTimeClockFixtureServer({
    cwd,
    createRuntimeDirectory: async () => runtimeDirectory,
    createServer: async (options) => {
      calls.push({ serverOptions: options })
      return {
        async close() { closes += 1 },
        async listen() { calls.push('listen') },
        async warmupRequest(path) { calls.push({ warmup: path }) },
        async waitForRequestsIdle() { calls.push('idle') },
        httpServer: { address: () => ({ port: 5186 }) },
      }
    },
    removeRuntimeDirectory: async (receivedCwd, path) => calls.push({ removed: { path, receivedCwd } }),
    waitForFixture: async (options) => calls.push({ probe: options }),
  })

  assert.equal(calls[0].serverOptions.configFile, join(cwd, 'tests', 'fixtures', 'clock-vite.config.ts'))
  assert.equal(calls[0].serverOptions.cacheDir, join(runtimeDirectory, 'vite-cache'))
  assert.equal(Object.hasOwn(calls[0].serverOptions, 'optimizeDeps'), false)
  assert.deepEqual(calls[0].serverOptions.server, { host: '127.0.0.1', port: 0, strictPort: true })
  assert.deepEqual(calls.slice(1, 5), [
    'listen',
    { warmup: '/tests/fixtures/clock-ui.tsx' },
    'idle',
    { probe: { port: 5186 } },
  ])
  assert.equal(fixture.offset, 1000)
  assert.equal(fixture.url, 'http://127.0.0.1:5186/tests/fixtures/clock-ui.html')
  await fixture.close()
  await fixture.close()
  assert.equal(closes, 1)
  assert.deepEqual(calls.at(-1), { removed: { path: runtimeDirectory, receivedCwd: cwd } })
})

test('closes the server and removes its controlled cache when readiness fails', async () => {
  const runtimeDirectory = controlledTestRuntime('run-readiness-failure')
  let closes = 0
  let removals = 0
  await assert.rejects(
    startTimeClockFixtureServer({
      cwd,
      createRuntimeDirectory: async () => runtimeDirectory,
      createServer: async () => ({
        async close() { closes += 1 },
        async listen() {},
        async warmupRequest() {},
        async waitForRequestsIdle() {},
        httpServer: { address: () => ({ port: 5186 }) },
      }),
      removeRuntimeDirectory: async () => { removals += 1 },
      waitForFixture: async () => { throw new Error('unreachable') },
    }),
    /Could not prepare.*unreachable/,
  )
  assert.equal(closes, 1)
  assert.equal(removals, 1)
})

test('bounds module warmup and cleans the server and controlled runtime on timeout', async () => {
  const runtimeDirectory = controlledTestRuntime('run-warmup-timeout')
  let closes = 0
  let removals = 0
  await assert.rejects(
    startTimeClockFixtureServer({
      cwd,
      createRuntimeDirectory: async () => runtimeDirectory,
      createServer: async () => ({
        async close() { closes += 1 },
        async listen() {},
        async warmupRequest() { return new Promise(() => undefined) },
        async waitForRequestsIdle() { throw new Error('idle should not run') },
        httpServer: { address: () => ({ port: 5186 }) },
      }),
      removeRuntimeDirectory: async () => { removals += 1 },
      warmupTimeoutMs: 10,
    }),
    /module warmup did not finish before its deadline/,
  )
  assert.equal(closes, 1)
  assert.equal(removals, 1)
})

test('bounds request-idle confirmation and cleans the server and controlled runtime on timeout', async () => {
  const runtimeDirectory = controlledTestRuntime('run-idle-timeout')
  let closes = 0
  let removals = 0
  await assert.rejects(
    startTimeClockFixtureServer({
      cwd,
      createRuntimeDirectory: async () => runtimeDirectory,
      createServer: async () => ({
        async close() { closes += 1 },
        async listen() {},
        async warmupRequest() {},
        async waitForRequestsIdle() { return new Promise(() => undefined) },
        httpServer: { address: () => ({ port: 5186 }) },
      }),
      idleTimeoutMs: 10,
      removeRuntimeDirectory: async () => { removals += 1 },
    }),
    /requests did not become idle before their deadline/,
  )
  assert.equal(closes, 1)
  assert.equal(removals, 1)
})

test('bounds Vite server creation and removes the controlled runtime when creation stalls', async () => {
  const runtimeDirectory = controlledTestRuntime('run-create-timeout')
  let removals = 0
  await assert.rejects(
    startTimeClockFixtureServer({
      createRuntimeDirectory: async () => runtimeDirectory,
      createServer: async () => new Promise(() => undefined),
      createTimeoutMs: 10,
      cwd,
      removeRuntimeDirectory: async () => { removals += 1 },
    }),
    /Vite server creation timed out/,
  )
  assert.equal(removals, 1)
})

test('bounds a stuck Vite close, still attempts cache removal, and reports cleanup failure', async () => {
  const runtimeDirectory = controlledTestRuntime('run-close-timeout')
  let removals = 0
  const fixture = await startTimeClockFixtureServer({
    closeTimeoutMs: 10,
    cwd,
    createRuntimeDirectory: async () => runtimeDirectory,
    createServer: async () => ({
      async close() { return new Promise(() => undefined) },
      async listen() {},
      async warmupRequest() {},
      async waitForRequestsIdle() {},
      httpServer: { address: () => ({ port: 5186 }), close() {}, closeAllConnections() {}, closeIdleConnections() {} },
    }),
    removeRuntimeDirectory: async () => { removals += 1 },
    waitForFixture: async () => undefined,
  })
  await assert.rejects(fixture.close(), /server close timed out/)
  assert.equal(removals, 1)
})

test('combines server-close and cache-removal failures instead of hiding either one', async () => {
  const runtimeDirectory = controlledTestRuntime('run-combined-cleanup')
  const fixture = await startTimeClockFixtureServer({
    cwd,
    createRuntimeDirectory: async () => runtimeDirectory,
    createServer: async () => ({
      async close() { throw new Error('close failed') },
      async listen() {},
      async warmupRequest() {},
      async waitForRequestsIdle() {},
      httpServer: { address: () => ({ port: 5186 }) },
    }),
    removeRuntimeDirectory: async () => { throw new Error('cache removal failed') },
    waitForFixture: async () => undefined,
  })
  await assert.rejects(fixture.close(), /close failed.*cache removal failed/)
})

test('rejects a runtime directory outside the controlled fixture root', async () => {
  await assert.rejects(
    startTimeClockFixtureServer({
      cwd,
      createRuntimeDirectory: async () => join(cwd, 'not-controlled'),
    }),
    /must be a unique child/,
  )
})

import { request } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createServer as createViteServer } from 'vite'

const basePort = 4186
const fixturePath = '/tests/fixtures/clock-ui.html'
const fixtureEntryPath = '/tests/fixtures/clock-ui.tsx'
const fixtureMarker = '<title>Time clock regression fixture</title>'
const defaultCreateTimeoutMs = 30_000
const defaultListenTimeoutMs = 30_000
const defaultWarmupTimeoutMs = 30_000
const defaultIdleTimeoutMs = 30_000
const defaultReadinessTimeoutMs = 20_000
const defaultCloseTimeoutMs = 10_000
const maximumProbeBodyBytes = 128 * 1024

function positiveDuration(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`)
  return value
}

function controlledRuntimeRoot(cwd) {
  return resolve(cwd, '.work', 'time-clock-release-fixture')
}

function assertControlledRuntimeDirectory(cwd, runtimeDirectory) {
  const root = controlledRuntimeRoot(cwd)
  const candidate = resolve(runtimeDirectory)
  const pathFromRoot = relative(root, candidate)
  if (!isAbsolute(candidate) || !pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error('The Time Clock fixture runtime directory must be a unique child of .work/time-clock-release-fixture.')
  }
  return candidate
}

async function createControlledRuntimeDirectory(cwd) {
  const root = controlledRuntimeRoot(cwd)
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, 'run-'))
}

async function removeControlledRuntimeDirectory(cwd, runtimeDirectory) {
  const candidate = assertControlledRuntimeDirectory(cwd, runtimeDirectory)
  await rm(candidate, { force: true, recursive: true })
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function withTimeout(promise, timeoutMs, message) {
  const duration = positiveDuration(timeoutMs, 'Time Clock fixture operation timeout')
  let deadline
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(deadline)),
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(message)), duration)
    }),
  ])
}

function requestFixture({ port, requestImplementation = request, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const probe = requestImplementation({
      headers: { accept: 'text/html' },
      host: '127.0.0.1',
      method: 'GET',
      path: fixturePath,
      port,
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > maximumProbeBodyBytes) {
          response.destroy(new Error('fixture readiness response exceeded the safe size limit'))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => {
        const contentType = String(response.headers?.['content-type'] ?? '').toLowerCase()
        const body = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200 || !contentType.includes('text/html') || !body.includes(fixtureMarker)) {
          reject(new Error('fixture readiness response did not contain the exact Time Clock marker'))
          return
        }
        resolvePromise()
      })
    })
    probe.once('error', reject)
    probe.setTimeout(timeoutMs, () => probe.destroy(new Error('fixture readiness probe timed out')))
    probe.end()
  })
}

export function timeClockFixturePort(environment = process.env) {
  const rawOffset = environment?.PLAYWRIGHT_PORT_OFFSET ?? '0'
  if (!/^\d+$/u.test(rawOffset)) {
    throw new Error('PLAYWRIGHT_PORT_OFFSET must be a non-negative integer for the Time Clock fixture.')
  }
  const offset = Number(rawOffset)
  const port = basePort + offset
  if (!Number.isSafeInteger(offset) || port > 65_535) {
    throw new Error('PLAYWRIGHT_PORT_OFFSET places the Time Clock fixture outside the valid TCP port range.')
  }
  return port
}

export function timeClockFixtureOffsetForPort(port) {
  if (!Number.isInteger(port) || port < basePort || port > 65_535) {
    throw new Error('The Time Clock fixture must bind to a valid port at or above 4186.')
  }
  return port - basePort
}

function boundFixturePort(viteServer) {
  const address = viteServer?.httpServer?.address?.()
  if (!address || typeof address === 'string') {
    throw new Error('Time Clock fixture server did not report a numeric loopback port.')
  }
  timeClockFixtureOffsetForPort(address.port)
  return address.port
}

export async function waitForTimeClockFixture(options = {}) {
  const port = options.port ?? timeClockFixturePort(options.environment)
  const readinessTimeoutMs = positiveDuration(
    options.readinessTimeoutMs ?? defaultReadinessTimeoutMs,
    'Time Clock fixture readiness timeout',
  )
  const requestTimeoutMs = positiveDuration(
    options.requestTimeoutMs ?? 1_000,
    'Time Clock fixture request timeout',
  )
  const intervalMs = positiveDuration(options.intervalMs ?? 100, 'Time Clock fixture retry interval')
  const requestImplementation = options.requestImplementation ?? request
  const deadline = Date.now() + readinessTimeoutMs
  let lastError

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    try {
      await requestFixture({
        port,
        requestImplementation,
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
      })
      return
    } catch (error) {
      lastError = error
      const delay = Math.min(intervalMs, Math.max(0, deadline - Date.now()))
      if (delay > 0) await wait(delay)
    }
  }

  const reason = lastError instanceof Error ? ` ${lastError.message}` : ''
  throw new Error(`Time Clock fixture was not marker-ready at http://127.0.0.1:${port}${fixturePath}.${reason}`)
}

function combineErrors(primary, cleanup, prefix) {
  if (!cleanup) return primary
  const primaryMessage = primary instanceof Error ? primary.message : String(primary)
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup)
  return new Error(`${prefix}: ${primaryMessage} Cleanup also failed: ${cleanupMessage}`)
}

async function closeServer(viteServer, timeoutMs) {
  if (!viteServer) return
  try {
    await withTimeout(
      viteServer.close(),
      timeoutMs,
      'Time Clock fixture server close timed out.',
    )
  } catch (error) {
    try {
      viteServer.httpServer?.closeAllConnections?.()
      viteServer.httpServer?.closeIdleConnections?.()
      viteServer.httpServer?.close?.()
    } catch {
      // The original bounded-close error remains authoritative.
    }
    throw error
  }
}

export async function startTimeClockFixtureServer(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const environment = options.environment ?? process.env
  const requestedPort = options.port ?? 0
  const createServer = options.createServer ?? createViteServer
  const waitForFixture = options.waitForFixture ?? waitForTimeClockFixture
  const createRuntimeDirectory = options.createRuntimeDirectory ?? createControlledRuntimeDirectory
  const removeRuntimeDirectory = options.removeRuntimeDirectory ?? removeControlledRuntimeDirectory
  const createTimeoutMs = positiveDuration(
    options.createTimeoutMs ?? defaultCreateTimeoutMs,
    'Time Clock fixture creation timeout',
  )
  const listenTimeoutMs = positiveDuration(
    options.listenTimeoutMs ?? defaultListenTimeoutMs,
    'Time Clock fixture listen timeout',
  )
  const warmupTimeoutMs = positiveDuration(
    options.warmupTimeoutMs ?? defaultWarmupTimeoutMs,
    'Time Clock fixture warmup timeout',
  )
  const idleTimeoutMs = positiveDuration(
    options.idleTimeoutMs ?? defaultIdleTimeoutMs,
    'Time Clock fixture request-idle timeout',
  )
  const closeTimeoutMs = positiveDuration(
    options.closeTimeoutMs ?? defaultCloseTimeoutMs,
    'Time Clock fixture close timeout',
  )

  let runtimeDirectory
  let viteServer
  let closed = false

  const cleanup = async () => {
    if (closed) return
    closed = true
    let cleanupError
    try {
      await closeServer(viteServer, closeTimeoutMs)
    } catch (error) {
      cleanupError = error
    }
    if (runtimeDirectory) {
      try {
        await withTimeout(
          removeRuntimeDirectory(cwd, runtimeDirectory),
          closeTimeoutMs,
          'Time Clock fixture cache cleanup timed out.',
        )
      } catch (error) {
        cleanupError = combineErrors(cleanupError ?? error, cleanupError ? error : null, 'Time Clock fixture cleanup failed')
      }
    }
    if (cleanupError) throw cleanupError
  }

  try {
    runtimeDirectory = assertControlledRuntimeDirectory(cwd, await createRuntimeDirectory(cwd))
    viteServer = await withTimeout(
      Promise.resolve().then(() => createServer({
        cacheDir: join(runtimeDirectory, 'vite-cache'),
        clearScreen: false,
        configFile: join(cwd, 'tests', 'fixtures', 'clock-vite.config.ts'),
        logLevel: 'error',
        server: {
          host: '127.0.0.1',
          // Let the operating system choose an unused loopback socket. The
          // browser child receives the exact derived offset only after Vite
          // confirms the port it actually bound.
          port: requestedPort,
          strictPort: true,
        },
      })),
      createTimeoutMs,
      'Time Clock fixture Vite server creation timed out.',
    )
    await withTimeout(
      viteServer.listen(),
      listenTimeoutMs,
      'Time Clock fixture server did not listen on loopback before its deadline.',
    )
    const port = boundFixturePort(viteServer)
    await withTimeout(
      Promise.resolve().then(() => {
        if (typeof viteServer.warmupRequest !== 'function') {
          throw new Error('Time Clock fixture Vite server does not support request warmup.')
        }
        return viteServer.warmupRequest(fixtureEntryPath)
      }),
      warmupTimeoutMs,
      'Time Clock fixture module warmup did not finish before its deadline.',
    )
    await withTimeout(
      Promise.resolve().then(() => {
        if (typeof viteServer.waitForRequestsIdle !== 'function') {
          throw new Error('Time Clock fixture Vite server cannot confirm request-idle state.')
        }
        return viteServer.waitForRequestsIdle()
      }),
      idleTimeoutMs,
      'Time Clock fixture requests did not become idle before their deadline.',
    )
    await waitForFixture({ port })
  } catch (error) {
    let cleanupError
    try {
      await cleanup()
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure
    }
    const failure = combineErrors(error, cleanupError, 'Could not prepare the required Time Clock browser fixture')
    throw new Error(`Could not prepare the required Time Clock browser fixture on loopback. ${failure.message}`)
  }

  const port = boundFixturePort(viteServer)
  return {
    offset: timeClockFixtureOffsetForPort(port),
    port,
    runtimeDirectory,
    url: `http://127.0.0.1:${port}${fixturePath}`,
    close: cleanup,
  }
}

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

// Local synthetic rehearsals only: callers supply their already-filtered
// process environment. No application configuration or connection is read.
export function isolatedPostgresRuntime({ platform, override, environment, lookupBindir } = {}) {
  const paths = platform === 'win32' ? win32 : posix
  const lookup = lookupBindir ?? (() => execFileSync('pg_config', ['--bindir'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, env: environment,
  }))
  const directory = override ?? (platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : lookup())
  assert(typeof directory === 'string' && directory.trim(), 'A local PostgreSQL binary directory is required')
  return { bin: paths.resolve(directory.trim()), extension: platform === 'win32' ? '.exe' : '' }
}

export function isolatedPostgresStartArguments({ data, log, port, utc = false }) {
  assert(Number.isInteger(port) && port > 1024 && port <= 65_535 && port !== 5432,
    'An isolated non-default PostgreSQL port is required')
  return ['-D', data, '-l', log, '-o', `-h 127.0.0.1 -p ${port}${utc ? ' -c timezone=UTC' : ''}`, '-w', 'start']
}

export function readIsolatedPostgresLogTail(path) {
  let descriptor
  try {
    descriptor = openSync(path, 'r')
    const size = fstatSync(descriptor).size
    const buffer = Buffer.alloc(Math.min(size, 8_000))
    const length = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
    return buffer.subarray(0, length).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  } catch {
    return '(startup log unavailable)'
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function startIsolatedPostgres({ data, directory, port, run, utc = false }) {
  // Debian/Ubuntu may default to a protected global Unix-socket directory.
  // Every rehearsal client uses TCP loopback, so disable Unix sockets on all
  // platforms instead of depending on global permissions or path quoting.
  writeFileSync(join(data, 'postgresql.auto.conf'), "unix_socket_directories = ''\n")
  const log = join(directory, 'postgres.log')
  try {
    run('pg_ctl', isolatedPostgresStartArguments({ data, log, port, utc }))
  } catch (error) {
    const original = error instanceof Error ? error.message.slice(-2_000) : 'PostgreSQL startup failed'
    throw new Error(`${original}\nIsolated PostgreSQL startup log (last 8000 bytes):\n${readIsolatedPostgresLogTail(log)}`, { cause: error })
  }
}

export function stopIsolatedPostgres({ data, run, started, priorError }) {
  // A timed-out startup can still have created a server. Attempt its bounded
  // shutdown too, without letting a cleanup error hide the startup diagnostic.
  if (!started && !existsSync(join(data, 'postmaster.pid'))) return
  try {
    run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
  } catch (error) {
    if (!priorError) throw error
    const detail = error instanceof Error ? error.message.slice(-2_000) : 'Shutdown did not complete'
    throw new AggregateError([priorError, error], `${priorError.message}\nIsolated PostgreSQL cleanup also failed: ${detail}`)
  }
}

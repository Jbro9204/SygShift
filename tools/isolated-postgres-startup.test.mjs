import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isolatedPostgresRuntime, isolatedPostgresStartArguments, readIsolatedPostgresLogTail, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

test('Unix rehearsals discover installed PostgreSQL rather than assuming version 18', () => {
  let lookups = 0
  const actual = isolatedPostgresRuntime({ platform: 'linux', lookupBindir: () => { lookups += 1; return '/usr/lib/postgresql/16/bin\n' } })
  assert.deepEqual(actual, { bin: '/usr/lib/postgresql/16/bin', extension: '' })
  assert.equal(lookups, 1)
  assert.deepEqual(isolatedPostgresRuntime({ platform: 'darwin', lookupBindir: () => '/opt/homebrew/opt/postgresql@17/bin\n' }),
    { bin: '/opt/homebrew/opt/postgresql@17/bin', extension: '' })
})

test('Windows defaults and explicit platform paths never need pg_config', () => {
  const lookupBindir = () => { throw new Error('Unexpected discovery') }
  assert.deepEqual(isolatedPostgresRuntime({ platform: 'win32', lookupBindir }),
    { bin: 'C:\\Program Files\\PostgreSQL\\18\\bin', extension: '.exe' })
  assert.deepEqual(isolatedPostgresRuntime({ platform: 'win32', override: 'D:/private postgres/bin', lookupBindir }),
    { bin: 'D:\\private postgres\\bin', extension: '.exe' })
  assert.deepEqual(isolatedPostgresRuntime({ platform: 'linux', override: '/opt/pinned postgres/bin', lookupBindir }),
    { bin: '/opt/pinned postgres/bin', extension: '' })
  assert.throws(() => isolatedPostgresRuntime({ platform: 'linux', override: ' ', lookupBindir }), /binary directory/)
})

test('startup arguments keep loopback, random port, optional UTC and paths as separate arguments', () => {
  const options = { data: 'C:/private path/data', log: 'C:/private path/postgres.log', port: 55437 }
  assert.deepEqual(isolatedPostgresStartArguments(options), ['-D', options.data, '-l', options.log, '-o', '-h 127.0.0.1 -p 55437', '-w', 'start'])
  assert.equal(isolatedPostgresStartArguments({ ...options, utc: true })[5], '-h 127.0.0.1 -p 55437 -c timezone=UTC')
  for (const port of [5432, 0, 1024, 65_536, 1.5, '55437']) assert.throws(() => isolatedPostgresStartArguments({ ...options, port }), /non-default/)
})

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sygshift-postgres-start-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const data = join(directory, 'data'); mkdirSync(data)
  return { directory, data, port: 55437 }
}

test('both rehearsal modes disable Unix sockets before a single startup attempt', t => {
  const f = fixture(t)
  for (const utc of [false, true]) {
    let calls = 0
    startIsolatedPostgres({ ...f, utc, run: (command, args) => {
      calls += 1
      assert.equal(command, 'pg_ctl')
      assert.equal(readFileSync(join(f.data, 'postgresql.auto.conf'), 'utf8'), "unix_socket_directories = ''\n")
      assert.match(args[5], /^-h 127\.0\.0\.1 -p 55437(?: -c timezone=UTC)?$/u)
    } })
    assert.equal(calls, 1)
  }
})

test('startup failure adds only a bounded local log tail, keeps its cause, and never retries', t => {
  const f = fixture(t)
  const failure = new Error('pg_ctl failed')
  writeFileSync(join(f.directory, 'postgres.log'), `${'prefix'.repeat(2_000)}\nFATAL: protected socket directory\u0000\n`)
  let calls = 0
  assert.throws(() => startIsolatedPostgres({ ...f, run: () => { calls += 1; throw failure } }), error => {
    assert.equal(error.cause, failure)
    assert.match(error.message, /pg_ctl failed/u)
    assert.match(error.message, /FATAL: protected socket directory/u)
    assert(!error.message.includes('\u0000'))
    assert(error.message.length < 8_100)
    return true
  })
  assert.equal(calls, 1)
})

test('missing startup log preserves the original failure with an explicit diagnostic limitation', t => {
  const f = fixture(t)
  assert.equal(readIsolatedPostgresLogTail(join(f.directory, 'missing.log')), '(startup log unavailable)')
  assert.throws(() => startIsolatedPostgres({ ...f, run: () => { throw new Error('failed before log creation') } }), /failed before log creation[\s\S]*startup log unavailable/u)
})

test('partial startup with a pid gets one bounded fast shutdown; no nonexistent server is contacted', t => {
  const f = fixture(t)
  let calls = 0
  const run = (command, args) => {
    calls += 1
    assert.equal(command, 'pg_ctl')
    assert.deepEqual(args, ['-D', f.data, '-m', 'fast', '-w', 'stop'])
  }
  stopIsolatedPostgres({ ...f, run, started: false })
  assert.equal(calls, 0)
  writeFileSync(join(f.data, 'postmaster.pid'), 'synthetic test pid\n')
  stopIsolatedPostgres({ ...f, run, started: false })
  assert.equal(calls, 1)
})

test('shutdown errors retain both the original startup diagnostic and cleanup failure, without retry', t => {
  const f = fixture(t)
  const priorError = new Error('Original startup diagnostic')
  const shutdownError = new Error('Synthetic stop failure')
  let calls = 0
  const run = () => { calls += 1; throw shutdownError }
  assert.throws(() => stopIsolatedPostgres({ ...f, run, started: true, priorError }), error => {
    assert(error instanceof AggregateError)
    assert.deepEqual(error.errors, [priorError, shutdownError])
    assert.match(error.message, /Original startup diagnostic[\s\S]*Synthetic stop failure/u)
    return true
  })
  assert.equal(calls, 1)
  assert.throws(() => stopIsolatedPostgres({ ...f, run, started: true }), error => error === shutdownError)
})

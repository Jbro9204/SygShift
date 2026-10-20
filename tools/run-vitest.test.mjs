import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import {
  createVitestRuntimeLaunch,
  finalVitestExitCode,
  removeVitestRuntimeDirectory,
  runVitestWithLifecycle,
} from './run-vitest.mjs'

test('runs every Vitest process with an isolated repository-local temporary directory', () => {
  const cwd = resolve(process.cwd())
  const launch = createVitestRuntimeLaunch({
    arguments_: ['run', 'src/App.test.tsx'],
    cwd,
    environment: {
      KEEP: 'retained',
      NODE_COMPILE_CACHE: 'unsafe-default',
      TEMP: 'unsafe-default',
      TMP: 'unsafe-default',
      TMPDIR: 'unsafe-default',
    },
    runId: 'unit-test-run',
  })

  const temporaryDirectory = join(cwd, '.work', 'test-runtime', 'unit-test-run')
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.arguments_, [
    join(cwd, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    'src/App.test.tsx',
  ])
  assert.equal(launch.cwd, cwd)
  assert.equal(launch.temporaryDirectory, temporaryDirectory)
  assert.equal(launch.environment.KEEP, 'retained')
  assert.equal(launch.environment.TEMP, temporaryDirectory)
  assert.equal(launch.environment.TMP, temporaryDirectory)
  assert.equal(launch.environment.TMPDIR, temporaryDirectory)
  assert.equal(launch.environment.NODE_COMPILE_CACHE, join(temporaryDirectory, 'node-compile-cache'))
})

test('rejects malformed Vitest launch inputs before it starts a subprocess', () => {
  assert.throws(
    () => createVitestRuntimeLaunch({ arguments_: 'run' }),
    /arguments must be an array/,
  )
  assert.throws(
    () => createVitestRuntimeLaunch({ runId: '   ' }),
    /non-empty run identifier/,
  )
})

test('removes only the per-run runtime directory and preserves test failures over cleanup failures', async () => {
  const calls = []
  await removeVitestRuntimeDirectory('C:/repo/.work/test-runtime/one-run', async (...arguments_) => {
    calls.push(arguments_)
  }, 'C:/repo')
  assert.deepEqual(calls, [[
    resolve('C:/repo/.work/test-runtime/one-run'),
    { force: true, recursive: true },
  ]])
  assert.equal(finalVitestExitCode(0, false), 0)
  assert.equal(finalVitestExitCode(0, true), 1)
  assert.equal(finalVitestExitCode(3, false), 3)
  assert.equal(finalVitestExitCode(3, true), 3)
})

test('refuses to remove the runtime root or any path outside the controlled per-run root', async () => {
  await assert.rejects(
    removeVitestRuntimeDirectory('C:/repo/.work/test-runtime', async () => assert.fail('must not remove root'), 'C:/repo'),
    /refused to remove a path outside its controlled per-run directory/,
  )
  await assert.rejects(
    removeVitestRuntimeDirectory('C:/repo/.work/other-run', async () => assert.fail('must not remove outside path'), 'C:/repo'),
    /refused to remove a path outside its controlled per-run directory/,
  )
})

test('cleans the isolated runtime after both successful and failing Vitest execution', async () => {
  const launch = { temporaryDirectory: 'C:/repo/.work/test-runtime/one-run' }
  const cleaned = []
  const dependencies = {
    removeVitestRuntimeDirectory: async (path) => { cleaned.push(path) },
  }
  const passed = await runVitestWithLifecycle(launch, {
    ...dependencies,
    runVitest: async () => 0,
  })
  const failed = await runVitestWithLifecycle(launch, {
    ...dependencies,
    runVitest: async () => 4,
  })

  assert.deepEqual(cleaned, [launch.temporaryDirectory, launch.temporaryDirectory])
  assert.deepEqual(passed, { cleanupError: null, exitCode: 0, testError: null })
  assert.deepEqual(failed, { cleanupError: null, exitCode: 4, testError: null })
})

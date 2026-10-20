import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, relative, resolve } from 'node:path'

const thisFile = fileURLToPath(import.meta.url)

export function createVitestRuntimeLaunch({
  arguments_: argumentsToVitest = [],
  cwd = process.cwd(),
  environment = process.env,
  runId = `${process.pid}-${randomUUID()}`,
} = {}) {
  if (!Array.isArray(argumentsToVitest)) {
    throw new Error('Vitest arguments must be an array.')
  }
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new Error('The Vitest runtime directory requires a non-empty run identifier.')
  }

  const repositoryRoot = resolve(cwd)
  const temporaryDirectory = resolve(repositoryRoot, '.work', 'test-runtime', runId)
  const nodeCompileCache = join(temporaryDirectory, 'node-compile-cache')
  const vitestCli = resolve(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs')

  return {
    arguments_: [vitestCli, ...argumentsToVitest],
    command: process.execPath,
    cwd: repositoryRoot,
    environment: {
      ...environment,
      NODE_COMPILE_CACHE: nodeCompileCache,
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      TMPDIR: temporaryDirectory,
    },
    temporaryDirectory,
  }
}

async function runVitest(launch) {
  await mkdir(launch.temporaryDirectory, { recursive: true })
  return new Promise((resolveExitCode, reject) => {
    const child = spawn(launch.command, launch.arguments_, {
      cwd: launch.cwd,
      env: launch.environment,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', () => reject(new Error('Vitest could not be started.')))
    child.once('close', (code) => resolveExitCode(code ?? 1))
  })
}

export async function removeVitestRuntimeDirectory(
  temporaryDirectory,
  removeDirectory = rm,
  repositoryRoot = process.cwd(),
) {
  const runtimeRoot = resolve(repositoryRoot, '.work', 'test-runtime')
  const resolvedDirectory = resolve(temporaryDirectory)
  const runtimeRelativePath = relative(runtimeRoot, resolvedDirectory)
  if (
    !runtimeRelativePath
    || runtimeRelativePath.startsWith('..')
    || isAbsolute(runtimeRelativePath)
  ) {
    throw new Error('Vitest runtime cleanup refused to remove a path outside its controlled per-run directory.')
  }
  await removeDirectory(resolvedDirectory, { force: true, recursive: true })
}

export function finalVitestExitCode(testExitCode, cleanupFailed) {
  if (testExitCode !== 0) return testExitCode
  return cleanupFailed ? 1 : 0
}

export async function runVitestWithLifecycle(launch, dependencies = {}) {
  const executeVitest = dependencies.runVitest ?? runVitest
  const removeRuntimeDirectory = dependencies.removeVitestRuntimeDirectory
    ?? ((temporaryDirectory) => removeVitestRuntimeDirectory(temporaryDirectory, rm, launch.cwd))
  let testExitCode = 1
  let testError = null
  try {
    testExitCode = await executeVitest(launch)
  } catch (error) {
    testError = error
  }

  let cleanupError = null
  try {
    await removeRuntimeDirectory(launch.temporaryDirectory)
  } catch (error) {
    cleanupError = error
  }

  return {
    cleanupError,
    exitCode: finalVitestExitCode(testExitCode, Boolean(cleanupError)),
    testError,
  }
}

async function main() {
  const launch = createVitestRuntimeLaunch({ arguments_: process.argv.slice(2) })
  const result = await runVitestWithLifecycle(launch)
  if (result.testError) {
    console.error(result.testError instanceof Error ? result.testError.message : 'Vitest could not be started.')
  }
  if (result.cleanupError) {
    console.error(`The isolated Vitest runtime directory could not be removed: ${result.cleanupError instanceof Error ? result.cleanupError.message : 'unknown error'}`)
  }
  process.exitCode = result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Vitest could not be started.')
    process.exitCode = 1
  })
}

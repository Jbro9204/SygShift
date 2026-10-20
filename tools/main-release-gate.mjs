import { lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

const gitShaPattern = /^[0-9a-f]{40}$/i
const zeroSha = '0'.repeat(40)
const mainRef = 'refs/heads/main'
const qualityTimeoutMs = 45 * 60_000
const sharedLockDirectoryName = 'sygshift-main-release-gates'
const canonicalGitHubRepository = Object.freeze({ owner: 'Jbro9204', repository: 'SygShift' })
const mainQualityWorkflowFile = 'security.yml'
const activeWorkflowStatuses = Object.freeze(['queued', 'in_progress', 'requested', 'waiting', 'pending'])
const isolatedPlaywrightPortOffset = '1000'
const childEnvironmentKeys = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'CI',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'COLUMNS',
  'FORCE_COLOR',
  'LANG',
  'LANGUAGE',
  'LINES',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TERM',
  'TZ',
  'WINDIR',
])
const proxyEnvironmentKeys = new Set(['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY'])
const noProxyEnvironmentKeys = new Set(['NO_PROXY'])
const isolatedChildEnvironmentKeys = Object.freeze([
  'APPDATA',
  'HOME',
  'LOCALAPPDATA',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_PORT_OFFSET',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
])

export class MainReleaseCommandTerminationUnconfirmedError extends Error {
  constructor() {
    super(
      'The main release-gate command timed out, and its process-tree termination could not be confirmed; '
      + 'manual verification is required before another main release attempt.',
    )
    this.code = 'SYGSHIFT_MAIN_RELEASE_TERMINATION_UNCONFIRMED'
    this.name = 'MainReleaseCommandTerminationUnconfirmedError'
  }
}

function isMainReleaseCommandTerminationUnconfirmedError(error) {
  return error instanceof MainReleaseCommandTerminationUnconfirmedError
    || error?.code === 'SYGSHIFT_MAIN_RELEASE_TERMINATION_UNCONFIRMED'
}

function normalizedSha(value) {
  return typeof value === 'string' && gitShaPattern.test(value) ? value.toLowerCase() : null
}

export function releaseGateEnvironment(environment = process.env) {
  const retained = {}
  for (const [key, value] of Object.entries(environment ?? {})) {
    const normalizedKey = key.toUpperCase()
    if (typeof value !== 'string') continue
    if (childEnvironmentKeys.has(normalizedKey) || /^LC_[A-Z0-9_]+$/u.test(normalizedKey)) {
      retained[key] = value
      continue
    }
    if (noProxyEnvironmentKeys.has(normalizedKey)) {
      retained[key] = value
      continue
    }
    if (!proxyEnvironmentKeys.has(normalizedKey)) continue
    try {
      const proxy = new URL(value)
      if (
        (proxy.protocol === 'http:' || proxy.protocol === 'https:')
        && !proxy.username
        && !proxy.password
        && proxy.pathname === '/'
        && !proxy.search
        && !proxy.hash
      ) {
        retained[key] = value
      }
    } catch {
      // A malformed or credential-bearing proxy must not reach the isolated gate.
    }
  }
  return retained
}

function isolatedChildEnvironment(environment) {
  const retained = {}
  for (const key of isolatedChildEnvironmentKeys) {
    const value = environment?.[key]
    if (typeof value === 'string' && value) retained[key] = value
  }
  return retained
}

export function parseGitHubRepository(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null
  const trimmed = remoteUrl.trim().replace(/\.git$/iu, '')
  const httpsMatch = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/iu.exec(trimmed)
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/iu.exec(trimmed)
  const match = httpsMatch ?? sshMatch
  if (!match) return null
  const [, owner, repository] = match
  return owner && repository ? { owner, repository } : null
}

function sameGitHubRepository(left, right) {
  return left?.owner?.toLowerCase() === right?.owner?.toLowerCase()
    && left?.repository?.toLowerCase() === right?.repository?.toLowerCase()
}

function isAbsolutePathOnSupportedHost(path) {
  return typeof path === 'string'
    && (isAbsolute(path) || /^[a-z]:[\\/]/iu.test(path))
}

function commandLabel(command, arguments_) {
  return [command, ...arguments_].join(' ')
}

export function parsePrePushUpdates(input) {
  if (typeof input !== 'string') throw new Error('The Git pre-push update stream is required.')
  const updates = []
  for (const rawLine of input.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue
    const fields = line.split(/\s+/u)
    if (fields.length !== 4) {
      throw new Error('Git supplied an invalid pre-push update record.')
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields
    updates.push({ localRef, localSha, remoteRef, remoteSha })
  }
  return updates
}

function mainUpdate(updates) {
  const updatesForMain = updates.filter((update) => update.remoteRef === mainRef)
  if (updatesForMain.length > 1) {
    throw new Error('A push may contain only one update for main.')
  }
  return updatesForMain[0] ?? null
}

function validateMainUpdate(update) {
  if (update.localRef !== mainRef && update.localRef !== 'HEAD') {
    throw new Error('Main must be pushed from the checked-out local main branch.')
  }
  if (update.localSha === zeroSha) {
    throw new Error('Deleting main is blocked by the release gate.')
  }
  if (update.remoteSha === zeroSha) {
    throw new Error('The release gate requires an existing origin/main baseline.')
  }

  const localSha = normalizedSha(update.localSha)
  const remoteSha = normalizedSha(update.remoteSha)
  if (!localSha || !remoteSha) {
    throw new Error('The release gate requires full 40-character commit identifiers for main.')
  }
  return { localSha, remoteSha }
}

export function createMainReleaseCommandRunner(injected = {}) {
  const spawnImplementation = injected.spawn ?? spawn
  const platform = injected.platform ?? process.platform
  const processKill = injected.processKill ?? process.kill.bind(process)
  const treeKillSpawn = injected.treeKillSpawn ?? spawn
  const treeKillTimeoutMs = injected.treeKillTimeoutMs ?? 5_000
  const outputTailLimit = injected.outputTailLimit ?? 8_000
  const completeStdoutLimit = injected.completeStdoutLimit ?? 1_000_000
  const standardOutput = injected.stdout ?? process.stdout
  const standardError = injected.stderr ?? process.stderr

  if (!Number.isInteger(outputTailLimit) || outputTailLimit < 256) {
    throw new Error('The release-gate diagnostic tail limit must be at least 256 characters.')
  }
  if (!Number.isInteger(completeStdoutLimit) || completeStdoutLimit < outputTailLimit) {
    throw new Error('The release-gate complete stdout limit must cover the diagnostic tail.')
  }
  if (!Number.isFinite(treeKillTimeoutMs) || treeKillTimeoutMs <= 0) {
    throw new Error('The release-gate process-tree termination timeout must be positive.')
  }

  return (command, arguments_, options = {}) => new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? qualityTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(new Error('The release-gate command timeout must be positive.'))
      return
    }

    const environment = {
      ...releaseGateEnvironment(options.env ?? process.env),
      ...isolatedChildEnvironment(options.isolatedEnvironment),
    }
    const useWindowsPnpmShell = platform === 'win32' && command === 'pnpm'
    const executable = useWindowsPnpmShell ? (environment.ComSpec || environment.COMSPEC || 'cmd.exe') : command
    const executableArguments = useWindowsPnpmShell
      ? ['/d', '/s', '/c', 'pnpm', ...arguments_]
      : arguments_
    const child = spawnImplementation(executable, executableArguments, {
      cwd: options.cwd,
      ...(platform === 'win32' ? {} : { detached: true }),
      env: environment,
      shell: false,
      windowsHide: true,
    })
    let stdoutTail = ''
    let completeStdout = ''
    let completeStdoutExceeded = false
    let stderrTail = ''
    let settled = false
    let timeout = null

    const finish = (callback) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      callback()
    }

    const appendTail = (existing, chunk) => {
      const combined = existing + String(chunk)
      return combined.length > outputTailLimit ? combined.slice(-outputTailLimit) : combined
    }
    const write = (stream, chunk) => {
      try {
        stream?.write?.(String(chunk))
      } catch {
        // A closed terminal must not make a release command appear to pass.
      }
    }
    child.stdout?.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk)
      if (options.captureCompleteStdout && !completeStdoutExceeded) {
        completeStdout += String(chunk)
        if (completeStdout.length > completeStdoutLimit) {
          completeStdout = ''
          completeStdoutExceeded = true
        }
      }
      write(standardOutput, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk)
      write(standardError, chunk)
    })
    child.once('error', () => finish(() => reject(
      new Error(`Could not start release-gate command: ${commandLabel(command, arguments_)}.`),
    )))
    child.once('close', (code) => finish(() => {
      if (code === 0) {
        if (completeStdoutExceeded) {
          reject(new Error(
            `Release-gate command produced more than ${completeStdoutLimit} characters of structural stdout: ${commandLabel(command, arguments_)}.`,
          ))
          return
        }
        resolve({
          stderr: stderrTail,
          stdout: options.captureCompleteStdout ? completeStdout : stdoutTail,
        })
        return
      }
      const diagnosticTail = `${stderrTail}${stdoutTail}`.slice(-outputTailLimit).trim()
      const diagnostic = diagnosticTail ? ` Last output: ${diagnosticTail}` : ''
      reject(new Error(`Release-gate command failed: ${commandLabel(command, arguments_)}.${diagnostic}`))
    }))
    timeout = setTimeout(() => {
      finish(() => {
        const timeoutError = () => reject(
          new Error(`Release-gate command timed out: ${commandLabel(command, arguments_)}.`),
        )
        const terminationUnconfirmedError = () => reject(
          new MainReleaseCommandTerminationUnconfirmedError(),
        )
        const killDirectChild = () => {
          try {
            child.kill()
          } catch {
            // The tree termination error below remains the safe result.
          }
        }

        if (!Number.isInteger(child.pid) || child.pid <= 0) {
          killDirectChild()
          terminationUnconfirmedError()
          return
        }

        if (platform === 'win32') {
          try {
            const killer = treeKillSpawn(
              'taskkill.exe',
              ['/PID', String(child.pid), '/T', '/F'],
              {
                env: environment,
                shell: false,
                stdio: 'ignore',
                windowsHide: true,
              },
            )
            let treeKillSettled = false
            const treeKillDeadline = setTimeout(() => {
              if (treeKillSettled) return
              treeKillSettled = true
              killDirectChild()
              terminationUnconfirmedError()
            }, treeKillTimeoutMs)
            const completeTreeKill = (succeeded) => {
              if (treeKillSettled) return
              treeKillSettled = true
              clearTimeout(treeKillDeadline)
              if (!succeeded) killDirectChild()
              if (succeeded) timeoutError()
              else terminationUnconfirmedError()
            }
            killer.once('error', () => completeTreeKill(false))
            killer.once('close', (code) => completeTreeKill(code === 0))
          } catch {
            killDirectChild()
            terminationUnconfirmedError()
          }
          return
        }

        try {
          // A detached POSIX child is the leader of its own process group. Killing
          // that group prevents pnpm, Playwright, and browser descendants from
          // continuing the candidate verification after its deadline.
          processKill(-child.pid, 'SIGKILL')
          timeoutError()
        } catch {
          killDirectChild()
          terminationUnconfirmedError()
        }
      })
    }, timeoutMs)
  })
}

async function git(dependencies, arguments_, cwd, options = {}) {
  return dependencies.run('git', arguments_, {
    cwd,
    timeoutMs: qualityTimeoutMs,
    ...options,
  })
}

async function readSha(dependencies, cwd, reference, label) {
  const result = await git(dependencies, ['rev-parse', reference], cwd)
  const value = normalizedSha(result.stdout.trim())
  if (!value) throw new Error(`The release gate could not read a full commit identifier for ${label}.`)
  return value
}

async function requireExactMainCandidate(dependencies, repositoryRoot, expectedLocalSha, expectedRemoteSha) {
  const branch = await git(dependencies, ['branch', '--show-current'], repositoryRoot)
  if (branch.stdout.trim() !== 'main') {
    throw new Error('The release gate must run from the checked-out main branch.')
  }

  const status = await git(
    dependencies,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    repositoryRoot,
  )
  if (status.stdout.trim()) {
    throw new Error('Main release candidates require a clean working tree, including no untracked files.')
  }

  await git(dependencies, ['fetch', '--quiet', 'origin', 'main'], repositoryRoot)
  const localSha = await readSha(dependencies, repositoryRoot, 'HEAD', 'HEAD')
  const remoteSha = await readSha(dependencies, repositoryRoot, 'origin/main', 'origin/main')
  if (localSha !== expectedLocalSha) {
    throw new Error('The checked-out HEAD does not match the main commit being pushed.')
  }
  if (remoteSha !== expectedRemoteSha) {
    throw new Error('origin/main changed while the release candidate was being verified.')
  }

  try {
    await git(dependencies, ['merge-base', '--is-ancestor', remoteSha, localSha], repositoryRoot)
  } catch {
    throw new Error('Main release candidates must be fast-forward updates of origin/main.')
  }
}

async function requireCanonicalMainPushTarget(dependencies, repositoryRoot, remoteName, remoteUrl) {
  if (remoteName !== 'origin') {
    throw new Error('Main can be pushed only through the canonical origin remote.')
  }
  const targetRepository = parseGitHubRepository(remoteUrl)
  if (!targetRepository) {
    throw new Error('The main push target must identify the canonical GitHub repository.')
  }
  const origin = await git(dependencies, ['remote', 'get-url', 'origin'], repositoryRoot)
  const originRepository = parseGitHubRepository(origin.stdout)
  if (!originRepository) {
    throw new Error('The release gate could not identify the canonical origin GitHub repository.')
  }
  if (!sameGitHubRepository(originRepository, canonicalGitHubRepository)) {
    throw new Error('The canonical origin must identify Jbro9204/SygShift before main can be pushed.')
  }
  if (!sameGitHubRepository(targetRepository, canonicalGitHubRepository)) {
    throw new Error('The main push target must identify the canonical Jbro9204/SygShift GitHub repository.')
  }
  if (!sameGitHubRepository(targetRepository, originRepository)) {
    throw new Error('The main push target does not match the canonical origin GitHub repository.')
  }
}

async function requireNoQueuedMainChecks(dependencies, repositoryRoot, candidateSha) {
  if (typeof dependencies.fetch !== 'function') {
    throw new Error('The release gate cannot confirm the current main quality run.')
  }
  const remote = await git(dependencies, ['remote', 'get-url', 'origin'], repositoryRoot)
  const repository = parseGitHubRepository(remote.stdout)
  if (!repository) {
    throw new Error('The release gate could not identify the GitHub repository for main quality verification.')
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'User-Agent': 'sygshift-main-release-gate',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  for (const status of activeWorkflowStatuses) {
    // Query this exact push-triggered quality workflow and each active status
    // directly. Fetching all workflow history has a GitHub pagination cap and
    // would eventually make healthy repositories permanently unpushable because
    // of old completed runs.
    const query = new URLSearchParams({
      branch: 'main',
      event: 'push',
      per_page: '100',
      status,
    })
    let expectedTotal = null
    let inspected = 0
    let page = 1
    while (true) {
      query.set('page', String(page))
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      let response
      try {
        response = await dependencies.fetch(
          `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/actions/workflows/${encodeURIComponent(mainQualityWorkflowFile)}/runs?${query}`,
          { headers, signal: controller.signal },
        )
      } catch {
        throw new Error('The release gate could not confirm whether an earlier main quality run is still active.')
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) {
        throw new Error('The release gate could not confirm whether an earlier main quality run is still active.')
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('The release gate received an invalid main quality status response.')
      }
      if (!Array.isArray(payload?.workflow_runs) || !Number.isInteger(payload?.total_count) || payload.total_count < 0) {
        throw new Error('The release gate received an invalid main quality status response.')
      }
      if (expectedTotal === null) expectedTotal = payload.total_count
      if (payload.total_count !== expectedTotal) {
        throw new Error('The release gate could not confirm a stable main quality status while it was being checked.')
      }

      for (const run of payload.workflow_runs) {
        if (!run || typeof run !== 'object' || typeof run.head_branch !== 'string' || typeof run.head_sha !== 'string' || typeof run.status !== 'string') {
          throw new Error('The release gate received an invalid main quality status response.')
        }
        if (
          activeWorkflowStatuses.includes(run.status)
          && run.head_branch === 'main'
          && run.head_sha.toLowerCase() !== candidateSha
        ) {
          throw new Error('An earlier main quality run is still queued or running. Wait for its exact SHA to finish before pushing another main update.')
        }
      }

      inspected += payload.workflow_runs.length
      if (inspected > expectedTotal) {
        throw new Error('The release gate received an inconsistent main quality status response.')
      }
      if (inspected >= expectedTotal) break
      if (payload.workflow_runs.length < 100 || page >= 100) {
        throw new Error('The release gate could not inspect every current main quality run.')
      }
      page += 1
    }
  }
}

async function requireCleanCandidateWorktree(dependencies, candidatePath, expectedSha) {
  const candidateSha = await readSha(dependencies, candidatePath, 'HEAD', 'the detached candidate')
  if (candidateSha !== expectedSha) {
    throw new Error('The detached release candidate does not match the commit being pushed.')
  }
  const status = await git(
    dependencies,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    candidatePath,
  )
  if (status.stdout.trim()) {
    throw new Error('The detached release candidate changed during quality verification.')
  }
}

async function defaultTemporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'sygshift-main-release-'))
}

function reviewedPlaywrightBrowsersPath(inheritedEnvironment) {
  const configuredPath = inheritedEnvironment?.PLAYWRIGHT_BROWSERS_PATH
  if (isAbsolutePathOnSupportedHost(configuredPath)) return configuredPath

  const localAppData = inheritedEnvironment?.LOCALAPPDATA
  if (isAbsolutePathOnSupportedHost(localAppData)) return join(localAppData, 'ms-playwright')

  const home = inheritedEnvironment?.HOME
  if (isAbsolutePathOnSupportedHost(home)) return join(home, '.cache', 'ms-playwright')

  throw new Error('The release gate could not determine a reviewed Playwright browser cache path.')
}

export async function createIsolatedCandidateEnvironment(temporaryDirectory, inheritedEnvironment = process.env) {
  const runtimeRoot = join(temporaryDirectory, 'runtime')
  const cacheDirectory = join(runtimeRoot, 'cache')
  const configDirectory = join(runtimeRoot, 'config')
  const temporaryDirectoryForChild = join(runtimeRoot, 'tmp')
  const appDataDirectory = join(runtimeRoot, 'appdata')
  const localAppDataDirectory = join(runtimeRoot, 'localappdata')
  await Promise.all([
    mkdir(cacheDirectory, { mode: 0o700, recursive: true }),
    mkdir(configDirectory, { mode: 0o700, recursive: true }),
    mkdir(temporaryDirectoryForChild, { mode: 0o700, recursive: true }),
    mkdir(appDataDirectory, { mode: 0o700, recursive: true }),
    mkdir(localAppDataDirectory, { mode: 0o700, recursive: true }),
  ])
  const isolatedEnvironment = {
    APPDATA: appDataDirectory,
    HOME: runtimeRoot,
    LOCALAPPDATA: localAppDataDirectory,
    TEMP: temporaryDirectoryForChild,
    TMP: temporaryDirectoryForChild,
    TMPDIR: temporaryDirectoryForChild,
    USERPROFILE: runtimeRoot,
    PLAYWRIGHT_BROWSERS_PATH: reviewedPlaywrightBrowsersPath(inheritedEnvironment),
    // The main test range is frequently occupied by interactive/local tooling.
    // Candidate verification owns a separate range so it cannot collide with it.
    PLAYWRIGHT_PORT_OFFSET: isolatedPlaywrightPortOffset,
    XDG_CACHE_HOME: cacheDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_RUNTIME_DIR: temporaryDirectoryForChild,
  }
  return {
    environment: {
      ...releaseGateEnvironment(inheritedEnvironment),
      ...isolatedEnvironment,
    },
    isolatedEnvironment,
  }
}

async function defaultRemoveTemporaryDirectory(path) {
  const temporaryRoot = resolve(tmpdir())
  const candidateRoot = resolve(path)
  const candidateRelativePath = relative(temporaryRoot, candidateRoot)
  if (
    !candidateRelativePath
    || candidateRelativePath.startsWith('..')
    || isAbsolute(candidateRelativePath)
    || !basename(candidateRoot).startsWith('sygshift-main-release-')
  ) {
    throw new Error('The release gate refused to recursively remove a directory outside its controlled temporary root.')
  }
  await rm(candidateRoot, {
    force: true,
    maxRetries: 8,
    recursive: true,
    retryDelay: 250,
  })
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function worktreePathIdentity(path) {
  const normalizedPath = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath
}

async function isRegisteredWorktree(dependencies, repositoryRoot, candidatePath) {
  const result = await git(
    dependencies,
    ['worktree', 'list', '--porcelain'],
    repositoryRoot,
    { captureCompleteStdout: true },
  )
  const candidateIdentity = worktreePathIdentity(candidatePath)
  const worktreePaths = result.stdout
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
  if (
    worktreePaths.length === 0
    || worktreePaths.some((path) => !isAbsolutePathOnSupportedHost(path))
  ) {
    throw new Error('Git returned an invalid complete worktree inventory.')
  }
  return worktreePaths
    .some((path) => worktreePathIdentity(path) === candidateIdentity)
}

function sharedLockPathForRepository(repository, directory) {
  const identity = `${repository.owner}/${repository.repository}`.toLowerCase()
  const key = createHash('sha256').update(identity).digest('hex')
  return join(directory, `${key}.lock`)
}

const defaultLockFileSystem = Object.freeze({
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
})

function lockIncludesToken(contents, token) {
  return typeof contents === 'string' && contents.includes(`token=${token}\n`)
}

function lockValue(value) {
  return typeof value === 'string'
    ? value.replace(/[\r\n]/gu, ' ').trim() || 'not-recorded'
    : 'not-recorded'
}

function mainReleaseLockContents({
  candidate,
  candidatePath = 'not-created',
  pid,
  quarantineReason = 'not-quarantined',
  repository,
  startedAt,
  temporaryDirectory = 'not-created',
  token,
}) {
  return [
    `candidate=${lockValue(candidate)}`,
    `candidate_worktree=${lockValue(candidatePath)}`,
    `pid=${lockValue(String(pid))}`,
    `repository=${lockValue(repository)}`,
    `startedAt=${lockValue(startedAt)}`,
    `temporary_root=${lockValue(temporaryDirectory)}`,
    `quarantine_reason=${lockValue(quarantineReason)}`,
    'recovery=Verify the recorded process has stopped, review the retained candidate_worktree and temporary_root, then remove only locks whose token still matches.',
    `token=${lockValue(token)}`,
    '',
  ].join('\n')
}

function lockRecoveryMessage(lockPath) {
  return ` The lock may remain at ${lockPath}; inspect the token and recorded recovery details before manually removing it.`
}

async function removeOwnedLock(lockPath, token, fileSystem) {
  let contents
  try {
    contents = await fileSystem.readFile(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (!lockIncludesToken(contents, token)) {
    throw new Error(`The release gate will not remove a lock whose ownership changed: ${lockPath}`)
  }
  await fileSystem.unlink(lockPath)
}

async function rewriteOwnedLock(lockPath, token, contents, fileSystem) {
  let existing
  try {
    existing = await fileSystem.readFile(lockPath, 'utf8')
  } catch (error) {
    throw new Error(`The release gate could not read its lock for quarantine metadata: ${lockPath}. ${error.message}`)
  }
  if (!lockIncludesToken(existing, token)) {
    throw new Error(`The release gate will not rewrite a lock whose ownership changed: ${lockPath}`)
  }
  try {
    await fileSystem.writeFile(lockPath, contents, 'utf8')
  } catch (error) {
    throw new Error(`The release gate could not write quarantine metadata.${lockRecoveryMessage(lockPath)} ${error.message}`)
  }
}

async function acquireExclusiveLock(lockPath, contents, token, conflictMessage, fileSystem) {
  let handle
  try {
    handle = await fileSystem.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `${conflictMessage} Inspect ${lockPath} and confirm the recorded process has stopped before manually removing the lock.`,
      )
    }
    throw error
  }
  let writeError = null
  try {
    await handle.writeFile(contents, 'utf8')
  } catch (error) {
    writeError = error
  }
  let closeError = null
  try {
    await handle.close()
  } catch (error) {
    closeError = error
  }
  if (writeError) {
    let removalError = null
    if (!closeError) {
      try {
        await removeOwnedLock(lockPath, token, fileSystem)
      } catch (error) {
        removalError = error
      }
    }
    const retainedLock = closeError || removalError
    const details = [
      writeError.message,
      ...(closeError ? [`The lock handle could not be closed: ${closeError.message}.`] : []),
      ...(removalError ? [`The newly-created lock could not be removed: ${removalError.message}.`] : []),
      ...(retainedLock ? [lockRecoveryMessage(lockPath)] : []),
    ].join(' ')
    throw new Error(details)
  }
  if (closeError) {
    throw new Error(`${closeError.message}${lockRecoveryMessage(lockPath)}`)
  }
}

export async function acquireMainReleaseLock({
  repositoryRoot,
  run,
  localSha,
  sharedLockDirectory = join(tmpdir(), sharedLockDirectoryName),
  fileSystem = defaultLockFileSystem,
}) {
  const localLockResult = await run('git', ['rev-parse', '--git-path', 'sygshift-main-release-gate.lock'], {
    cwd: repositoryRoot,
    timeoutMs: qualityTimeoutMs,
  })
  const reportedLocalLockPath = localLockResult.stdout.trim()
  if (!reportedLocalLockPath) throw new Error('The release gate could not determine its checkout lock path.')
  const localLockPath = isAbsolute(reportedLocalLockPath)
    ? reportedLocalLockPath
    : resolve(repositoryRoot, reportedLocalLockPath)

  const remote = await run('git', ['remote', 'get-url', 'origin'], {
    cwd: repositoryRoot,
    timeoutMs: qualityTimeoutMs,
  })
  const repository = parseGitHubRepository(remote.stdout)
  if (!repository) {
    throw new Error('The release gate could not identify the GitHub repository for its shared interprocess lock.')
  }

  const lockToken = randomUUID()
  const lockRecord = {
    candidate: localSha,
    pid: process.pid,
    repository: `${repository.owner}/${repository.repository}`,
    startedAt: new Date().toISOString(),
    token: lockToken,
  }
  const lockContents = mainReleaseLockContents(lockRecord)
  await acquireExclusiveLock(
    localLockPath,
    lockContents,
    lockToken,
    'Another main release verification is already running in this checkout.',
    fileSystem,
  )

  let sharedLockPath = null
  try {
    await fileSystem.mkdir(sharedLockDirectory, { mode: 0o700, recursive: true })
    sharedLockPath = sharedLockPathForRepository(repository, sharedLockDirectory)
    await acquireExclusiveLock(
      sharedLockPath,
      lockContents,
      lockToken,
      'Another main release verification is already running for this GitHub repository from another checkout.',
      fileSystem,
    )
  } catch (error) {
    let localRollbackError = null
    try {
      await removeOwnedLock(localLockPath, lockToken, fileSystem)
    } catch (rollbackError) {
      localRollbackError = rollbackError
    }
    if (localRollbackError) {
      throw new Error(
        `${error.message} The checkout lock could not be rolled back.${lockRecoveryMessage(localLockPath)} ${localRollbackError.message}`,
      )
    }
    throw error
  }

  let released = false
  const heldLockPaths = new Set([localLockPath, sharedLockPath])
  const release = async () => {
    if (released) return
    released = true
    const releaseFailures = []
    for (const lockPath of [...heldLockPaths]) {
      try {
        await removeOwnedLock(lockPath, lockToken, fileSystem)
        heldLockPaths.delete(lockPath)
      } catch (error) {
        releaseFailures.push({ error, lockPath })
      }
    }
    if (releaseFailures.length > 0) {
      released = false
      throw new Error(
        `The release gate could not remove one or more locks it acquired. The following locks remain held: ${[...heldLockPaths].join(', ')}. ${releaseFailures.map(({ error, lockPath }) => `${lockPath}: ${error.message}${lockRecoveryMessage(lockPath)}`).join(' ')}`,
      )
    }
  }
  release.recordQuarantine = async ({ candidatePath, quarantineReason, temporaryDirectory } = {}) => {
    if (released) {
      throw new Error('The release gate cannot record quarantine metadata after its locks were released.')
    }
    const quarantinedContents = mainReleaseLockContents({
      ...lockRecord,
      candidatePath,
      quarantineReason,
      temporaryDirectory,
    })
    const failures = []
    for (const lockPath of heldLockPaths) {
      try {
        await rewriteOwnedLock(lockPath, lockToken, quarantinedContents, fileSystem)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new Error(`The release gate could not persist all quarantine metadata. ${failures.map((error) => error.message).join(' ')}`)
    }
  }
  return release
}

async function runCandidateQualityGate(dependencies, candidatePath, candidateEnvironment) {
  const options = {
    cwd: candidatePath,
    env: candidateEnvironment.environment,
    isolatedEnvironment: candidateEnvironment.isolatedEnvironment,
    timeoutMs: qualityTimeoutMs,
  }
  await dependencies.run('pnpm', ['install', '--frozen-lockfile'], {
    ...options,
  })
  await dependencies.run('pnpm', ['audit', '--prod', '--audit-level', 'high'], {
    ...options,
  })
  await dependencies.run('pnpm', ['release:verify'], {
    ...options,
  })
}

export async function runMainReleasePrePushGate(inputOptions = {}) {
  const {
    cwd = process.cwd(),
    acquireLock = acquireMainReleaseLock,
    fetch = globalThis.fetch,
    input,
    remoteName,
    remoteUrl,
    run = createMainReleaseCommandRunner(),
    createCandidateEnvironment = createIsolatedCandidateEnvironment,
    makeTemporaryDirectory = defaultTemporaryDirectory,
    removeTemporaryDirectory = defaultRemoveTemporaryDirectory,
  } = inputOptions
  const updates = parsePrePushUpdates(input)
  const update = mainUpdate(updates)
  if (!update) return { gated: false, reason: 'main_not_updated' }

  const { localSha, remoteSha } = validateMainUpdate(update)
  const dependencies = {
    acquireLock,
    createCandidateEnvironment,
    fetch,
    makeTemporaryDirectory,
    removeTemporaryDirectory,
    run,
  }
  const root = await git(dependencies, ['rev-parse', '--show-toplevel'], cwd)
  const repositoryRoot = root.stdout.trim()
  if (!repositoryRoot) throw new Error('The release gate could not determine the repository root.')
  await requireCanonicalMainPushTarget(dependencies, repositoryRoot, remoteName, remoteUrl)

  let releaseLock = null
  let temporaryDirectory = null
  let candidatePath = null
  let candidateEnvironment = null
  let worktreeAddAttempted = false
  let worktreeAdded = false
  let worktreeRemoved = false
  let temporaryDirectoryRemoved = false
  let primaryError = null
  try {
    releaseLock = await dependencies.acquireLock({ localSha, repositoryRoot, run })
    if (typeof releaseLock !== 'function') {
      throw new Error('The release gate could not acquire its interprocess verification lock.')
    }
    await requireExactMainCandidate(dependencies, repositoryRoot, localSha, remoteSha)
    await requireNoQueuedMainChecks(dependencies, repositoryRoot, localSha)

    temporaryDirectory = await dependencies.makeTemporaryDirectory()
    if (typeof temporaryDirectory !== 'string' || !temporaryDirectory.trim()) {
      throw new Error('The release gate could not create its temporary candidate directory.')
    }
    candidateEnvironment = await dependencies.createCandidateEnvironment(temporaryDirectory)
    if (!candidateEnvironment?.environment || !candidateEnvironment?.isolatedEnvironment) {
      throw new Error('The release gate could not create its isolated candidate environment.')
    }
    candidatePath = join(temporaryDirectory, 'candidate')
    worktreeAddAttempted = true
    await git(dependencies, ['worktree', 'add', '--detach', candidatePath, localSha], repositoryRoot)
    worktreeAdded = true
    await requireCleanCandidateWorktree(dependencies, candidatePath, localSha)
    await runCandidateQualityGate(dependencies, candidatePath, candidateEnvironment)
    await requireCleanCandidateWorktree(dependencies, candidatePath, localSha)
    await requireExactMainCandidate(dependencies, repositoryRoot, localSha, remoteSha)
    await requireNoQueuedMainChecks(dependencies, repositoryRoot, localSha)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError = null
    let candidateObserved = worktreeAdded
    let retainCandidateForManualVerification = isMainReleaseCommandTerminationUnconfirmedError(primaryError)
    if (!retainCandidateForManualVerification) {
      let worktreeCleanupError = null
      let worktreePruneError = null
      try {
        const candidateMayExist = candidatePath && (worktreeAdded || await pathExists(candidatePath))
        candidateObserved ||= Boolean(candidateMayExist)
        if (candidateMayExist) {
          await git(dependencies, ['worktree', 'remove', '--force', candidatePath], repositoryRoot)
          worktreeRemoved = true
        }
      } catch (error) {
        worktreeCleanupError = error
      }
      if (worktreeAddAttempted) {
        try {
          // A failed worktree add can leave only Git's administrative record.
          // Pruning after the targeted controlled-path removal clears that stale
          // record without deleting any live worktree.
          await git(dependencies, ['worktree', 'prune', '--expire', 'now'], repositoryRoot)
        } catch (error) {
          worktreePruneError = error
          worktreeCleanupError ??= error
        }
      }
      if (
        worktreeCleanupError
        && !worktreePruneError
        && candidatePath
        && !isMainReleaseCommandTerminationUnconfirmedError(worktreeCleanupError)
      ) {
        try {
          // Git for Windows can remove the administrative worktree record and
          // then return ENOTEMPTY while walking pnpm junctions or long paths.
          // Only treat that partial removal as recoverable after Git confirms
          // the candidate is no longer registered. The uniquely controlled
          // temporary root is then removed by the guarded fs.rm path below.
          if (!await isRegisteredWorktree(dependencies, repositoryRoot, candidatePath)) {
            worktreeRemoved = true
            worktreeCleanupError = null
          }
        } catch (error) {
          worktreeCleanupError = new Error(
            `${worktreeCleanupError.message} The release gate also could not confirm whether the candidate remains registered: ${error.message}`,
          )
        }
      }
      if (worktreeCleanupError) {
        cleanupError = worktreeCleanupError
        retainCandidateForManualVerification = true
      }
      if (!retainCandidateForManualVerification && temporaryDirectory) {
        try {
          await dependencies.removeTemporaryDirectory(temporaryDirectory)
          temporaryDirectoryRemoved = true
        } catch (error) {
          cleanupError ??= error
          retainCandidateForManualVerification = true
        }
      }
    }
    if (!retainCandidateForManualVerification) {
      try {
        if (releaseLock) await releaseLock()
      } catch (error) {
        cleanupError ??= error
        retainCandidateForManualVerification = true
      }
    }
    if (retainCandidateForManualVerification) {
      const retainedCandidatePath = candidateObserved && !worktreeRemoved ? candidatePath : undefined
      const retainedTemporaryDirectory = temporaryDirectory && !temporaryDirectoryRemoved
        ? temporaryDirectory
        : undefined
      if (typeof releaseLock?.recordQuarantine === 'function') {
        try {
          await releaseLock.recordQuarantine({
            candidatePath: retainedCandidatePath,
            quarantineReason: primaryError?.code ?? cleanupError?.code ?? 'manual-recovery-required',
            temporaryDirectory: retainedTemporaryDirectory,
          })
        } catch (error) {
          cleanupError ??= error
        }
      }
      const recoveryDetails = []
      if (retainedCandidatePath) {
        recoveryDetails.push(`Candidate worktree retained at ${retainedCandidatePath}.`)
      }
      if (retainedTemporaryDirectory) {
        recoveryDetails.push(`Controlled temporary root retained at ${retainedTemporaryDirectory}.`)
      }
      if (releaseLock) {
        recoveryDetails.push('The release locks remain held until those paths are manually reviewed and cleaned.')
      } else {
        recoveryDetails.push('No release lock was acquired; do not retry until the timed-out process is verified stopped.')
      }
      const quarantineMessage = ` ${recoveryDetails.join(' ')}`
      if (primaryError instanceof Error) primaryError.message += quarantineMessage
      if (cleanupError instanceof Error) cleanupError.message += quarantineMessage
    }
    if (cleanupError && primaryError instanceof Error) {
      primaryError.message += ` Cleanup also failed: ${cleanupError.message}`
    }
    if (cleanupError && !primaryError) {
      if (isMainReleaseCommandTerminationUnconfirmedError(cleanupError)) throw cleanupError
      throw new Error(`The release-gate cleanup failed: ${cleanupError.message}`)
    }
  }

  return {
    gated: true,
    localSha,
    repositoryRoot,
    remoteSha,
  }
}

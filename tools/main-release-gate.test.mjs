import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acquireMainReleaseLock,
  createIsolatedCandidateEnvironment,
  createMainReleaseCommandRunner,
  MainReleaseCommandTerminationUnconfirmedError,
  parseGitHubRepository,
  parsePrePushUpdates,
  releaseGateEnvironment,
  runMainReleasePrePushGate,
} from './main-release-gate.mjs'

const localSha = 'a'.repeat(40)
const remoteSha = 'b'.repeat(40)
const changedSha = 'c'.repeat(40)
const zeroSha = '0'.repeat(40)

function pushInput(overrides = {}) {
  const {
    localRef = 'refs/heads/main',
    local = localSha,
    remoteRef = 'refs/heads/main',
    remote = remoteSha,
  } = overrides
  return `${localRef} ${local} ${remoteRef} ${remote}\n`
}

function createHarness(overrides = {}) {
  const calls = []
  const state = {
    branch: 'main',
    candidateHead: localSha,
    candidateRegistered: false,
    clean: true,
    head: localSha,
    mergeBaseSucceeds: true,
    originUrl: 'https://github.com/Jbro9204/SygShift.git',
    remote: remoteSha,
    ...overrides.state,
  }
  const root = 'C:/repo'
  const temporaryDirectory = 'C:/tmp/sygshift-main-release-candidate'
  const candidatePath = join(temporaryDirectory, 'candidate')
  const candidateRuntimeRoot = join(temporaryDirectory, 'runtime')
  const candidateIsolatedEnvironment = {
    APPDATA: join(candidateRuntimeRoot, 'appdata'),
    HOME: candidateRuntimeRoot,
    LOCALAPPDATA: join(candidateRuntimeRoot, 'localappdata'),
    PLAYWRIGHT_BROWSERS_PATH: 'C:/reviewed/ms-playwright',
    PLAYWRIGHT_PORT_OFFSET: '1000',
    TEMP: join(candidateRuntimeRoot, 'tmp'),
    TMP: join(candidateRuntimeRoot, 'tmp'),
    TMPDIR: join(candidateRuntimeRoot, 'tmp'),
    USERPROFILE: candidateRuntimeRoot,
    XDG_CACHE_HOME: join(candidateRuntimeRoot, 'cache'),
    XDG_CONFIG_HOME: join(candidateRuntimeRoot, 'config'),
    XDG_RUNTIME_DIR: join(candidateRuntimeRoot, 'tmp'),
  }
  let temporaryDirectoryRemoved = false
  let worktreeRemoved = false
  let releaseLockReleased = false

  const run = async (command, arguments_, options = {}) => {
    calls.push({
      arguments_,
      captureCompleteStdout: options.captureCompleteStdout,
      command,
      cwd: options.cwd,
      env: options.env,
      isolatedEnvironment: options.isolatedEnvironment,
    })
    if (command === 'git') {
      if (arguments_[0] === 'rev-parse' && arguments_[1] === '--show-toplevel') {
        return { stderr: '', stdout: `${root}\n` }
      }
      if (arguments_[0] === 'branch' && arguments_[1] === '--show-current') {
        return { stderr: '', stdout: `${state.branch}\n` }
      }
      if (arguments_[0] === 'status') {
        return { stderr: '', stdout: state.clean ? '' : '?? unexpected-file.txt\n' }
      }
      if (arguments_[0] === 'fetch') {
        if (typeof state.onFetch === 'function') state.onFetch(state)
        return { stderr: '', stdout: '' }
      }
      if (arguments_[0] === 'rev-parse' && arguments_[1] === 'HEAD') {
        const value = options.cwd === candidatePath ? state.candidateHead : state.head
        return { stderr: '', stdout: `${value}\n` }
      }
      if (arguments_[0] === 'rev-parse' && arguments_[1] === 'origin/main') {
        return { stderr: '', stdout: `${state.remote}\n` }
      }
      if (arguments_[0] === 'merge-base') {
        if (!state.mergeBaseSucceeds) throw new Error('not an ancestor')
        return { stderr: '', stdout: `${remoteSha}\n` }
      }
      if (arguments_[0] === 'remote' && arguments_[1] === 'get-url') {
        return { stderr: '', stdout: `${state.originUrl}\n` }
      }
      if (arguments_[0] === 'worktree' && arguments_[1] === 'add') {
        state.candidateRegistered = true
        return { stderr: '', stdout: '' }
      }
      if (arguments_[0] === 'worktree' && arguments_[1] === 'remove') {
        state.candidateRegistered = false
        worktreeRemoved = true
        return { stderr: '', stdout: '' }
      }
      if (arguments_[0] === 'worktree' && arguments_[1] === 'prune') {
        return { stderr: '', stdout: '' }
      }
      if (arguments_[0] === 'worktree' && arguments_[1] === 'list') {
        const candidate = state.candidateRegistered
          ? `worktree ${candidatePath}\nHEAD ${localSha}\ndetached\n\n`
          : ''
        return {
          stderr: '',
          stdout: `worktree ${root}\nHEAD ${state.head}\nbranch refs/heads/main\n\n${candidate}`,
        }
      }
    }
    if (command === 'pnpm') {
      if (typeof state.onPnpm === 'function') state.onPnpm(arguments_, state)
      if (state.failPnpm === arguments_[0]) {
        throw new Error(`pnpm ${arguments_[0]} failed`)
      }
      return { stderr: '', stdout: '' }
    }
    throw new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`)
  }

  const fetch = async () => ({
    json: async () => ({
      total_count: state.workflowRuns?.length ?? 0,
      workflow_runs: state.workflowRuns ?? [],
    }),
    ok: state.apiOk ?? true,
  })

  return {
    calls,
    candidatePath,
    candidateIsolatedEnvironment,
    fetch,
    options: {
      cwd: root,
      acquireLock: async () => async () => {
        releaseLockReleased = true
      },
      createCandidateEnvironment: async () => ({
        environment: {
          LANG: 'en_US.UTF-8',
          PATH: 'C:/toolchain/bin',
          ...candidateIsolatedEnvironment,
        },
        isolatedEnvironment: candidateIsolatedEnvironment,
      }),
      fetch,
      input: pushInput(),
      makeTemporaryDirectory: async () => temporaryDirectory,
      remoteName: 'origin',
      remoteUrl: 'https://github.com/Jbro9204/SygShift.git',
      removeTemporaryDirectory: async () => {
        temporaryDirectoryRemoved = true
      },
      run,
    },
    state,
    releaseLockReleased: () => releaseLockReleased,
    temporaryDirectoryRemoved: () => temporaryDirectoryRemoved,
    worktreeRemoved: () => worktreeRemoved,
  }
}

function runHook(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['.githooks/pre-push'], {
      cwd: process.cwd(),
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`pre-push hook exited ${code}: ${stderr}`))
    })
    child.stdin.end(input)
  })
}

function runGit(arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', arguments_, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stderr, stdout })
      else reject(new Error(`git ${arguments_.join(' ')} exited ${code}: ${stderr || stdout}`))
    })
  })
}

function isWindowsCodexSandbox() {
  return process.platform === 'win32'
    && /\\Packages\\sandbox\.[^\\]+\\AC$/iu.test(process.env.LOCALAPPDATA ?? '')
}

test('parses supported GitHub remote URL forms', () => {
  assert.deepEqual(
    parseGitHubRepository('https://github.com/Jbro9204/SygShift.git'),
    { owner: 'Jbro9204', repository: 'SygShift' },
  )
  assert.deepEqual(
    parseGitHubRepository('git@github.com:Jbro9204/SygShift.git'),
    { owner: 'Jbro9204', repository: 'SygShift' },
  )
  assert.equal(parseGitHubRepository('https://example.test/Jbro9204/SygShift.git'), null)
})

test('parses the standard pre-push update stream and rejects malformed records', () => {
  assert.deepEqual(parsePrePushUpdates(pushInput()), [{
    localRef: 'refs/heads/main',
    localSha,
    remoteRef: 'refs/heads/main',
    remoteSha,
  }])
  assert.throws(() => parsePrePushUpdates('not enough fields\n'), /invalid pre-push update record/)
})

test('streams release-gate command output while retaining a bounded diagnostic tail', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  const streamed = []
  let spawnOptions
  const runner = createMainReleaseCommandRunner({
    outputTailLimit: 256,
    platform: 'linux',
    spawn: (_executable, _arguments, options) => {
      spawnOptions = options
      return child
    },
    stderr: { write: (value) => streamed.push(`err:${value}`) },
    stdout: { write: (value) => streamed.push(`out:${value}`) },
  })
  const promise = runner('pnpm', ['release:verify'], {
    cwd: 'C:/repo',
    env: {
      KEEP: 'safe',
      PATH: 'C:/toolchain/bin',
      SYGSHIFT_RELEASE_CANARY_PASSWORD: 'must-not-reach-quality-gate',
    },
    timeoutMs: 1_000,
  })
  child.stdout.emit('data', 'quality step one\n')
  child.stderr.emit('data', 'specific failure\n')
  child.emit('close', 1)
  await assert.rejects(promise, /specific failure/)
  assert.deepEqual(streamed, ['out:quality step one\n', 'err:specific failure\n'])
  assert.equal(spawnOptions.env.KEEP, undefined)
  assert.equal(spawnOptions.env.PATH, 'C:/toolchain/bin')
  assert.equal(spawnOptions.env.SYGSHIFT_RELEASE_CANARY_PASSWORD, undefined)
  assert.deepEqual(releaseGateEnvironment({
    ALL_PROXY: 'http://proxy.example.test/credential-in-path',
    ANOTHER_KEY: 'blocked',
    CLOUDFLARE_API_TOKEN: 'blocked',
    DB_PASSWORD: 'blocked',
    DATABASE_URL: 'blocked',
    GH_TOKEN: 'blocked',
    GITHUB_TOKEN: 'blocked',
    HTTP_PROXY: 'http://proxy.example.test:8080',
    HTTPS_PROXY: 'https://username:password@proxy.example.test:8443',
    LANG: 'en_US.UTF-8',
    NO_PROXY: 'localhost,127.0.0.1',
    PATH: 'retained',
    SENTRY_DSN: 'blocked',
    SUPABASE_SERVICE_ROLE_KEY: 'blocked',
    SYGSHIFT_RELEASE_TAG: 'blocked',
    safe: 'retained',
  }), {
    HTTP_PROXY: 'http://proxy.example.test:8080',
    LANG: 'en_US.UTF-8',
    NO_PROXY: 'localhost,127.0.0.1',
    PATH: 'retained',
  })
})

test('captures complete structural stdout beyond the diagnostic tail without truncation', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  const runner = createMainReleaseCommandRunner({
    completeStdoutLimit: 16_000,
    outputTailLimit: 256,
    platform: 'linux',
    spawn: () => child,
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  })
  const candidateRecord = `worktree C:/tmp/candidate\nHEAD ${localSha}\ndetached\n\n`
  const completeInventory = `${candidateRecord}${'x'.repeat(9_000)}`
  const promise = runner('git', ['worktree', 'list', '--porcelain'], {
    captureCompleteStdout: true,
    timeoutMs: 1_000,
  })

  child.stdout.emit('data', completeInventory)
  child.emit('close', 0)

  const result = await promise
  assert.equal(result.stdout, completeInventory)
  assert.ok(result.stdout.startsWith(candidateRecord))
  assert.ok(result.stdout.length > 8_000)
})

test('isolates candidate browser verification onto the reserved Playwright port range', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sygshift-main-release-environment-test-'))
  try {
    const result = await createIsolatedCandidateEnvironment(temporaryDirectory, {
      LOCALAPPDATA: join(tmpdir(), 'reviewed-browser-cache'),
      PATH: 'C:/toolchain/bin',
      PLAYWRIGHT_PORT_OFFSET: '0',
    })
    assert.equal(result.environment.PLAYWRIGHT_PORT_OFFSET, '1000')
    assert.equal(result.isolatedEnvironment.PLAYWRIGHT_PORT_OFFSET, '1000')
    assert.equal(result.environment.PLAYWRIGHT_BROWSERS_PATH, join(tmpdir(), 'reviewed-browser-cache', 'ms-playwright'))
    assert.equal(result.environment.PLAYWRIGHT_PORT_OFFSET === '0', false)
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
})

test('terminates the complete POSIX command group when a release-gate command times out', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => assert.fail('The direct child fallback should not run when process-group termination succeeds.')
  const processKillCalls = []
  let spawnOptions
  const runner = createMainReleaseCommandRunner({
    platform: 'linux',
    processKill: (pid, signal) => {
      processKillCalls.push({ pid, signal })
      return true
    },
    spawn: (_executable, _arguments, options) => {
      spawnOptions = options
      return child
    },
  })

  await assert.rejects(runner('pnpm', ['release:verify'], { timeoutMs: 5 }), /timed out/)
  assert.equal(spawnOptions.detached, true)
  assert.deepEqual(processKillCalls, [{ pid: -4321, signal: 'SIGKILL' }])
})

test('fails closed when POSIX process-group termination cannot be confirmed', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let directKillCalls = 0
  child.kill = () => {
    directKillCalls += 1
    return true
  }
  const runner = createMainReleaseCommandRunner({
    platform: 'linux',
    processKill: () => { throw new Error('process group unavailable') },
    spawn: () => child,
  })

  await assert.rejects(
    runner('pnpm', ['release:verify'], { timeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof MainReleaseCommandTerminationUnconfirmedError)
      assert.equal(error.code, 'SYGSHIFT_MAIN_RELEASE_TERMINATION_UNCONFIRMED')
      return true
    },
  )
  assert.equal(directKillCalls, 1)
})

test('terminates the complete Windows command tree when a release-gate command times out', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => assert.fail('The direct child fallback should not run when taskkill succeeds.')
  const treeKillCalls = []
  const runner = createMainReleaseCommandRunner({
    platform: 'win32',
    spawn: () => child,
    treeKillSpawn: (command, arguments_, options) => {
      treeKillCalls.push({ arguments_, command, options })
      const killer = new EventEmitter()
      queueMicrotask(() => killer.emit('close', 0))
      return killer
    },
  })

  await assert.rejects(runner('pnpm', ['release:verify'], {
    env: {
      PATH: 'C:/toolchain/bin',
      SYGSHIFT_RELEASE_CREDENTIAL: 'must-not-reach-taskkill',
    },
    timeoutMs: 5,
  }), /timed out/)
  assert.equal(treeKillCalls.length, 1)
  assert.equal(treeKillCalls[0].command, 'taskkill.exe')
  assert.deepEqual(treeKillCalls[0].arguments_, ['/PID', '4321', '/T', '/F'])
  assert.equal(treeKillCalls[0].options.shell, false)
  assert.equal(treeKillCalls[0].options.env.PATH, 'C:/toolchain/bin')
  assert.equal('SYGSHIFT_RELEASE_CREDENTIAL' in treeKillCalls[0].options.env, false)
})

test('fails closed when Windows process-tree termination cannot be confirmed', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let directKillCalls = 0
  child.kill = () => {
    directKillCalls += 1
    return true
  }
  const runner = createMainReleaseCommandRunner({
    platform: 'win32',
    spawn: () => child,
    treeKillSpawn: () => {
      const killer = new EventEmitter()
      queueMicrotask(() => killer.emit('close', 1))
      return killer
    },
  })

  await assert.rejects(
    runner('pnpm', ['release:verify'], { timeoutMs: 5 }),
    (error) => error instanceof MainReleaseCommandTerminationUnconfirmedError,
  )
  assert.equal(directKillCalls, 1)
})

test('fails closed when process-tree termination exceeds its own deadline', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let directKillCalls = 0
  child.kill = () => {
    directKillCalls += 1
    return true
  }
  const runner = createMainReleaseCommandRunner({
    platform: 'win32',
    spawn: () => child,
    treeKillSpawn: () => new EventEmitter(),
    treeKillTimeoutMs: 5,
  })

  await assert.rejects(
    runner('pnpm', ['release:verify'], { timeoutMs: 5 }),
    (error) => error instanceof MainReleaseCommandTerminationUnconfirmedError,
  )
  assert.equal(directKillCalls, 1)
})

test('fails closed rather than claiming cleanup when a child does not expose a process identifier', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let directKillCalls = 0
  child.kill = () => {
    directKillCalls += 1
    return true
  }
  const runner = createMainReleaseCommandRunner({
    platform: 'linux',
    spawn: () => child,
  })

  await assert.rejects(
    runner('pnpm', ['release:verify'], { timeoutMs: 5 }),
    (error) => error instanceof MainReleaseCommandTerminationUnconfirmedError,
  )
  assert.equal(directKillCalls, 1)
})

test('runs the executable pre-push hook with standard input', async () => {
  await runHook(pushInput({
    localRef: 'refs/heads/feature',
    remoteRef: 'refs/heads/feature',
  }))
})

test('Git discovers the versioned hook through core.hooksPath', async (context) => {
  const temporaryRoot = join(process.cwd(), '.work')
  await mkdir(temporaryRoot, { recursive: true })
  const bareRemote = await mkdtemp(join(temporaryRoot, 'sygshift-main-release-hook-test-'))
  const hookDirectory = join(process.cwd(), '.githooks')
  try {
    await runGit(['init', '--bare', bareRemote])
    try {
      await runGit([
        '-c', `core.hooksPath=${hookDirectory}`,
        'push', bareRemote, 'HEAD:refs/heads/release-hook-smoke',
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isWindowsCodexSandbox() && (
        /NtCreateDirectoryObject\(.+msys-2\.0/isu.test(message)
        || /Could not read from remote repository/iu.test(message)
      )) {
        context.skip('The Codex Windows sandbox denies the Git for Windows MSYS hook process; normal Windows and CI execute this smoke test.')
        return
      }
      throw error
    }
  } finally {
    await rm(bareRemote, { force: true, recursive: true })
  }
})

test('does not gate a push that does not update main', async () => {
  const harness = createHarness()
  const result = await runMainReleasePrePushGate({
    ...harness.options,
    input: pushInput({
      localRef: 'refs/heads/feature',
      remoteRef: 'refs/heads/feature',
    }),
  })
  assert.deepEqual(result, { gated: false, reason: 'main_not_updated' })
  assert.deepEqual(harness.calls, [])
})

test('fails closed unless a main push uses the canonical origin and canonical GitHub target', async () => {
  const cases = [
    {
      expected: /canonical origin remote/,
      remoteName: 'backup',
      remoteUrl: 'https://github.com/Jbro9204/SygShift.git',
    },
    {
      expected: /canonical Jbro9204\/SygShift GitHub repository/,
      remoteName: 'origin',
      remoteUrl: 'https://github.com/Other/SygShift.git',
    },
    {
      expected: /canonical GitHub repository/,
      remoteName: 'origin',
      remoteUrl: 'https://git.example.test/Jbro9204/SygShift.git',
    },
    {
      expected: /canonical origin remote/,
      remoteName: 'https://github.com/Jbro9204/SygShift.git',
      remoteUrl: 'https://github.com/Jbro9204/SygShift.git',
    },
  ]
  for (const entry of cases) {
    const harness = createHarness()
    await assert.rejects(
      runMainReleasePrePushGate({ ...harness.options, ...entry }),
      entry.expected,
    )
    assert.equal(harness.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)
  }

  const mispointedOrigin = createHarness({
    state: { originUrl: 'git@github.com:Other/SygShift.git' },
  })
  await assert.rejects(
    runMainReleasePrePushGate({
      ...mispointedOrigin.options,
      remoteUrl: 'https://github.com/Other/SygShift.git',
    }),
    /canonical origin must identify Jbro9204\/SygShift/,
  )
  assert.equal(mispointedOrigin.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)

  const reviewedSshTarget = createHarness({
    state: { originUrl: 'HTTPS://GITHUB.COM/jbro9204/sygshift.git' },
  })
  const reviewedSshResult = await runMainReleasePrePushGate({
    ...reviewedSshTarget.options,
    remoteUrl: 'git@GitHub.com:JBRo9204/SYGSHIFT.git',
  })
  assert.equal(reviewedSshResult.gated, true)
})

test('rejects deletion, multiple updates, and a mismatched local main ref', async () => {
  const deletion = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...deletion.options,
      input: pushInput({ local: zeroSha }),
    }),
    /Deleting main is blocked/,
  )

  const mismatchedRef = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...mismatchedRef.options,
      input: pushInput({ localRef: 'refs/heads/release-candidate' }),
    }),
    /pushed from the checked-out local main branch/,
  )

  const multiple = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...multiple.options,
      input: `${pushInput()}${pushInput()}`,
    }),
    /only one update for main/,
  )
})

test('verifies both main:main and HEAD:main clean A-to-B candidates in a detached worktree', async () => {
  const harness = createHarness()
  const result = await runMainReleasePrePushGate(harness.options)
  assert.equal(result.gated, true)
  assert.equal(result.localSha, localSha)
  assert.equal(result.remoteSha, remoteSha)
  assert.equal('candidatePath' in result, false)

  const commands = harness.calls.map(({ arguments_, command }) => `${command} ${arguments_.join(' ')}`)
  assert.ok(commands.includes(`git worktree add --detach ${harness.candidatePath} ${localSha}`))
  assert.ok(commands.includes('pnpm install --frozen-lockfile'))
  assert.ok(commands.includes('pnpm audit --prod --audit-level high'))
  assert.ok(commands.includes('pnpm release:verify'))
  assert.ok(commands.includes(`git worktree remove --force ${harness.candidatePath}`))
  assert.equal(harness.worktreeRemoved(), true)
  assert.equal(harness.temporaryDirectoryRemoved(), true)
  assert.equal(harness.releaseLockReleased(), true)

  const candidateCommands = harness.calls.filter(({ command }) => command === 'pnpm')
  assert.equal(candidateCommands.length, 3)
  for (const command of candidateCommands) {
    assert.deepEqual(command.isolatedEnvironment, harness.candidateIsolatedEnvironment)
    assert.equal(command.env.HOME, harness.candidateIsolatedEnvironment.HOME)
    assert.equal(command.env.LOCALAPPDATA, harness.candidateIsolatedEnvironment.LOCALAPPDATA)
    assert.equal(command.env.PLAYWRIGHT_BROWSERS_PATH, 'C:/reviewed/ms-playwright')
    assert.equal(command.env.PLAYWRIGHT_PORT_OFFSET, '1000')
    assert.equal(command.env.GH_TOKEN, undefined)
    assert.equal(command.env.TMPDIR, harness.candidateIsolatedEnvironment.TMPDIR)
  }

  const headRef = createHarness()
  const headResult = await runMainReleasePrePushGate({
    ...headRef.options,
    input: pushInput({ localRef: 'HEAD' }),
  })
  assert.equal(headResult.gated, true)
})

test('fails closed when an interprocess main-release lock is already held', async () => {
  const harness = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...harness.options,
      acquireLock: async () => {
        throw new Error('lock already held')
      },
    }),
    /lock already held/,
  )
  assert.equal(harness.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)
})

test('uses a token-owned checkout lock and a repository-keyed shared lock across separate clones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sygshift-main-release-lock-test-'))
  const firstCheckout = join(directory, 'first-checkout')
  const secondCheckout = join(directory, 'second-checkout')
  const sharedLockDirectory = join(directory, 'shared-locks')
  const lockPathFor = (checkout) => join(checkout, '.git', 'main-release.lock')
  const runFor = (checkout) => async (command, arguments_) => {
    assert.equal(command, 'git')
    if (arguments_[0] === 'rev-parse') {
      assert.deepEqual(arguments_, ['rev-parse', '--git-path', 'sygshift-main-release-gate.lock'])
      return { stderr: '', stdout: `${lockPathFor(checkout)}\n` }
    }
    if (arguments_[0] === 'remote') {
      assert.deepEqual(arguments_, ['remote', 'get-url', 'origin'])
      return { stderr: '', stdout: 'https://github.com/Jbro9204/SygShift.git\n' }
    }
    throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`)
  }
  await Promise.all([
    mkdir(join(firstCheckout, '.git'), { recursive: true }),
    mkdir(join(secondCheckout, '.git'), { recursive: true }),
  ])
  try {
    const firstRelease = await acquireMainReleaseLock({
      localSha,
      repositoryRoot: firstCheckout,
      run: runFor(firstCheckout),
      sharedLockDirectory,
    })
    const contents = await readFile(lockPathFor(firstCheckout), 'utf8')
    assert.match(contents, /^candidate=a{40}$/mu)
    assert.match(contents, /^repository=Jbro9204\/SygShift$/mu)
    assert.match(contents, /^token=[0-9a-f-]+$/mu)
    await firstRelease.recordQuarantine({
      candidatePath: join(directory, 'retained-candidate'),
      quarantineReason: 'test-manual-recovery',
      temporaryDirectory: directory,
    })
    const quarantinedContents = await readFile(lockPathFor(firstCheckout), 'utf8')
    assert.match(quarantinedContents, /^candidate_worktree=.*retained-candidate$/mu)
    assert.match(quarantinedContents, /^temporary_root=.*sygshift-main-release-lock-test-/mu)
    assert.match(quarantinedContents, /^quarantine_reason=test-manual-recovery$/mu)
    assert.match(quarantinedContents, /^recovery=Verify the recorded process has stopped/mu)
    await assert.rejects(
      acquireMainReleaseLock({
        localSha: changedSha,
        repositoryRoot: secondCheckout,
        run: runFor(secondCheckout),
        sharedLockDirectory,
      }),
      /for this GitHub repository from another checkout.*confirm the recorded process has stopped/m,
    )
    await firstRelease()

    const secondRelease = await acquireMainReleaseLock({
      localSha: changedSha,
      repositoryRoot: secondCheckout,
      run: runFor(secondCheckout),
      sharedLockDirectory,
    })
    await secondRelease()
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('closes a failed newly-created lock before safely unlinking its owned token', async () => {
  const events = []
  let storedContents = ''
  const fileSystem = {
    mkdir: async () => assert.fail('The shared lock directory is not reached after a local write failure.'),
    open: async () => ({
      close: async () => {
        events.push('close')
      },
      writeFile: async (contents) => {
        storedContents = contents
        events.push('write')
        throw new Error('simulated disk failure')
      },
    }),
    readFile: async () => storedContents,
    unlink: async () => {
      events.push('unlink')
      assert.deepEqual(events, ['write', 'close', 'unlink'])
    },
  }
  const run = async (_command, arguments_) => {
    if (arguments_[0] === 'rev-parse') return { stderr: '', stdout: 'C:/repo/.git/main-release.lock\n' }
    if (arguments_[0] === 'remote') return { stderr: '', stdout: 'https://github.com/Jbro9204/SygShift.git\n' }
    throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`)
  }
  await assert.rejects(
    acquireMainReleaseLock({
      fileSystem,
      localSha,
      repositoryRoot: 'C:/repo',
      run,
      sharedLockDirectory: 'C:/shared-locks',
    }),
    /simulated disk failure/,
  )
  assert.deepEqual(events, ['write', 'close', 'unlink'])
})

test('surfaces rollback guidance when the checkout lock cannot be unlinked after shared-lock acquisition fails', async () => {
  const stored = new Map()
  let openCount = 0
  const fileSystem = {
    mkdir: async () => {},
    open: async (path) => {
      openCount += 1
      if (openCount === 2) {
        const error = new Error('shared lock already exists')
        error.code = 'EEXIST'
        throw error
      }
      return {
        close: async () => {},
        writeFile: async (contents) => {
          stored.set(path, contents)
        },
      }
    },
    readFile: async (path) => stored.get(path),
    unlink: async () => { throw new Error('simulated local rollback unlink failure') },
    writeFile: async () => assert.fail('Quarantine metadata is not reached during acquisition rollback.'),
  }
  const run = async (_command, arguments_) => {
    if (arguments_[0] === 'rev-parse') return { stderr: '', stdout: 'C:/repo/.git/main-release.lock\n' }
    if (arguments_[0] === 'remote') return { stderr: '', stdout: 'https://github.com/Jbro9204/SygShift.git\n' }
    throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`)
  }
  await assert.rejects(
    acquireMainReleaseLock({
      fileSystem,
      localSha,
      repositoryRoot: 'C:/repo',
      run,
      sharedLockDirectory: 'C:/shared-locks',
    }),
    /Another main release verification is already running.*checkout lock could not be rolled back.*lock may remain at C:\/repo\/\.git\/main-release\.lock.*simulated local rollback unlink failure/s,
  )
})

test('surfaces the exact lock path when a newly-created lock cannot be closed', async () => {
  const fileSystem = {
    mkdir: async () => assert.fail('The shared lock directory is not reached after a local close failure.'),
    open: async () => ({
      close: async () => { throw new Error('simulated close failure') },
      writeFile: async () => {},
    }),
    readFile: async () => assert.fail('A close failure must retain the lock rather than unlink it.'),
    unlink: async () => assert.fail('A close failure must retain the lock rather than unlink it.'),
    writeFile: async () => assert.fail('Quarantine metadata is not reached after a local close failure.'),
  }
  const run = async (_command, arguments_) => {
    if (arguments_[0] === 'rev-parse') return { stderr: '', stdout: 'C:/repo/.git/main-release.lock\n' }
    if (arguments_[0] === 'remote') return { stderr: '', stdout: 'https://github.com/Jbro9204/SygShift.git\n' }
    throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`)
  }
  await assert.rejects(
    acquireMainReleaseLock({
      fileSystem,
      localSha,
      repositoryRoot: 'C:/repo',
      run,
      sharedLockDirectory: 'C:/shared-locks',
    }),
    /simulated close failure.*lock may remain at C:\/repo\/\.git\/main-release\.lock/,
  )
})

test('retains recoverable guidance for both locks and permits a safe retry when normal lock release fails', async () => {
  const stored = new Map()
  let rejectUnlink = true
  const fileSystem = {
    mkdir: async () => {},
    open: async (path) => {
      if (stored.has(path)) {
        const error = new Error('already exists')
        error.code = 'EEXIST'
        throw error
      }
      return {
        close: async () => {},
        writeFile: async (contents) => {
          stored.set(path, contents)
        },
      }
    },
    readFile: async (path) => {
      if (!stored.has(path)) {
        const error = new Error('not found')
        error.code = 'ENOENT'
        throw error
      }
      return stored.get(path)
    },
    unlink: async (path) => {
      if (rejectUnlink) throw new Error(`simulated unlink failure for ${path}`)
      stored.delete(path)
    },
    writeFile: async (path, contents) => {
      stored.set(path, contents)
    },
  }
  const run = async (_command, arguments_) => {
    if (arguments_[0] === 'rev-parse') return { stderr: '', stdout: 'C:/repo/.git/main-release.lock\n' }
    if (arguments_[0] === 'remote') return { stderr: '', stdout: 'https://github.com/Jbro9204/SygShift.git\n' }
    throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`)
  }
  const release = await acquireMainReleaseLock({
    fileSystem,
    localSha,
    repositoryRoot: 'C:/repo',
    run,
    sharedLockDirectory: 'C:/shared-locks',
  })
  await assert.rejects(
    release(),
    (error) => {
      assert.match(error.message, /C:\/repo\/\.git\/main-release\.lock/)
      assert.match(error.message, /C:[\\/]shared-locks[\\/]/)
      assert.equal((error.message.match(/lock may remain at/gu) ?? []).length, 2)
      return true
    },
  )
  await release.recordQuarantine({
    quarantineReason: 'release-retry-required',
  })
  const retainedContents = [...stored.values()].join('\n')
  assert.match(retainedContents, /^quarantine_reason=release-retry-required$/mu)
  rejectUnlink = false
  await release()
  assert.equal(stored.size, 0)
})

test('rejects dirty worktrees and a checked-out SHA that does not match the pushed candidate', async () => {
  const dirty = createHarness({ state: { clean: false } })
  await assert.rejects(runMainReleasePrePushGate(dirty.options), /clean working tree/)
  assert.equal(dirty.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)

  const wrongHead = createHarness({ state: { head: changedSha } })
  await assert.rejects(runMainReleasePrePushGate(wrongHead.options), /HEAD does not match/)
  assert.equal(wrongHead.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)
})

test('rejects a stale remote tip and non-fast-forward main update', async () => {
  const stale = createHarness({ state: { remote: changedSha } })
  await assert.rejects(runMainReleasePrePushGate(stale.options), /origin\/main changed/)

  const nonFastForward = createHarness({ state: { mergeBaseSucceeds: false } })
  await assert.rejects(runMainReleasePrePushGate(nonFastForward.options), /fast-forward/)
})

test('fails closed while an earlier main quality run is queued or running', async () => {
  const harness = createHarness({
    state: {
      workflowRuns: [{
        head_branch: 'main',
        head_sha: remoteSha,
        status: 'in_progress',
      }],
    },
  })
  await assert.rejects(
    runMainReleasePrePushGate(harness.options),
    /earlier main quality run is still queued or running/,
  )
  assert.equal(harness.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)
})

test('paginates only active push quality runs for the exact security workflow', async () => {
  const harness = createHarness()
  const requestedPages = []
  const candidateRuns = Array.from({ length: 100 }, () => ({
    head_branch: 'main',
    head_sha: localSha,
    status: 'queued',
  }))
  const fetch = async (url) => {
    const parsed = new URL(url)
    const page = parsed.searchParams.get('page')
    const status = parsed.searchParams.get('status')
    assert.equal(parsed.pathname.endsWith('/actions/workflows/security.yml/runs'), true)
    assert.equal(parsed.searchParams.get('event'), 'push')
    assert.equal(status, 'queued')
    requestedPages.push(page)
    if (page === '1') {
      return {
        json: async () => ({ total_count: 101, workflow_runs: candidateRuns }),
        ok: true,
      }
    }
    return {
      json: async () => ({
        total_count: 101,
        workflow_runs: [{
          head_branch: 'main',
          head_sha: remoteSha,
          status: 'queued',
        }],
      }),
      ok: true,
    }
  }
  await assert.rejects(
    runMainReleasePrePushGate({ ...harness.options, fetch }),
    /earlier main quality run is still queued or running/,
  )
  assert.deepEqual(requestedPages, ['1', '2'])
  assert.equal(harness.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)
})

test('does not query more than one thousand completed workflow runs while checking active quality runs', async () => {
  const harness = createHarness()
  const completedHistory = Array.from({ length: 1_001 }, () => ({
    head_branch: 'main',
    head_sha: remoteSha,
    status: 'completed',
  }))
  const requestedStatuses = []
  const fetch = async (url) => {
    const parsed = new URL(url)
    const status = parsed.searchParams.get('status')
    requestedStatuses.push(status)
    assert.equal(parsed.searchParams.get('event'), 'push')
    assert.equal(parsed.pathname.endsWith('/actions/workflows/security.yml/runs'), true)
    if (status === 'completed') {
      return {
        json: async () => ({ total_count: completedHistory.length, workflow_runs: completedHistory.slice(0, 100) }),
        ok: true,
      }
    }
    return {
      json: async () => ({ total_count: 0, workflow_runs: [] }),
      ok: true,
    }
  }
  const result = await runMainReleasePrePushGate({ ...harness.options, fetch })
  assert.equal(result.gated, true)
  assert.equal(requestedStatuses.includes('completed'), false)
  assert.deepEqual(requestedStatuses.sort(), [
    'in_progress', 'in_progress',
    'pending', 'pending',
    'queued', 'queued',
    'requested', 'requested',
    'waiting', 'waiting',
  ])
})

test('fails closed when an active quality response is shorter than its declared page total', async () => {
  const harness = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...harness.options,
      fetch: async () => ({
        json: async () => ({
          total_count: 101,
          workflow_runs: Array.from({ length: 99 }, () => ({
            head_branch: 'main',
            head_sha: localSha,
            status: 'queued',
          })),
        }),
        ok: true,
      }),
    }),
    /could not inspect every current main quality run/,
  )
})

test('fails closed when the earlier-main quality status cannot be queried', async () => {
  const harness = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...harness.options,
      fetch: async () => { throw new Error('network unavailable') },
    }),
    /could not confirm whether an earlier main quality run is still active/,
  )
  assert.equal(harness.calls.some(({ arguments_ }) => arguments_[0] === 'worktree'), false)
})

test('rechecks origin/main after quality verification and blocks a release race', async () => {
  const harness = createHarness({
    state: {
      onPnpm: (arguments_, state) => {
        if (arguments_[0] === 'release:verify') state.remote = changedSha
      },
    },
  })
  await assert.rejects(
    runMainReleasePrePushGate(harness.options),
    /origin\/main changed while the release candidate was being verified/,
  )
  assert.equal(harness.worktreeRemoved(), true)
  assert.equal(harness.temporaryDirectoryRemoved(), true)
})

test('removes the freshly created candidate worktree when its quality gate fails', async () => {
  const harness = createHarness({ state: { failPnpm: 'release:verify' } })
  await assert.rejects(runMainReleasePrePushGate(harness.options), /pnpm release:verify failed/)
  assert.equal(harness.worktreeRemoved(), true)
  assert.equal(harness.temporaryDirectoryRemoved(), true)
})

test('quarantines the candidate worktree and retains its locks when process-tree termination is unconfirmed', async () => {
  const harness = createHarness()
  const originalRun = harness.options.run
  const run = async (command, arguments_, options) => {
    if (command === 'pnpm' && arguments_[0] === 'release:verify') {
      throw new MainReleaseCommandTerminationUnconfirmedError()
    }
    return originalRun(command, arguments_, options)
  }
  await assert.rejects(
    runMainReleasePrePushGate({ ...harness.options, run }),
    (error) => {
      assert.ok(error instanceof MainReleaseCommandTerminationUnconfirmedError)
      assert.match(error.message, /Candidate worktree retained at/)
      assert.match(error.message, /release locks remain held/)
      return true
    },
  )
  assert.equal(harness.worktreeRemoved(), false)
  assert.equal(harness.temporaryDirectoryRemoved(), false)
  assert.equal(harness.releaseLockReleased(), false)
})

test('records durable quarantine metadata before retaining acquired locks', async () => {
  const harness = createHarness()
  const records = []
  const release = async () => assert.fail('Quarantined locks must remain held.')
  release.recordQuarantine = async (record) => {
    records.push(record)
  }
  const originalRun = harness.options.run
  const run = async (command, arguments_, options) => {
    if (command === 'pnpm' && arguments_[0] === 'release:verify') {
      throw new MainReleaseCommandTerminationUnconfirmedError()
    }
    return originalRun(command, arguments_, options)
  }
  await assert.rejects(
    runMainReleasePrePushGate({
      ...harness.options,
      acquireLock: async () => release,
      run,
    }),
    MainReleaseCommandTerminationUnconfirmedError,
  )
  assert.deepEqual(records, [{
    candidatePath: harness.candidatePath,
    quarantineReason: 'SYGSHIFT_MAIN_RELEASE_TERMINATION_UNCONFIRMED',
    temporaryDirectory: 'C:/tmp/sygshift-main-release-candidate',
  }])
})

test('retains the candidate and locks when worktree cleanup cannot confirm process-tree termination', async () => {
  const harness = createHarness()
  const originalRun = harness.options.run
  const run = async (command, arguments_, options) => {
    if (command === 'git' && arguments_[0] === 'worktree' && arguments_[1] === 'remove') {
      throw new MainReleaseCommandTerminationUnconfirmedError()
    }
    return originalRun(command, arguments_, options)
  }
  await assert.rejects(
    runMainReleasePrePushGate({ ...harness.options, run }),
    (error) => {
      assert.ok(error instanceof MainReleaseCommandTerminationUnconfirmedError)
      assert.match(error.message, /Candidate worktree retained at/)
      assert.match(error.message, /release locks remain held/)
      return true
    },
  )
  assert.equal(harness.worktreeRemoved(), false)
  assert.equal(harness.temporaryDirectoryRemoved(), false)
  assert.equal(harness.releaseLockReleased(), false)
})

test('retains locks and quarantines the candidate when ordinary worktree cleanup fails', async () => {
  const harness = createHarness()
  const originalRun = harness.options.run
  const run = async (command, arguments_, options) => {
    if (command === 'git' && arguments_[0] === 'worktree' && arguments_[1] === 'remove') {
      throw new Error('simulated worktree cleanup failure')
    }
    return originalRun(command, arguments_, options)
  }
  await assert.rejects(
    runMainReleasePrePushGate({ ...harness.options, run }),
    /simulated worktree cleanup failure.*Candidate worktree retained at.*release locks remain held/s,
  )
  assert.equal(harness.worktreeRemoved(), false)
  assert.equal(harness.temporaryDirectoryRemoved(), false)
  assert.equal(harness.releaseLockReleased(), false)
})

test('removes the controlled temporary root when Git unregisters the candidate before returning ENOTEMPTY', async () => {
  const harness = createHarness()
  const originalRun = harness.options.run
  const run = async (command, arguments_, options) => {
    if (command === 'git' && arguments_[0] === 'worktree' && arguments_[1] === 'remove') {
      await originalRun(command, arguments_, options)
      throw new Error('Directory not empty')
    }
    return originalRun(command, arguments_, options)
  }

  const result = await runMainReleasePrePushGate({ ...harness.options, run })

  assert.equal(result.gated, true)
  assert.equal(harness.state.candidateRegistered, false)
  assert.equal(harness.temporaryDirectoryRemoved(), true)
  assert.equal(harness.releaseLockReleased(), true)
  assert.ok(harness.calls.some(({ arguments_, command }) => (
    command === 'git'
    && arguments_[0] === 'worktree'
    && arguments_[1] === 'list'
    && arguments_[2] === '--porcelain'
  )))
  assert.ok(harness.calls.some(({ arguments_, captureCompleteStdout, command }) => (
    command === 'git'
    && arguments_[0] === 'worktree'
    && arguments_[1] === 'list'
    && captureCompleteStdout === true
  )))
})

test('retains locks when controlled temporary-root cleanup fails after worktree removal', async () => {
  const harness = createHarness()
  const records = []
  const release = async () => assert.fail('The retained lock must not be released after cleanup failure.')
  release.recordQuarantine = async (record) => {
    records.push(record)
  }
  await assert.rejects(
    runMainReleasePrePushGate({
      ...harness.options,
      acquireLock: async () => release,
      removeTemporaryDirectory: async () => {
        throw new Error('simulated temporary root cleanup failure')
      },
    }),
    (error) => {
      assert.match(error.message, /simulated temporary root cleanup failure.*Controlled temporary root retained at.*release locks remain held/s)
      assert.doesNotMatch(error.message, /Candidate worktree retained at/)
      return true
    },
  )
  assert.equal(harness.worktreeRemoved(), true)
  assert.deepEqual(records, [{
    candidatePath: undefined,
    quarantineReason: 'manual-recovery-required',
    temporaryDirectory: 'C:/tmp/sygshift-main-release-candidate',
  }])
})

test('gives precise no-lock recovery guidance when termination is unconfirmed before lock acquisition', async () => {
  const harness = createHarness()
  await assert.rejects(
    runMainReleasePrePushGate({
      ...harness.options,
      acquireLock: async () => {
        throw new MainReleaseCommandTerminationUnconfirmedError()
      },
    }),
    (error) => {
      assert.ok(error instanceof MainReleaseCommandTerminationUnconfirmedError)
      assert.doesNotMatch(error.message, /release locks remain held/)
      assert.match(error.message, /No release lock was acquired; do not retry/)
      return true
    },
  )
  assert.equal(harness.worktreeRemoved(), false)
  assert.equal(harness.temporaryDirectoryRemoved(), false)
  assert.equal(harness.releaseLockReleased(), false)
})

test('cleans a partially-created candidate directory after a failed worktree add', async () => {
  const harness = createHarness()
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sygshift-main-release-'))
  const partialCandidatePath = join(temporaryDirectory, 'candidate')
  const originalRun = harness.options.run
  let temporaryDirectoryRemoved = false
  const run = async (command, arguments_, options) => {
    if (command === 'git' && arguments_[0] === 'worktree' && arguments_[1] === 'add') {
      await mkdir(partialCandidatePath)
      throw new Error('simulated partial worktree creation failure')
    }
    return originalRun(command, arguments_, options)
  }
  try {
    await assert.rejects(
      runMainReleasePrePushGate({
        ...harness.options,
        makeTemporaryDirectory: async () => temporaryDirectory,
        removeTemporaryDirectory: async (path) => {
          temporaryDirectoryRemoved = true
          await rm(path, { force: true, recursive: true })
        },
        run,
      }),
      /simulated partial worktree creation failure/,
    )
    assert.equal(harness.worktreeRemoved(), true)
    assert.equal(temporaryDirectoryRemoved, true)
    assert.equal(harness.releaseLockReleased(), true)
    assert.equal(
      harness.calls.some(({ arguments_, command }) => (
        command === 'git'
        && arguments_.join(' ') === 'worktree prune --expire now'
      )),
      true,
    )
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
})

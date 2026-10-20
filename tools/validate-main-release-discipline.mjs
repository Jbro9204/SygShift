import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const root = process.cwd()
const executeFile = promisify(execFile)

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8')
}

function requireMatch(text, expression, description, failures) {
  if (!expression.test(text)) failures.push(description)
}

function requireIncludes(text, expected, description, failures) {
  if (!text.includes(expected)) failures.push(description)
}

const [
  agents,
  buildGuide,
  hook,
  mainGate,
  nodeVersion,
  npmrc,
  packageText,
  playwrightTimeClockConfig,
  productionRelease,
  timeClockFixtureServer,
  timeClockReleaseRunner,
  workflow,
] = await Promise.all([
  read('AGENTS.md'),
  read('docs/BUILD_AND_HANDOFF_GUIDE.md'),
  read('.githooks/pre-push'),
  read('tools/main-release-gate.mjs'),
  read('.node-version'),
  read('.npmrc'),
  read('package.json'),
  read('playwright.time-clock.config.ts'),
  read('tools/production-release-core.mjs'),
  read('tools/time-clock-fixture-server.mjs'),
  read('tools/run-time-clock-release-test.mjs'),
  read('.github/workflows/security.yml'),
])

const packageJson = JSON.parse(packageText)
const failures = []

let indexedHook = ''
try {
  ({ stdout: indexedHook } = await executeFile('git', ['ls-files', '--stage', '--', '.githooks/pre-push'], { cwd: root }))
} catch {
  failures.push('The tracked pre-push hook index entry could not be read.')
}

requireIncludes(
  hook,
  'const [remoteName, remoteUrl] = process.argv.slice(2)',
  'The tracked pre-push hook must bind the actual Git push target arguments.',
  failures,
)
requireIncludes(
  hook,
  'runMainReleasePrePushGate({ input, remoteName, remoteUrl })',
  'The tracked pre-push hook must pass the actual Git push target to the versioned main release gate.',
  failures,
)
requireMatch(
  hook,
  /^#!\/usr\/bin\/env node$/mu,
  'The tracked pre-push hook must remain an executable Node entry point.',
  failures,
)
requireMatch(
  indexedHook,
  /^100755\s+[0-9a-f]{40}\s+0\t\.githooks\/pre-push\s*$/mu,
  'The tracked pre-push hook must be executable (Git mode 100755).',
  failures,
)
for (const [expected, description] of [
  ['worktree\', \'add\', \'--detach\'', 'The main release gate must validate a detached exact-candidate worktree.'],
  ['merge-base\', \'--is-ancestor\'', 'The main release gate must reject non-fast-forward main updates.'],
  ['requireNoQueuedMainChecks', 'The main release gate must reject an earlier queued or running main quality run.'],
  ['requireCanonicalMainPushTarget', 'The main release gate must bind main verification to the canonical GitHub push target.'],
  ['acquireMainReleaseLock', 'The main release gate must use an interprocess verification lock.'],
  ['createIsolatedCandidateEnvironment', 'The main release gate must isolate candidate runtime directories and home paths.'],
  ['activeWorkflowStatuses', 'The main release gate must query only active GitHub Actions states rather than unbounded history.'],
  ['recordQuarantine', 'The main release gate must persist lock recovery metadata when cleanup cannot be confirmed.'],
  ['releaseGateEnvironment', 'The main release gate must allowlist candidate command environment values.'],
  ['pnpm\', [\'install\', \'--frozen-lockfile\']', 'The main release gate must install locked dependencies in the candidate worktree.'],
  ['pnpm\', [\'audit\', \'--prod\', \'--audit-level\', \'high\']', 'The main release gate must audit production dependencies.'],
  ['pnpm\', [\'release:verify\']', 'The main release gate must run the shared complete release verification.'],
]) requireIncludes(mainGate, expected, description, failures)

const mainCandidateChecks = mainGate.match(/requireExactMainCandidate\(/gu) ?? []
if (mainCandidateChecks.length < 3) {
  failures.push('The main release gate must verify the main candidate before and after quality validation.')
}
const queuedMainCheckCalls = mainGate.match(/await requireNoQueuedMainChecks\(/gu) ?? []
if (queuedMainCheckCalls.length < 2) {
  failures.push('The main release gate must check queued main quality work both before and after candidate validation.')
}

if (packageJson.scripts?.test !== 'node tools/run-vitest.mjs run') {
  failures.push('test must run Vitest through the repository-local isolated runtime wrapper.')
}
if (packageJson.scripts?.['check:toolchain'] !== 'node tools/validate-toolchain.mjs') {
  failures.push('check:toolchain must validate the pinned release toolchain.')
}
if (!packageJson.scripts?.check?.startsWith('pnpm check:toolchain && ')) {
  failures.push('check must validate the release toolchain before application quality checks.')
}
if (packageJson.packageManager !== 'pnpm@11.25.0'
  || packageJson.engines?.node !== '24.19.0'
  || packageJson.engines?.pnpm !== '11.25.0') {
  failures.push('package.json must exactly pin Node.js 24.19.0 and pnpm 11.25.0 for local and CI parity.')
}
if (nodeVersion.trim() !== '24.19.0') {
  failures.push('.node-version must exactly pin Node.js 24.19.0.')
}
if (!/^engine-strict=true\s*$/mu.test(npmrc)) {
  failures.push('.npmrc must enforce the exact engine pin with engine-strict=true.')
}
if (packageJson.scripts?.['release:verify']
  !== 'pnpm check && pnpm test:e2e:time-clock && pnpm build') {
  failures.push('release:verify must run check, the mandatory Time Clock browser workflow, and a fresh build.')
}
if (packageJson.scripts?.['test:e2e:time-clock'] !== 'node tools/run-time-clock-release-test.mjs') {
  failures.push('test:e2e:time-clock must use the focused repository-controlled Time Clock runner.')
}
if (packageJson.scripts?.['setup:git-hooks'] !== 'git config core.hooksPath .githooks') {
  failures.push('setup:git-hooks must bind Git to the versioned hooks directory.')
}
for (const expectedTest of [
  'tools/main-release-gate.test.mjs',
  'tools/run-vitest.test.mjs',
  'tools/run-time-clock-release-test.test.mjs',
  'tools/time-clock-fixture-server.test.mjs',
  'tools/validate-toolchain.test.mjs',
  'tools/prepare-timekeeping-review-diagnostics.test.mjs',
  'node tools/validate-main-release-discipline.mjs',
]) requireIncludes(
  packageJson.scripts?.['release:test'] ?? '',
  expectedTest,
  `release:test must include ${expectedTest}.`,
  failures,
)

for (const expected of [
  "testMatch: 'time-clock-workflow.spec.ts'",
  "name: 'desktop-chromium'",
  "name: 'mobile-chromium'",
  'workers: 1',
  'forbidOnly: true',
  'retries: 0',
]) requireIncludes(
  playwrightTimeClockConfig,
  expected,
  `The focused Time Clock Playwright configuration must retain ${expected}.`,
  failures,
)
if (/webServer\s*:/u.test(playwrightTimeClockConfig)
  || /PLAYWRIGHT_(?:BROWSER|CHANNEL)/u.test(playwrightTimeClockConfig)) {
  failures.push('The focused Time Clock Playwright configuration must not inherit generic servers or environment-selected browser projects.')
}
for (const expected of [
  "require.resolve('@playwright/test/cli')",
  'process.execPath',
  "'playwright.time-clock.config.ts'",
  "'tests/e2e/time-clock-workflow.spec.ts'",
  'shell: false',
  "['SIGINT', 'SIGTERM']",
  'terminateTimeClockProcessTree',
  "additionalArguments[0] === '--'",
  'Cleanup also failed',
]) requireIncludes(
  timeClockReleaseRunner,
  expected,
  `The focused Time Clock runner must retain ${expected}.`,
  failures,
)
for (const expected of [
  "host: '127.0.0.1'",
  "'<title>Time clock regression fixture</title>'",
  "'.work', 'time-clock-release-fixture'",
  "cacheDir: join(runtimeDirectory, 'vite-cache')",
  'warmupRequest(fixtureEntryPath)',
  'waitForRequestsIdle()',
  'Time Clock fixture cache cleanup timed out.',
]) requireIncludes(
  timeClockFixtureServer,
  expected,
  `The focused Time Clock fixture server must retain ${expected}.`,
  failures,
)

const ubuntuRunnerCount = workflow.match(/^\s*runs-on:\s*ubuntu-24\.04\s*$/gmu)?.length ?? 0
if (ubuntuRunnerCount < 2) {
  failures.push('Both Security workflow jobs must use the reviewed fixed ubuntu-24.04 runner.')
}
const timeoutCount = workflow.match(/^\s*timeout-minutes:\s*(?:45|25)\s*$/gmu)?.length ?? 0
if (timeoutCount < 2) {
  failures.push('Both Security workflow jobs must retain reviewed finite timeouts.')
}
const persistCredentialsCount = workflow.match(/^\s*persist-credentials:\s*false\s*$/gmu)?.length ?? 0
if (persistCredentialsCount < 2) {
  failures.push('Every Security workflow checkout must disable persisted Git credentials.')
}
requireMatch(
  workflow,
  /^\s*cancel-in-progress:\s*false\s*$/mu,
  'Security workflow must queue same-ref work instead of canceling it.',
  failures,
)
requireMatch(
  workflow,
  /^\s*queue:\s*max\s*$/mu,
  'Security workflow must retain every pending same-ref quality run instead of replacing it.',
  failures,
)
requireIncludes(
  workflow,
  'group: security-${{ github.workflow }}-${{ github.ref }}',
  'Security workflow must scope concurrency by workflow and ref across every trigger type.',
  failures,
)
requireMatch(
  workflow,
  /^\s*test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"\s*$/mu,
  'Security workflow must assert that the checked-out commit exactly matches GitHub\'s candidate SHA.',
  failures,
)
const nonPinnedActions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gmu)]
  .map((match) => match[1])
  .filter((reference) => !reference.startsWith('./') && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u.test(reference))
if (nonPinnedActions.length) {
  failures.push(`Security workflow must pin every third-party action to an exact 40-character commit SHA: ${nonPinnedActions.join(', ')}.`)
}
for (const expected of [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413',
  'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  'github/codeql-action/init@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee',
  'github/codeql-action/analyze@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee',
  'pnpm exec playwright install --with-deps chromium',
  'fetch-depth: 0',
  'pnpm audit --prod --audit-level high',
  'version: 11.25.0',
  'node-version: 24.19.0',
  'pnpm release:verify',
  'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
  'git ls-files --stage .githooks/pre-push',
]) requireIncludes(
  workflow,
  expected,
  `Security workflow must retain ${expected}.`,
  failures,
)
if (/^\s*paths(?:-ignore)?:/mu.test(workflow)) {
  failures.push('Security workflow must not exempt documentation, deployment, or any other paths.')
}

for (const expected of [
  'one reconciled main candidate',
  'Documentation, configuration, deployment, and workflow changes are never exempt',
  'queued or running',
  'diagnose the failure',
  'newest pushed SHA is green',
]) requireIncludes(
  agents,
  expected,
  `AGENTS.md must retain the main release discipline: ${expected}.`,
  failures,
)
for (const expected of [
  'pnpm exec playwright install chromium',
  'pnpm setup:git-hooks',
  'Do not push another main update',
  'exact pushed SHA',
  'branch protection',
]) requireIncludes(
  buildGuide,
  expected,
  `Build guide must retain the release workflow instruction: ${expected}.`,
  failures,
)
requireIncludes(
  productionRelease,
  'The source commit changed during candidate verification; the candidate was not promoted.',
  'Production promotion must recheck the exact source after candidate verification.',
  failures,
)

if (failures.length) {
  throw new Error(`Main release discipline validation failed:\n- ${failures.join('\n- ')}`)
}

console.log('Main release discipline validation passed.')

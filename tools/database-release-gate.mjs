import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOwnershipManifest, readSourceTree, verifyOwnershipBaseline } from './database-migration-ownership.mjs'
import { commandEnvironment, createCommandRunner } from './production-release-core.mjs'

const productionProject = 'eqkdfrbwtioiqtjsyglg'
const ledgerQuery = 'select version,name,statements from supabase_migrations.schema_migrations order by version'
const digest = (value) => createHash('sha256').update(value).digest('hex')

// Mandatory normal-release preflight. The official CLI result stays in memory;
// neither applied SQL nor credentials are written or printed. No SQL is mutated.
export async function requireDatabaseReleaseBaseline(options, injected = {}) {
  const cwd = resolve(options.cwd)
  const environment = options.environment ?? process.env
  const baselinePath = environment.SYGSHIFT_RELEASE_MIGRATION_BASELINE
  const sygilantRoot = environment.SYGSHIFT_RELEASE_SYGILANT_ROOT
  if (!baselinePath || !isAbsolute(baselinePath) || !sygilantRoot || !isAbsolute(sygilantRoot)) {
    throw new Error('The database release gate requires explicit absolute SYGSHIFT_RELEASE_MIGRATION_BASELINE and SYGSHIFT_RELEASE_SYGILANT_ROOT paths.')
  }
  if (resolve(sygilantRoot) === cwd) throw new Error('Sygilant must use its separate owning source tree.')
  let configuredOrigin
  try { configuredOrigin = new URL(options.supabaseOrigin).origin } catch { /* fail below */ }
  if (configuredOrigin !== `https://${productionProject}.supabase.co`) {
    throw new Error('The database release gate target must match the reviewed production Supabase project.')
  }
  let reviewed
  let ownershipDecisions
  let sources
  let baselineRelativePath
  try {
    const baselineResolved = realpathSync(baselinePath)
    baselineRelativePath = relative(realpathSync(cwd), baselineResolved)
    if (!baselineRelativePath || baselineRelativePath === '..' || baselineRelativePath.startsWith('../')
      || baselineRelativePath.startsWith('..\\') || isAbsolute(baselineRelativePath)) throw new Error('Baseline outside owning repository')
    reviewed = JSON.parse(readFileSync(baselinePath, 'utf8'))
    if (reviewed.formatVersion !== 2) throw new Error('Legacy baseline')
    ownershipDecisions = JSON.parse(readFileSync(resolve(cwd, 'docs/work-orders/2026-10-19-overnight/migration-source-ownership-decisions.json'), 'utf8'))
    sources = [...readSourceTree(cwd, 'SygShift'), ...readSourceTree(sygilantRoot, 'Sygilant')]
  } catch {
    throw new Error('The database release gate cannot read the reviewed v2 baseline, ownership decisions, or both owning migration trees. No release command ran.')
  }
  const run = injected.run ?? createCommandRunner()
  const commandOptions = { cwd, env: commandEnvironment(environment), timeoutMs: 45_000 }
  try {
    await run(['exec', 'git', 'ls-files', '--error-unmatch', '--', baselineRelativePath], commandOptions)
  } catch {
    throw new Error('The reviewed database baseline must be tracked in the SygShift source repository. No release command ran.')
  }
  try {
    await run(['exec', 'git', 'diff', '--quiet', 'HEAD', '--', baselineRelativePath], commandOptions)
  } catch {
    throw new Error('The reviewed database baseline differs from committed HEAD, including staged or unstaged changes. No production ledger or release command ran.')
  }
  let ledgerFile
  try {
    const result = await run([
      'dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', productionProject,
      ledgerQuery, '-o', 'json',
    ], commandOptions)
    ledgerFile = result.stdout
  } catch {
    throw new Error('The database release gate could not capture the fresh production ledger. No release command ran; CLI output was withheld.')
  }
  let current
  try {
    const ledger = JSON.parse(ledgerFile)
    if (!Array.isArray(ledger.rows) || !ledger.rows.length) throw new Error('Missing production ledger')
    current = buildOwnershipManifest({ ledgerRows: ledger.rows, sources, capturedAt: new Date().toISOString(), ledgerSha256: digest(ledgerFile), ownershipDecisions })
  } catch {
    throw new Error('The database release gate received an invalid production ledger. No release command ran; SQL output was withheld.')
  }
  const verification = verifyOwnershipBaseline(current, reviewed, { requireReconciled: options.requireReconciled === true })
  if (!verification.accepted) {
    throw new Error(`Database migration release gate refused: ${[...verification.driftErrors, ...verification.reconciliationErrors].join('; ')}`)
  }
  return {
    accepted: true, appliedMigrations: current.entries.length,
    freshProductionLedger: true, reviewedBaselineCompared: true,
    claimsHistoryEquivalence: false, bulkMigrationPushAuthorized: false,
    requireReconciled: verification.requireReconciled,
  }
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== '--')
  if (args.some((argument) => argument !== '--require-reconciled=yes')) throw new Error('Only --require-reconciled=yes is supported; no bypass option exists.')
  const root = resolve(import.meta.dirname, '..')
  const configuration = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'))
  const result = await requireDatabaseReleaseBaseline({
    cwd: root, environment: process.env,
    supabaseOrigin: process.env.SYGSHIFT_RELEASE_SUPABASE_URL || configuration.vars?.SUPABASE_URL,
    requireReconciled: args.includes('--require-reconciled=yes'),
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'The database release gate failed.')
    process.exitCode = 1
  })
}

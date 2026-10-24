import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOwnershipManifest, readSourceTree } from './database-migration-ownership.mjs'
import { commandEnvironment, createCommandRunner } from './production-release-core.mjs'

const productionProject = 'eqkdfrbwtioiqtjsyglg'
const ledgerQuery = 'select version,name,statements from supabase_migrations.schema_migrations order by version'
const defaultDecisions = 'docs/work-orders/2026-10-19-overnight/migration-source-ownership-decisions.json'
const digest = (value) => createHash('sha256').update(value).digest('hex')

function absolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path.`)
  return resolve(value)
}

function containedPath(root, candidate) {
  const child = relative(root, candidate)
  return Boolean(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\') && !isAbsolute(child)
}

export function parseCaptureArguments(arguments_) {
  const options = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('Arguments must be --name value pairs.')
    const name = key.slice(2)
    if (options.has(name)) throw new Error(`Duplicate option: ${name}`)
    options.set(name, value)
  }
  const known = new Set(['sygshift-root', 'sygilant-root', 'output', 'ownership-decisions'])
  for (const name of options.keys()) if (!known.has(name)) throw new Error(`Unknown option: ${name}`)
  for (const required of ['sygshift-root', 'sygilant-root', 'output']) {
    if (!options.has(required)) throw new Error(`Missing --${required}`)
  }
  return {
    output: options.get('output'),
    ownershipDecisions: options.get('ownership-decisions'),
    sygilantRoot: options.get('sygilant-root'),
    sygshiftRoot: options.get('sygshift-root'),
  }
}

// Captures only the fixed Supabase migration-ledger SELECT. Raw ledger SQL stays in
// memory and is represented in the written manifest by exact checksums, never source text.
export async function captureDatabaseMigrationBaseline(options, injected = {}) {
  const sygshiftRoot = realpathSync(absolutePath(options.sygshiftRoot, 'SygShift root'))
  const sygilantRoot = realpathSync(absolutePath(options.sygilantRoot, 'Sygilant root'))
  if (sygshiftRoot === sygilantRoot) throw new Error('Sygilant must use its separate owning source tree.')

  const output = absolutePath(options.output, 'Output')
  if (!containedPath(sygshiftRoot, output)) throw new Error('Output must be a new file inside the SygShift repository.')
  if (existsSync(output)) throw new Error('Output already exists; use a new evidence path so prior baselines remain immutable.')

  const decisionsPath = options.ownershipDecisions
    ? absolutePath(options.ownershipDecisions, 'Ownership decisions')
    : resolve(sygshiftRoot, defaultDecisions)
  const ownershipDecisions = JSON.parse(readFileSync(decisionsPath, 'utf8'))
  const sources = [
    ...readSourceTree(sygshiftRoot, 'SygShift'),
    ...readSourceTree(sygilantRoot, 'Sygilant'),
  ]

  const run = injected.run ?? createCommandRunner()
  let ledgerFile
  try {
    const result = await run([
      'dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', productionProject,
      ledgerQuery, '-o', 'json',
    ], {
      cwd: sygshiftRoot,
      env: commandEnvironment(options.environment ?? process.env),
      timeoutMs: 45_000,
    })
    ledgerFile = result.stdout
  } catch {
    throw new Error('The baseline capture could not read the production migration ledger. CLI output was withheld.')
  }

  let manifest
  try {
    const ledger = JSON.parse(ledgerFile)
    if (!Array.isArray(ledger.rows) || !ledger.rows.length) throw new Error('Missing production ledger')
    manifest = buildOwnershipManifest({
      capturedAt: (injected.now ?? (() => new Date()))().toISOString(),
      ledgerRows: ledger.rows,
      ledgerSha256: digest(ledgerFile),
      ownershipDecisions,
      sources,
    })
  } catch {
    throw new Error('The baseline capture received an invalid production ledger. SQL output was withheld.')
  }

  mkdirSync(dirname(output), { recursive: true })
  const payload = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(output, payload, { encoding: 'utf8', flag: 'wx' })
  return {
    appliedMigrations: manifest.summary.appliedMigrations,
    bulkMigrationPushAuthorized: false,
    claimsHistoryEquivalence: false,
    formatVersion: manifest.formatVersion,
    output,
    sha256: digest(payload),
    sygilantSources: manifest.summary.sygilantSources,
    sygshiftSources: manifest.summary.sygshiftSources,
  }
}

async function main() {
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--')
  const result = await captureDatabaseMigrationBaseline(parseCaptureArguments(arguments_), {
    now: () => new Date(),
  })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Database baseline capture failed.')
    process.exitCode = 1
  })
}

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCommandRunner, commandEnvironment } from './production-release-core.mjs'
import { assertRuntimeRetrySafety, findRetryRaises, retrySafetyCatalogSql } from './postgres-retry-safety.mjs'

export function verifyRetryRepairSnapshot({ catalog, ledger, manifests, phase }) {
  if (!['before', 'after'].includes(phase) || !Array.isArray(catalog)) throw new Error('Invalid retry-repair verification input')
  const expected = manifests[0]?.ledgerBefore
  if (!expected || manifests.some((manifest) => manifest.ledgerBefore.md5 !== expected.md5)) throw new Error('Retry-repair ledger baselines disagree')
  const repairCount = phase === 'after' ? manifests.reduce((sum, manifest) => sum + 1 + (manifest.additionalMigrations?.length ?? 0), 0) : 0
  if (Number(ledger.original_count) !== expected.migrationCount || ledger.original_md5 !== expected.md5
    || Number(ledger.repair_count) !== repairCount || Number(ledger.total_count) !== expected.migrationCount + repairCount) {
    throw new Error('Retry-repair migration ledger drift or incomplete activation')
  }
  const byIdentity = new Map(catalog.map((row) => [row.identity, row]))
  let expectedRaises = 0
  let verifiedFunctions = 0
  for (const manifest of manifests) {
    for (const target of manifest.functions) {
      const actual = byIdentity.get(target.identity)
      if (actual?.definition_md5 !== target[phase === 'before' ? 'beforeMd5' : 'afterMd5'] || actual?.metadata_md5 !== target.metadataMd5) {
        throw new Error(`Retry-repair ${phase} fingerprint drift: ${target.identity}`)
      }
      const findings = findRetryRaises(actual.body)
      if (findings.length !== (phase === 'before' ? target.sites.length : 0)) throw new Error(`Retry-repair raise count differs: ${target.identity}`)
      expectedRaises += target.sites.length
      verifiedFunctions++
    }
  }
  if (phase === 'after') assertRuntimeRetrySafety(catalog, manifests.flatMap((manifest) => manifest.runtimeExceptions))
  return { phase, readOnly: true, verifiedFunctions, reviewedClauses: expectedRaises, catalogFunctions: catalog.length, ledgerUnchangedApartFromApprovedRepairs: true, securityMetadataUnchanged: true }
}

export async function verifyProductionRetryRepair({ cwd, sygilantRoot, phase, environment = process.env }, injected = {}) {
  if (!isAbsolute(cwd) || !isAbsolute(sygilantRoot) || !['before', 'after'].includes(phase)) throw new Error('Explicit owning roots and before/after phase are required')
  const manifests = [cwd, sygilantRoot].map((root) => JSON.parse(readFileSync(resolve(root, 'docs/reliability/postgres-retry-safety.json'), 'utf8')))
  const versions = manifests.flatMap((manifest) => [manifest.migration, ...(manifest.additionalMigrations ?? [])]).map((path) => path.match(/\/(\d+)_/u)?.[1])
  if (versions.some((version) => !/^\d{14}$/u.test(version ?? ''))) throw new Error('Invalid approved migration versions')
  const versionsSql = versions.map((version) => `'${version}'`).join(',')
  const ledgerSql = `select count(*) as total_count, count(*) filter(where version in (${versionsSql})) as repair_count, count(*) filter(where version not in (${versionsSql})) as original_count, md5(string_agg(version||':'||coalesce(name,'')||':'||coalesce(to_jsonb(statements)::text,'null'),E'\\n' order by version) filter(where version not in (${versionsSql}))) as original_md5 from supabase_migrations.schema_migrations`
  const run = injected.run ?? createCommandRunner()
  const query = async (sql) => {
    const result = await run(['dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', 'eqkdfrbwtioiqtjsyglg', `begin read only; ${sql}; rollback;`, '-o', 'json'], { cwd, env: commandEnvironment(environment), timeoutMs: 45_000 })
    return JSON.parse(result.stdout).rows
  }
  let catalog, ledger
  try { catalog = await query(retrySafetyCatalogSql); ledger = (await query(ledgerSql))[0] }
  catch { throw new Error('Read-only retry-repair catalog or ledger capture failed; diagnostic contents withheld') }
  return verifyRetryRepairSnapshot({ catalog, ledger, manifests, phase })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((value) => {
    const match = value.match(/^--(phase|sygilant-root)=(.+)$/u)
    if (!match) throw new Error('Only --phase=before|after and --sygilant-root=absolute-path are supported')
    return [match[1], match[2]]
  }))
  verifyProductionRetryRepair({ cwd: resolve(import.meta.dirname, '..'), sygilantRoot: args['sygilant-root'], phase: args.phase })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}

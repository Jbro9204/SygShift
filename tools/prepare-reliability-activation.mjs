import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyProductionRetryRepair } from './verify-postgres-retry-repair.mjs'
import { sha256 } from './postgres-retry-safety.mjs'

const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`
const dollarQuote = (value, index) => {
  const delimiter = `$reviewed_activation_${index}$`
  if (value.includes(delimiter)) throw new Error('Activation delimiter collision')
  return delimiter + value + delimiter
}

export async function buildReliabilityActivation({ cwd, sygilantRoot, sampleReportId, mode = 'rehearsal' }) {
  if (!isAbsolute(cwd) || !isAbsolute(sygilantRoot) || !['rehearsal', 'activation'].includes(mode)) throw new Error('Explicit owning roots and valid activation mode are required')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sampleReportId ?? '')) throw new Error('An explicitly selected sample report UUID is required')
  const plan = JSON.parse(readFileSync(resolve(cwd, 'docs/reliability/2026-10-31-activation-plan.json'), 'utf8'))
  if (plan.projectRef !== 'eqkdfrbwtioiqtjsyglg' || plan.formatVersion !== 1 || plan.migrations.length !== 3) throw new Error('Unrecognized reviewed activation plan')
  const { renderActivationBatch, splitAndTrimStatements } = await import(pathToFileURL(resolve(sygilantRoot, 'scripts/render-supabase-migration-activation.mjs')).href)
  const statements = []
  for (const migration of plan.migrations) {
    const root = migration.owner === 'SygShift' ? cwd : migration.owner === 'Sygilant' ? sygilantRoot : null
    if (!root || !/^supabase\/migrations\/\d+_[a-z_]+\.sql$/u.test(migration.path)) throw new Error('Invalid reviewed migration owner or path')
    const source = readFileSync(resolve(root, migration.path), 'utf8').replaceAll('\r\n', '\n')
    const batch = renderActivationBatch({ filePath: resolve(root, migration.path), source, expectedVersion: migration.version, expectedName: migration.name, expectedSourceHash: migration.sourceSha256, expectedLedgerHash: migration.ledgerSha256, expectedStatementCount: migration.statementCount })
    statements.push(...splitAndTrimStatements(batch).slice(1, -1).filter((statement) => {
      // The outer atomic wrapper takes this same ledger lock once, with the
      // stricter reviewed two-second acquisition budget. Keep source statements
      // intact; remove only these two renderer-generated wrapper statements.
      return statement.trim().toLowerCase() !== "set local lock_timeout = '5s'"
        && statement.trim().toLowerCase() !== 'lock table supabase_migrations.schema_migrations in share row exclusive mode'
    }))
  }
  const versions = plan.migrations.map((migration) => sqlLiteral(migration.version)).join(',')
  const ledgerHash = `md5(string_agg(version||':'||coalesce(name,'')||':'||coalesce(to_jsonb(statements)::text,'null'),E'\\n' order by version))`
  const sample = sqlLiteral(sampleReportId) + '::uuid'
  const protectedQuery = `select jsonb_build_object(
    'report', md5(to_jsonb(report)::text),
    'versions', (select md5(coalesce(string_agg(to_jsonb(item)::text,E'\\n' order by item.id),'')) from public.sygilant_report_versions item where item.report_id=report.id),
    'decisions', (select md5(coalesce(string_agg(to_jsonb(item)::text,E'\\n' order by item.id),'')) from public.sygilant_report_decisions item where item.report_id=report.id),
    'audit', (select md5(coalesce(string_agg(to_jsonb(item)::text,E'\\n' order by item.id),'')) from private.audit_events item where item.table_name='sygilant_reports' and item.row_id=report.id::text)
  ) from public.sygilant_reports report where report.id=${sample}`
  const sql = `-- Reviewed atomic reliability ${mode}; all three migrations are one transaction.
begin isolation level repeatable read;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
do $atomic_reliability$
declare
  protected_before jsonb;
  protected_after jsonb;
  actual_count bigint;
  actual_hash text;
  statement text;
begin
  select count(*), ${ledgerHash} into actual_count, actual_hash from supabase_migrations.schema_migrations;
  if actual_count <> ${plan.baseline.migrationCount} or actual_hash is distinct from ${sqlLiteral(plan.baseline.ledgerMd5)} then
    raise exception 'Reviewed reliability activation ledger baseline changed';
  end if;
  ${protectedQuery} into strict protected_before;
  for statement in select unnest(array[
${statements.map((statement, index) => '    ' + dollarQuote(statement, index)).join(',\n')}
  ]::text[]) loop
    execute statement;
  end loop;
  if (select count(*) from supabase_migrations.schema_migrations) <> ${plan.baseline.migrationCount + plan.migrations.length}
    or (select count(*) from supabase_migrations.schema_migrations where version in (${versions})) <> ${plan.migrations.length}
    or (select ${ledgerHash} from supabase_migrations.schema_migrations where version not in (${versions})) is distinct from ${sqlLiteral(plan.baseline.ledgerMd5)} then
    raise exception 'Reliability activation changed an unapproved ledger entry';
  end if;
  ${protectedQuery} into strict protected_after;
  if protected_before is distinct from protected_after then
    raise exception 'Reliability activation changed the selected report or its audit history';
  end if;
end;
$atomic_reliability$;
select true as all_reviewed_definitions_and_security_verified, true as sample_report_and_audit_unchanged, ${plan.migrations.length} as reviewed_migrations;
${mode === 'rehearsal' ? 'rollback' : 'commit'};
`
  return { sql, sha256: sha256(sql), mode, migrations: plan.migrations.length, mutation: mode === 'activation' ? 'committed only if every guard passes' : 'rollback-only' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).map((value) => {
      const match = value.match(/^--(mode|sygilant-root|sample-report)=(.+)$/u)
      if (!match) throw new Error('Only --mode=inspect|render-rehearsal|render-activation, --sygilant-root and --sample-report are accepted')
      return [match[1], match[2]]
    }))
    const cwd = resolve(import.meta.dirname, '..')
    if (!args.mode || args.mode === 'inspect') {
      console.log(JSON.stringify(await verifyProductionRetryRepair({ cwd, sygilantRoot: args['sygilant-root'], phase: 'before' })))
    } else if (['render-rehearsal', 'render-activation'].includes(args.mode)) {
      const result = await buildReliabilityActivation({ cwd, sygilantRoot: args['sygilant-root'], sampleReportId: args['sample-report'], mode: args.mode === 'render-rehearsal' ? 'rehearsal' : 'activation' })
      // Rendering never executes SQL. The operator separately reviews the exact
      // hash and explicitly chooses whether/where to run the generated batch.
      process.stdout.write(result.sql)
    } else throw new Error('Unknown mode; this tool never directly executes activation SQL')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

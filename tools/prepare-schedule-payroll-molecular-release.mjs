import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  unwrapTransaction,
  validateGeneratedTransaction,
} from './prepare-stability-durability-release.mjs'

export const migrationFiles = Object.freeze([
  '20261026141835_schedule_draft_timeout_repair.sql',
  '20261026142017_schedule_draft_set_based_clone.sql',
  '20261026142340_payroll_review_single_pass_sources.sql',
  '20261026142700_bound_payroll_effective_event_source.sql',
  '20261026143200_canonical_timekeeping_review_contract.sql',
  '20261026151000_schedule_edit_copy_on_write.sql',
  '20261026165217_timekeeping_due_shift_index.sql',
  '20261026165218_timekeeping_employee_shift_event_index.sql',
  '20261026165219_scheduled_runtime_molecular_repair.sql',
  '20261026170133_scheduled_runtime_index_postflight.sql',
])

export const concurrentMigrationFiles = Object.freeze([
  migrationFiles[0],
  migrationFiles[6],
  migrationFiles[7],
])

export const transactionalMigrationFiles = Object.freeze(
  migrationFiles.filter((fileName) => !concurrentMigrationFiles.includes(fileName)),
)

export const regressionFiles = Object.freeze([
  'schedule_draft_timeout_repair_regression.sql',
  'schedule_edit_copy_on_write_regression.sql',
  'payroll_review_single_pass_sources_regression.sql',
  'bounded_effective_time_event_projection_regression.sql',
  'canonical_timekeeping_review_contract_regression.sql',
  'scheduled_runtime_molecular_repair_regression.sql',
])

// Recovery templates are intentionally not emitted as production rollback SQL.
// Each one must be copied to a fresh forward migration version only after its
// reviewed boundary is re-verified. This is the dependency-safe recovery order;
// 20261026170133 is a read-only postflight and has no persistent state to undo.
export const recoveryFiles = Object.freeze([
  '20261026165219_scheduled_runtime_molecular_repair.sql',
  '20261026165218_timekeeping_employee_shift_event_index.sql',
  '20261026165217_timekeeping_due_shift_index.sql',
  // This guarded recovery reverses the coupled 142017 + 151000 schedule
  // release. The standalone 142017 recovery is only for a partial release in
  // which 151000 never committed, and must not follow this file.
  '20261026151000_schedule_edit_copy_on_write.sql',
  '20261026143200_canonical_timekeeping_review_contract.sql',
  '20261026142700_bound_payroll_effective_event_source.sql',
  '20261026142340_payroll_review_single_pass_sources.sql',
  '20261026141835_schedule_draft_timeout_repair.sql',
])

export const partialScheduleRecoveryFile =
  '20261026142017_schedule_draft_set_based_clone.sql'

function migrationIdentity(fileName) {
  const match = /^(\d{14})_(.+)\.sql$/u.exec(fileName)
  if (!match) throw new Error(`Unexpected migration filename: ${fileName}`)
  return { version: match[1], name: match[2] }
}

function sourceFor(root, directory, fileName) {
  return readFileSync(resolve(root, 'supabase', directory, fileName), 'utf8').replace(/^\uFEFF/u, '')
}

function dollarTag(fileName) {
  return `$sygshift_molecular_${migrationIdentity(fileName).version}$`
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function regressionBody(root, fileName) {
  const normalized = sourceFor(root, 'tests', fileName)
    .replace(/^\\set\s+ON_ERROR_STOP\s+on\s*(?:\r?\n)?/iu, '')
    .replace(/\bbegin\s+isolation\s+level\s+repeatable\s+read\s*;/iu, 'begin;')
  return unwrapTransaction(normalized, 'rollback', fileName)
}

function historyStatement(fileName, body) {
  const { version, name } = migrationIdentity(fileName)
  const tag = dollarTag(fileName)
  if (body.includes(tag)) throw new Error(`${fileName}: source collides with migration-history dollar tag ${tag}`)
  return `insert into supabase_migrations.schema_migrations(version, name, statements)
values (
  '${version}',
  '${name}',
  array[${tag}${body}${tag}]
);`
}

function advisoryLockSql() {
  return "select pg_advisory_xact_lock(hashtextextended('sygshift:schedule-payroll-molecular:2026-10-26', 0));"
}

function absentVersionsSql(files, label) {
  const versions = files.map((fileName) => `'${migrationIdentity(fileName).version}'`).join(', ')
  return `do $${label}_versions_absent$
declare
  existing_versions text[];
begin
  select array_agg(version order by version)
    into existing_versions
    from supabase_migrations.schema_migrations
   where version = any (array[${versions}]::text[]);

  if existing_versions is not null then
    raise exception 'Candidate migration version(s) already registered: %', existing_versions;
  end if;
end
$${label}_versions_absent$;`
}

function requiredVersionsSql(files, label) {
  const versions = files.map((fileName) => `'${migrationIdentity(fileName).version}'`).join(', ')
  return `do $${label}_versions_present$
declare
  missing_versions text[];
begin
  select array_agg(candidate.version order by candidate.version)
    into missing_versions
    from unnest(array[${versions}]::text[]) candidate(version)
   where not exists (
     select 1
       from supabase_migrations.schema_migrations applied
      where applied.version = candidate.version
   );

  if missing_versions is not null then
    raise exception 'Required migration version(s) are not registered: %', missing_versions;
  end if;
end
$${label}_versions_present$;`
}

const indexBoundaries = Object.freeze({
  '20261026141835_schedule_draft_timeout_repair.sql': {
    relation: 'public.schedule_assignment_overrides_shift_employee_created_idx',
    fragments: ['schedule_assignment_overrides', '(shift_id, employee_id, created_at DESC)'],
  },
  '20261026165217_timekeeping_due_shift_index.sql': {
    relation: 'public.shifts_timekeeping_due_end_idx',
    fragments: ['shifts', '(ends_at, id)', 'WHERE (canceled_at IS NULL)'],
  },
  '20261026165218_timekeeping_employee_shift_event_index.sql': {
    relation: 'public.time_events_employee_shift_recorded_idx',
    fragments: ['time_events', '(employee_id, shift_id, recorded_at DESC, id)', 'WHERE (shift_id IS NOT NULL)'],
  },
})

function indexPostflightSql(fileName) {
  const boundary = indexBoundaries[fileName]
  if (!boundary) throw new Error(`${fileName}: online-index boundary is not registered`)
  const label = `molecular_index_${migrationIdentity(fileName).version}`
  const fragmentChecks = boundary.fragments
    .map((fragment) => `position(${sqlLiteral(fragment)} in index_definition) = 0`)
    .join('\n    or ')
  return `do $${label}$
declare
  index_definition text;
  index_valid boolean;
  index_ready boolean;
begin
  select pg_get_indexdef(index_state.indexrelid), index_state.indisvalid, index_state.indisready
    into index_definition, index_valid, index_ready
    from pg_catalog.pg_index index_state
   where index_state.indexrelid = to_regclass('${boundary.relation}');

  if index_definition is null
    or not coalesce(index_valid, false)
    or not coalesce(index_ready, false)
    or ${fragmentChecks}
  then
    raise exception 'Online index ${boundary.relation} does not match the reviewed valid and ready boundary.';
  end if;
end
$${label}$;`
}

function transactionalPhase(root, { files, label, requires = [] }) {
  const sections = files.map((fileName) => {
    const body = unwrapTransaction(sourceFor(root, 'migrations', fileName), 'commit', fileName)
    return `-- Migration: ${fileName}\n${body}\n\n${historyStatement(fileName, body)}`
  })
  const sql = `begin;
set local lock_timeout = '5s';
set local statement_timeout = '15min';
${advisoryLockSql()}
${requires.length ? `${requiredVersionsSql(requires, `${label}_required`)}\n` : ''}${absentVersionsSql(files, label)}

${sections.join('\n\n')}
commit;
`
  validateGeneratedTransaction(sql, 'commit', `${label} production phase`)
  return sql
}

function concurrentIndexArtifacts(root, fileName, sequence, requires = []) {
  const source = sourceFor(root, 'migrations', fileName).trim()
  if (/^\s*(?:begin|commit|rollback)\s*;/imu.test(source)) {
    throw new Error(`${fileName}: online index migration must not contain a transaction boundary`)
  }
  if (!/create\s+index\s+concurrently/iu.test(source)) {
    throw new Error(`${fileName}: expected CREATE INDEX CONCURRENTLY`)
  }
  const ledgerSql = `begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
${advisoryLockSql()}
${requires.length ? `${requiredVersionsSql(requires, `molecular_index_${migrationIdentity(fileName).version}_required`)}\n` : ''}${absentVersionsSql([fileName], `molecular_index_${migrationIdentity(fileName).version}`)}
${indexPostflightSql(fileName)}
${historyStatement(fileName, source)}
commit;
`
  validateGeneratedTransaction(ledgerSql, 'commit', `${fileName} ledger phase`)
  return [
    [`${String(sequence).padStart(2, '0')}-${fileName}`, `${source}\n`],
    [`${String(sequence + 1).padStart(2, '0')}-${fileName.replace(/\.sql$/u, '-ledger.sql')}`, ledgerSql],
  ]
}

export function buildProductionArtifacts({ root }) {
  const artifacts = new Map()
  for (const [name, sql] of concurrentIndexArtifacts(root, migrationFiles[0], 1)) artifacts.set(name, sql)
  artifacts.set('03-schedule-payroll-transaction.sql', transactionalPhase(root, {
    files: migrationFiles.slice(1, 6),
    label: 'molecular_schedule_payroll',
    requires: [migrationFiles[0]],
  }))
  for (const [name, sql] of concurrentIndexArtifacts(root, migrationFiles[6], 4, migrationFiles.slice(0, 6))) {
    artifacts.set(name, sql)
  }
  for (const [name, sql] of concurrentIndexArtifacts(root, migrationFiles[7], 6, migrationFiles.slice(0, 7))) {
    artifacts.set(name, sql)
  }
  artifacts.set('08-runtime-transaction.sql', transactionalPhase(root, {
    files: migrationFiles.slice(8),
    label: 'molecular_runtime',
    requires: migrationFiles.slice(0, 8),
  }))
  return artifacts
}

export function buildRehearsalSql({ root }) {
  const migrationSections = transactionalMigrationFiles.map((fileName) => {
    const body = unwrapTransaction(sourceFor(root, 'migrations', fileName), 'commit', fileName)
    return `-- Migration: ${fileName}\n${body}`
  })
  const regressionSections = regressionFiles.map((fileName) => {
    const body = regressionBody(root, fileName)
    return `-- Regression: ${fileName}\n${body}`
  })
  const sql = `begin;
set local lock_timeout = '5s';
set local statement_timeout = '15min';
${advisoryLockSql()}
${absentVersionsSql(migrationFiles, 'molecular_rehearsal')}
${concurrentMigrationFiles.map(indexPostflightSql).join('\n')}

${[...migrationSections, ...regressionSections].join('\n\n')}
rollback;
`
  validateGeneratedTransaction(sql, 'rollback', 'molecular rollback-only rehearsal')
  return sql
}

function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length !== 1 || !['--rehearsal', '--release'].includes(arguments_[0])) {
    throw new Error('Choose exactly one mode: --rehearsal or --release')
  }
  const root = resolve(import.meta.dirname, '..')
  const outputDirectory = resolve(root, 'tmp', 'schedule-payroll-molecular-release')
  mkdirSync(outputDirectory, { recursive: true })
  if (arguments_[0] === '--rehearsal') {
    const outputPath = resolve(outputDirectory, 'rollback-only-rehearsal.sql')
    writeFileSync(outputPath, buildRehearsalSql({ root }))
    console.log(`Prepared exact rollback-only rehearsal at ${outputPath}.`)
    return
  }
  const artifacts = buildProductionArtifacts({ root })
  for (const [fileName, sql] of artifacts) writeFileSync(resolve(outputDirectory, fileName), sql)
  console.log(`Prepared ${artifacts.size} ordered production phases at ${outputDirectory}.`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()

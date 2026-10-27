import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  unwrapTransaction,
  validateGeneratedTransaction,
} from './sql-transaction-boundary.mjs'

export const migrationFile =
  '20261027131606_repair_announcement_banner_delivery_contract.sql'
export const regressionFile =
  'announcement_banner_mixed_feed_contract_regression.sql'
export const migrationVersion = '20261027131606'
export const migrationName = 'repair_announcement_banner_delivery_contract'
export const expectedPreFunctionMd5 = 'bcf01b1b351b6d41694171fa0d786db0'
export const migrationLedgerTag =
  '$announcement_banner_contract_source_20261027131606$'

const functionIdentity =
  'private.announcement_workspace_record(public.announcements)'

function sourceFor(root, directory, fileName) {
  return readFileSync(resolve(root, 'supabase', directory, fileName), 'utf8')
}

function requireReviewedMigrationSource(migrationSource) {
  if (migrationSource.includes(migrationLedgerTag)) {
    throw new Error(
      `${migrationFile}: source collides with migration-history dollar tag ${migrationLedgerTag}`,
    )
  }

  const migrationBody = unwrapTransaction(migrationSource, 'commit', migrationFile)
  const requiredFragments = [
    'create or replace function private.announcement_workspace_record(announcement public.announcements)',
    "'lifecycleStatus', 'active'",
    "'canceledAt', null",
    'security definer',
    "set search_path = ''",
    'revoke all on function private.announcement_workspace_record(public.announcements)',
  ]

  for (const fragment of requiredFragments) {
    if (!migrationBody.toLowerCase().includes(fragment.toLowerCase())) {
      throw new Error(`${migrationFile}: reviewed contract fragment is missing: ${fragment}`)
    }
  }

  return migrationBody
}

function candidateAbsentSql() {
  return `do $announcement_banner_candidate_absent$
begin
  if exists (
    select 1
      from supabase_migrations.schema_migrations applied
     where applied.version = '${migrationVersion}'
        or applied.name = '${migrationName}'
  ) then
    raise exception 'Announcement banner candidate version or name is already registered.';
  end if;
end
$announcement_banner_candidate_absent$;`
}

function preflightFunctionContractSql() {
  return `do $announcement_banner_preflight$
declare
  function_oid oid := to_regprocedure('${functionIdentity}');
  definition_md5 text;
  owner_name text;
  security_definer boolean;
  volatility "char";
  configuration text[];
  access_control text;
begin
  if function_oid is null then
    raise exception 'Required function ${functionIdentity} is missing.';
  end if;

  select
    md5(pg_get_functiondef(procedure.oid)),
    pg_get_userbyid(procedure.proowner),
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proconfig,
    procedure.proacl::text
  into
    definition_md5,
    owner_name,
    security_definer,
    volatility,
    configuration,
    access_control
  from pg_catalog.pg_proc procedure
  where procedure.oid = function_oid;

  if definition_md5 is distinct from '${expectedPreFunctionMd5}' then
    raise exception 'Announcement banner mapper definition drifted from reviewed pre-release MD5.';
  end if;
  if owner_name is distinct from 'postgres'
    or security_definer is distinct from true
    or volatility is distinct from 's'
    or configuration is distinct from array['search_path=""']::text[]
    or access_control is distinct from '{postgres=X/postgres}'
  then
    raise exception 'Announcement banner mapper security metadata drifted from the reviewed boundary.';
  end if;
end
$announcement_banner_preflight$;`
}

function postflightFunctionContractSql() {
  return `do $announcement_banner_postflight$
declare
  function_oid oid := to_regprocedure('${functionIdentity}');
  function_definition text;
  definition_md5 text;
  owner_name text;
  security_definer boolean;
  volatility "char";
  configuration text[];
  access_control text;
begin
  if function_oid is null then
    raise exception 'Required function ${functionIdentity} is missing after migration.';
  end if;

  select
    pg_get_functiondef(procedure.oid),
    md5(pg_get_functiondef(procedure.oid)),
    pg_get_userbyid(procedure.proowner),
    procedure.prosecdef,
    procedure.provolatile,
    procedure.proconfig,
    procedure.proacl::text
  into
    function_definition,
    definition_md5,
    owner_name,
    security_definer,
    volatility,
    configuration,
    access_control
  from pg_catalog.pg_proc procedure
  where procedure.oid = function_oid;

  if definition_md5 is not distinct from '${expectedPreFunctionMd5}'
    or position('''lifecycleStatus''' in function_definition) = 0
    or position('''canceledAt''' in function_definition) = 0
  then
    raise exception 'Announcement banner mapper did not install the reviewed lifecycle contract.';
  end if;
  if owner_name is distinct from 'postgres'
    or security_definer is distinct from true
    or volatility is distinct from 's'
    or configuration is distinct from array['search_path=""']::text[]
    or access_control is distinct from '{postgres=X/postgres}'
  then
    raise exception 'Announcement banner mapper security metadata changed during installation.';
  end if;
end
$announcement_banner_postflight$;`
}

function historyStatement(migrationSource) {
  return `insert into supabase_migrations.schema_migrations(version, name, statements)
values (
  '${migrationVersion}',
  '${migrationName}',
  array[${migrationLedgerTag}${migrationSource}${migrationLedgerTag}]
);`
}

function historyPostflightSql(migrationSource) {
  return `do $announcement_banner_history_postflight$
declare
  recorded_statements text[];
begin
  select applied.statements
    into recorded_statements
    from supabase_migrations.schema_migrations applied
   where applied.version = '${migrationVersion}'
     and applied.name = '${migrationName}';

  if cardinality(recorded_statements) is distinct from 1
    or recorded_statements[1] is distinct from ${migrationLedgerTag}${migrationSource}${migrationLedgerTag}
  then
    raise exception 'Announcement banner migration ledger does not contain one exact full source statement.';
  end if;
end
$announcement_banner_history_postflight$;`
}

function releasePreamble() {
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';
select pg_advisory_xact_lock(
  hashtextextended('sygshift:announcement-banner-contract:2026-10-27', 0)
);
${candidateAbsentSql()}
${preflightFunctionContractSql()}`
}

export function buildAnnouncementBannerContractArtifact({ root, mode }) {
  if (!['rehearsal', 'release'].includes(mode)) {
    throw new Error('Choose exactly one mode: rehearsal or release')
  }

  const migrationSource = sourceFor(root, 'migrations', migrationFile)
  const migrationBody = requireReviewedMigrationSource(migrationSource)
  const history = historyStatement(migrationSource)
  const historyPostflight = historyPostflightSql(migrationSource)
  const commonReleaseBody = `${releasePreamble()}

-- Migration: ${migrationFile}
${migrationBody}

${postflightFunctionContractSql()}

${history}

${historyPostflight}`

  if (mode === 'rehearsal') {
    const regressionSource = sourceFor(root, 'tests', regressionFile)
    const regressionBody = unwrapTransaction(regressionSource, 'rollback', regressionFile)
    const sql = `${commonReleaseBody}

-- Regression: ${regressionFile}
${regressionBody}
rollback;
`
    validateGeneratedTransaction(sql, 'rollback', 'announcement banner rollback-only rehearsal')
    return sql
  }

  const sql = `${commonReleaseBody}
commit;
`
  validateGeneratedTransaction(sql, 'commit', 'announcement banner atomic release')
  return sql
}

function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length !== 1 || !['--rehearsal', '--release'].includes(arguments_[0])) {
    throw new Error('Choose exactly one mode: --rehearsal or --release')
  }

  const root = resolve(import.meta.dirname, '..')
  const mode = arguments_[0] === '--rehearsal' ? 'rehearsal' : 'release'
  const outputDirectory = resolve(root, 'tmp', 'announcement-banner-contract-release')
  mkdirSync(outputDirectory, { recursive: true })
  const outputPath = resolve(
    outputDirectory,
    mode === 'rehearsal' ? 'rollback-only-rehearsal.sql' : 'atomic-release.sql',
  )
  writeFileSync(outputPath, buildAnnouncementBannerContractArtifact({ root, mode }))
  console.log(
    `Prepared announcement banner contract ${mode === 'rehearsal' ? 'rollback-only rehearsal' : 'atomic release'} at ${outputPath}.`,
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()

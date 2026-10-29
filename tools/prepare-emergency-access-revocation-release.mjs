import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  unwrapTransaction,
  validateGeneratedTransaction,
} from './sql-transaction-boundary.mjs'

export const migrationFile =
  '20261029225323_emergency_access_revocation_control_plane.sql'
export const migrationVersion = '20261029225323'
export const migrationName = 'emergency_access_revocation_control_plane'
export const expectedMigrationSha256 =
  'f9bc9d56659662adaa8ec42fcebfa4412be00d890f57d44c0b19c80eda0a0335'
export const regressionFiles = Object.freeze([
  'emergency_access_revocation_control_plane_regression.sql',
  'atomic_primary_role_access_profiles_regression.sql',
])
export const migrationLedgerTag =
  '$emergency_access_revocation_source_20261029225323$'

export const expectedPreFunctionContracts = Object.freeze([
  ['private.active_admin_account_count()', '636a63614f3fe1666f6545533c3a0857', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
  ['private.admin_user_record(uuid)', '774a8a202d3531291f0d2c4ba52d3daa', true, 's', '{postgres=X/postgres,service_role=X/postgres}'],
  ['private.current_employee_id()', '36b8fee439d6ddf26bc5d3d8a1762291', true, 's', '{postgres=X/postgres,service_role=X/postgres}'],
  ['private.employee_effective_permissions(uuid)', 'aa38fb8b174e0aaf57769b62a373a2a8', true, 's', '{postgres=X/postgres}'],
  ['private.employee_is_recovery_capable_active_admin(uuid)', 'c1c0136e9c5c53b405c2ab56502d863a', true, 's', '{postgres=X/postgres}'],
  ['private.preferred_delivery_email(text,text)', 'd4fbf5510bffe6cc09f7386901aaa546', false, 'i', '{postgres=X/postgres,service_role=X/postgres}'],
  ['private.prevent_append_only_change()', 'ea78a86cca31eedd7b394561a6157168', false, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
  ['public.admin_set_employee_account_state(uuid,boolean)', '36dd6a381c597b4a2bd385562992b6ac', true, 'v', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'],
  ['public.service_link_employee_auth_account(uuid,uuid,boolean)', '6f514233248937007cec2292cb9d0e79', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
])

const requiredColumnContracts = Object.freeze([
  ['private.employee_accounts', 'employee_id', 'uuid'],
  ['private.employee_accounts', 'auth_user_id', 'uuid'],
  ['private.employee_accounts', 'activated_at', 'timestamp with time zone'],
  ['private.employee_accounts', 'disabled_at', 'timestamp with time zone'],
  ['private.employee_accounts', 'disabled_by', 'uuid'],
  ['private.employee_accounts', 'disabled_reason', 'text'],
  ['private.employee_accounts', 'must_change_password', 'boolean'],
  ['private.employee_accounts', 'password_changed_at', 'timestamp with time zone'],
  ['private.employee_accounts', 'updated_at', 'timestamp with time zone'],
  ['private.employee_contacts', 'employee_id', 'uuid'],
  ['private.employee_contacts', 'personal_email', 'text'],
  ['private.employee_contacts', 'company_email', 'text'],
  ['private.trusted_devices', 'employee_id', 'uuid'],
  ['private.trusted_devices', 'expires_at', 'timestamp with time zone'],
  ['private.trusted_devices', 'revoked_at', 'timestamp with time zone'],
  ['private.trusted_devices', 'revoked_by', 'uuid'],
  ['private.security_key_sessions', 'employee_id', 'uuid'],
  ['private.security_key_sessions', 'auth_session_id', 'uuid'],
  ['private.security_key_sessions', 'expires_at', 'timestamp with time zone'],
  ['private.security_key_sessions', 'revoked_at', 'timestamp with time zone'],
  ['private.security_key_sessions', 'revoked_by', 'uuid'],
  ['private.shared_identity_sessions', 'employee_id', 'uuid'],
  ['private.shared_identity_sessions', 'auth_user_id', 'uuid'],
  ['private.shared_identity_sessions', 'expires_at', 'timestamp with time zone'],
  ['private.shared_identity_sessions', 'revoked_at', 'timestamp with time zone'],
  ['private.platform_presence_sessions', 'employee_id', 'uuid'],
  ['private.platform_presence_sessions', 'expires_at', 'timestamp with time zone'],
  ['private.employee_push_subscriptions', 'employee_id', 'uuid'],
  ['private.employee_push_subscriptions', 'enabled', 'boolean'],
  ['private.webauthn_challenges', 'employee_id', 'uuid'],
  ['private.webauthn_challenges', 'consumed_at', 'timestamp with time zone'],
  ['private.sygilant_shared_launches', 'employee_id', 'uuid'],
  ['private.sygilant_shared_launches', 'consumed_at', 'timestamp with time zone'],
  ['private.audit_events', 'auth_user_id', 'uuid'],
  ['private.audit_events', 'employee_id', 'uuid'],
  ['private.audit_events', 'request_id', 'text'],
  ['private.audit_events', 'operation', 'text'],
  ['private.audit_events', 'old_record', 'jsonb'],
  ['private.audit_events', 'new_record', 'jsonb'],
  ['public.employees', 'id', 'uuid'],
  ['public.employees', 'username', 'text'],
  ['public.employees', 'first_name', 'text'],
  ['public.employees', 'last_name', 'text'],
  ['public.employees', 'role', 'public.app_role'],
  ['public.employees', 'status', 'public.employee_status'],
  ['public.sygilant_shared_identity_sessions', 'employee_id', 'uuid'],
  ['public.sygilant_shared_identity_sessions', 'status', 'text'],
  ['public.sygilant_shared_identity_sessions', 'session_expires_at', 'timestamp with time zone'],
  ['public.sygilant_shared_identity_sessions', 'revoked_at', 'timestamp with time zone'],
  ['public.sygilant_shared_identity_sessions', 'revocation_request_id', 'text'],
  ['public.sygilant_shared_identity_sessions', 'updated_at', 'timestamp with time zone'],
  ['auth.users', 'id', 'uuid'],
  ['auth.users', 'email', 'character varying'],
  ['auth.users', 'banned_until', 'timestamp with time zone'],
  ['auth.sessions', 'id', 'uuid'],
  ['auth.sessions', 'user_id', 'uuid'],
  ['auth.sessions', 'created_at', 'timestamp with time zone'],
  ['auth.sessions', 'not_after', 'timestamp with time zone'],
  ['auth.refresh_tokens', 'user_id', 'character varying'],
  ['auth.refresh_tokens', 'revoked', 'boolean'],
])

const postFunctionContracts = Object.freeze([
  ['private.current_employee_id()', true, 's', '{postgres=X/postgres,service_role=X/postgres}'],
  ['private.require_emergency_access_viewer(uuid)', true, 's', '{postgres=X/postgres}'],
  ['private.require_emergency_access_actor(uuid,uuid,text,timestamp with time zone)', true, 's', '{postgres=X/postgres}'],
  ['private.emergency_access_state_json(uuid)', true, 's', '{postgres=X/postgres}'],
  ['private.emergency_access_operation_payload(uuid)', true, 's', '{postgres=X/postgres}'],
  ['private.emergency_access_cleanup(uuid,uuid,uuid,uuid)', true, 'v', '{postgres=X/postgres}'],
  ['private.begin_emergency_access_operation(text,uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)', true, 'v', '{postgres=X/postgres}'],
  ['public.service_get_employee_emergency_access_state(uuid,uuid)', true, 's', '{postgres=X/postgres,service_role=X/postgres}'],
  ['public.service_begin_emergency_access_revoke(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
  ['public.service_begin_emergency_access_restore(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
  ['public.service_record_emergency_access_provider_progress(uuid,uuid,text,jsonb)', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
  ['public.service_complete_emergency_access_operation(uuid,uuid,text,boolean,jsonb)', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
  ['public.admin_set_employee_account_state(uuid,boolean)', true, 'v', '{postgres=X/postgres}'],
  ['public.service_link_employee_auth_account(uuid,uuid,boolean)', true, 'v', '{postgres=X/postgres,service_role=X/postgres}'],
])

const serviceRpcIdentities = Object.freeze([
  'public.service_get_employee_emergency_access_state(uuid,uuid)',
  'public.service_begin_emergency_access_revoke(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
  'public.service_begin_emergency_access_restore(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
  'public.service_record_emergency_access_provider_progress(uuid,uuid,text,jsonb)',
  'public.service_complete_emergency_access_operation(uuid,uuid,text,boolean,jsonb)',
  'public.service_link_employee_auth_account(uuid,uuid,boolean)',
])

function sourceFor(root, directory, fileName) {
  return readFileSync(resolve(root, 'supabase', directory, fileName), 'utf8')
    .replace(/^\uFEFF/u, '')
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function requireReviewedMigrationSource(migrationSource) {
  if (migrationSource.includes(migrationLedgerTag)) {
    throw new Error(
      `${migrationFile}: source collides with migration-history dollar tag ${migrationLedgerTag}`,
    )
  }
  const sourceSha256 = createHash('sha256').update(migrationSource).digest('hex')
  if (sourceSha256 !== expectedMigrationSha256) {
    throw new Error(
      `${migrationFile}: source SHA-256 drifted from the reviewed release candidate`,
    )
  }

  const migrationBody = unwrapTransaction(migrationSource, 'commit', migrationFile)
  const requiredFragments = [
    'alter table private.employee_accounts',
    'create table if not exists private.emergency_access_operations',
    'create table if not exists private.emergency_access_operation_events',
    'create table if not exists private.emergency_revoked_auth_sessions',
    'create or replace function private.current_employee_id()',
    'from auth.sessions auth_session',
    'from auth.refresh_tokens refresh_token',
    'create or replace function public.service_begin_emergency_access_revoke',
    'create or replace function public.service_begin_emergency_access_restore',
    'create or replace function public.service_record_emergency_access_provider_progress',
    'create or replace function public.service_complete_emergency_access_operation',
    'create or replace function public.admin_set_employee_account_state',
    'raise feature_not_supported',
    'create or replace function public.service_link_employee_auth_account',
    'grant execute on function public.service_complete_emergency_access_operation',
    "notify pgrst, 'reload schema'",
  ]

  for (const fragment of requiredFragments) {
    if (!migrationBody.toLowerCase().includes(fragment.toLowerCase())) {
      throw new Error(`${migrationFile}: reviewed contract fragment is missing: ${fragment}`)
    }
  }

  return migrationBody
}

function regressionBody(root, fileName) {
  return unwrapTransaction(sourceFor(root, 'tests', fileName), 'rollback', fileName)
}

function candidateAbsentSql() {
  const candidateTables = [
    'private.emergency_access_operations',
    'private.emergency_access_operation_events',
    'private.emergency_revoked_auth_sessions',
  ]
  const candidateFunctions = [
    'private.require_emergency_access_viewer(uuid)',
    'private.require_emergency_access_actor(uuid,uuid,text,timestamp with time zone)',
    'private.emergency_access_state_json(uuid)',
    'private.emergency_access_operation_payload(uuid)',
    'private.emergency_access_cleanup(uuid,uuid,uuid,uuid)',
    'private.begin_emergency_access_operation(text,uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
    'public.service_get_employee_emergency_access_state(uuid,uuid)',
    'public.service_begin_emergency_access_revoke(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
    'public.service_begin_emergency_access_restore(uuid,uuid,uuid,text,text,boolean,uuid,text,timestamp with time zone)',
    'public.service_record_emergency_access_provider_progress(uuid,uuid,text,jsonb)',
    'public.service_complete_emergency_access_operation(uuid,uuid,text,boolean,jsonb)',
  ]
  const tableValues = candidateTables.map(sqlLiteral).join(', ')
  const functionValues = candidateFunctions.map(sqlLiteral).join(', ')
  return `do $emergency_access_candidate_absent$
declare
  existing_versions text[];
  unexpected_objects text[];
begin
  select array_agg(applied.version order by applied.version)
    into existing_versions
    from supabase_migrations.schema_migrations applied
   where applied.version = '${migrationVersion}'
      or applied.name = '${migrationName}';

  if existing_versions is not null then
    raise exception 'Emergency access candidate version or name is already registered: %', existing_versions;
  end if;

  select array_agg(candidate.object_name order by candidate.object_name)
    into unexpected_objects
    from (
      select table_name as object_name
        from unnest(array[${tableValues}]::text[]) candidate_table(table_name)
       where to_regclass(candidate_table.table_name) is not null
      union all
      select function_name
        from unnest(array[${functionValues}]::text[]) candidate_function(function_name)
       where to_regprocedure(candidate_function.function_name) is not null
      union all
      select 'private.employee_accounts.' || column_name
        from unnest(array[
          'auth_tokens_invalid_before_epoch',
          'current_emergency_revocation_id'
        ]::text[]) candidate_column(column_name)
       where exists (
         select 1
           from pg_catalog.pg_attribute attribute_record
          where attribute_record.attrelid = 'private.employee_accounts'::regclass
            and attribute_record.attname = candidate_column.column_name
            and attribute_record.attnum > 0
            and not attribute_record.attisdropped
       )
    ) candidate;

  if unexpected_objects is not null then
    raise exception 'Emergency access candidate objects already exist without the reviewed ledger entry: %', unexpected_objects;
  end if;
end
$emergency_access_candidate_absent$;`
}

function preflightFunctionsSql() {
  const rows = expectedPreFunctionContracts.map(
    ([identity, md5, securityDefiner, volatility, acl]) =>
      `(${sqlLiteral(identity)}, ${sqlLiteral(md5)}, 'postgres', ${securityDefiner}, ${sqlLiteral(volatility)}, array['search_path=""']::text[], ${sqlLiteral(acl)})`,
  ).join(',\n      ')

  return `do $emergency_access_preflight_functions$
declare
  contract record;
  function_oid oid;
  definition_md5 text;
  owner_name text;
  security_definer boolean;
  volatility "char";
  configuration text[];
  access_control text;
begin
  for contract in
    select *
      from (values
      ${rows}
      ) expected(identity, definition_md5, owner_name, security_definer, volatility, configuration, access_control)
  loop
    function_oid := to_regprocedure(contract.identity);
    if function_oid is null then
      raise exception 'Required pre-release function is missing: %', contract.identity;
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

    if definition_md5 is distinct from contract.definition_md5
      or owner_name is distinct from contract.owner_name
      or security_definer is distinct from contract.security_definer
      or volatility is distinct from contract.volatility
      or configuration is distinct from contract.configuration
      or access_control is distinct from contract.access_control
    then
      raise exception 'Pre-release function fingerprint or security metadata drifted: %', contract.identity;
    end if;
  end loop;
end
$emergency_access_preflight_functions$;`
}

function preflightColumnsSql() {
  const rows = requiredColumnContracts.map(([relation, column, type]) =>
    `(${sqlLiteral(relation)}, ${sqlLiteral(column)}, ${sqlLiteral(type)})`,
  ).join(',\n      ')
  return `do $emergency_access_preflight_columns$
declare
  contract record;
  relation_oid oid;
  actual_type oid;
begin
  for contract in
    select *
      from (values
      ${rows}
      ) expected(relation_name, column_name, type_name)
  loop
    relation_oid := to_regclass(contract.relation_name);
    if relation_oid is null then
      raise exception 'Required pre-release relation is missing: %', contract.relation_name;
    end if;

    select attribute_record.atttypid
      into actual_type
      from pg_catalog.pg_attribute attribute_record
     where attribute_record.attrelid = relation_oid
       and attribute_record.attname = contract.column_name
       and attribute_record.attnum > 0
       and not attribute_record.attisdropped;

    if actual_type is null or actual_type is distinct from to_regtype(contract.type_name) then
      raise exception 'Required pre-release column drifted: %.% expected %',
        contract.relation_name, contract.column_name, contract.type_name;
    end if;
  end loop;

  if private.preferred_delivery_email(
       'personal@example.com',
       'employee@guardianshipsecurity.net'
     ) is distinct from 'personal@example.com'
    or private.preferred_delivery_email(
         null,
         'employee@guardianshipsecurity.net'
       ) is not null
    or private.preferred_delivery_email(
         null,
         'employee@example.net'
       ) is distinct from 'employee@example.net'
  then
    raise exception 'The reviewed personal-first external recovery delivery contract drifted.';
  end if;
end
$emergency_access_preflight_columns$;`
}

function postflightFunctionsSql() {
  const rows = postFunctionContracts.map(
    ([identity, securityDefiner, volatility, acl]) =>
      `(${sqlLiteral(identity)}, 'postgres', ${securityDefiner}, ${sqlLiteral(volatility)}, array['search_path=""']::text[], ${sqlLiteral(acl)})`,
  ).join(',\n      ')
  const serviceValues = serviceRpcIdentities.map(sqlLiteral).join(', ')
  return `do $emergency_access_postflight_functions$
declare
  contract record;
  function_oid oid;
  owner_name text;
  security_definer boolean;
  volatility "char";
  configuration text[];
  access_control text;
  function_definition text;
begin
  for contract in
    select *
      from (values
      ${rows}
      ) expected(identity, owner_name, security_definer, volatility, configuration, access_control)
  loop
    function_oid := to_regprocedure(contract.identity);
    if function_oid is null then
      raise exception 'Required post-release function is missing: %', contract.identity;
    end if;

    select
      pg_get_userbyid(procedure.proowner),
      procedure.prosecdef,
      procedure.provolatile,
      procedure.proconfig,
      procedure.proacl::text
    into
      owner_name,
      security_definer,
      volatility,
      configuration,
      access_control
    from pg_catalog.pg_proc procedure
    where procedure.oid = function_oid;

    if owner_name is distinct from contract.owner_name
      or security_definer is distinct from contract.security_definer
      or volatility is distinct from contract.volatility
      or configuration is distinct from contract.configuration
      or access_control is distinct from contract.access_control
    then
      raise exception 'Post-release function security metadata drifted: %', contract.identity;
    end if;
  end loop;

  for contract in
    select function_name
      from unnest(array[${serviceValues}]::text[]) service_function(function_name)
  loop
    if not has_function_privilege('service_role', contract.function_name, 'EXECUTE')
      or has_function_privilege('authenticated', contract.function_name, 'EXECUTE')
      or has_function_privilege('anon', contract.function_name, 'EXECUTE')
    then
      raise exception 'Service-only RPC execution boundary drifted: %', contract.function_name;
    end if;
  end loop;

  if has_function_privilege(
       'service_role',
       'public.admin_set_employee_account_state(uuid,boolean)',
       'EXECUTE'
     )
    or has_function_privilege(
         'authenticated',
         'public.admin_set_employee_account_state(uuid,boolean)',
         'EXECUTE'
       )
    or has_function_privilege(
         'anon',
         'public.admin_set_employee_account_state(uuid,boolean)',
         'EXECUTE'
       )
  then
    raise exception 'The retired timestamp-only browser account RPC remains executable.';
  end if;

  select pg_get_functiondef('private.current_employee_id()'::regprocedure)
    into function_definition;
  if position('auth.sessions' in function_definition) = 0
    or position('auth_tokens_invalid_before_epoch' in function_definition) = 0
    or position('emergency_revoked_auth_sessions' in function_definition) = 0
  then
    raise exception 'The installed employee identity boundary is missing session, epoch, or tombstone enforcement.';
  end if;

  select pg_get_functiondef(
    'public.service_complete_emergency_access_operation(uuid,uuid,text,boolean,jsonb)'::regprocedure
  ) into function_definition;
  if position('auth.sessions' in function_definition) = 0
    or position('auth.refresh_tokens' in function_definition) = 0
    or position('passwordRotated' in function_definition) = 0
    or position('recoveryUsableUntil' in function_definition) = 0
  then
    raise exception 'The installed provider finalizer is missing reviewed provider postconditions.';
  end if;

  select pg_get_functiondef(
    'public.service_link_employee_auth_account(uuid,uuid,boolean)'::regprocedure
  ) into function_definition;
  if position('current_emergency_revocation_id' in function_definition) = 0
    or position('disabled_at is not null' in function_definition) = 0
  then
    raise exception 'Account provisioning can bypass the installed emergency or ordinary disable boundary.';
  end if;

  select pg_get_functiondef(
    'public.admin_set_employee_account_state(uuid,boolean)'::regprocedure
  ) into function_definition;
  if position('feature_not_supported' in function_definition) = 0
    or position('protected emergency access revocation' in function_definition) = 0
  then
    raise exception 'The legacy browser account-state RPC is not the reviewed deliberate hard failure.';
  end if;
end
$emergency_access_postflight_functions$;`
}

function postflightTablesSql() {
  return `do $emergency_access_postflight_tables$
declare
  relation_name text;
  relation_oid oid;
  owner_name text;
  rls_enabled boolean;
  rls_forced boolean;
begin
  foreach relation_name in array array[
    'private.emergency_access_operations',
    'private.emergency_access_operation_events',
    'private.emergency_revoked_auth_sessions'
  ]::text[]
  loop
    relation_oid := to_regclass(relation_name);
    if relation_oid is null then
      raise exception 'Required emergency access table is missing: %', relation_name;
    end if;

    select
      pg_get_userbyid(relation_record.relowner),
      relation_record.relrowsecurity,
      relation_record.relforcerowsecurity
    into owner_name, rls_enabled, rls_forced
    from pg_catalog.pg_class relation_record
    where relation_record.oid = relation_oid;

    if owner_name is distinct from 'postgres'
      or rls_enabled is distinct from true
      or rls_forced is distinct from true
      or has_table_privilege('authenticated', relation_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('anon', relation_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('service_role', relation_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or exists (
        select 1
          from pg_catalog.pg_policy policy_record
         where policy_record.polrelid = relation_oid
      )
    then
      raise exception 'Emergency access table security or RLS contract drifted: %', relation_name;
    end if;
  end loop;

  if not exists (
       select 1
         from pg_catalog.pg_attribute attribute_record
        where attribute_record.attrelid = 'private.employee_accounts'::regclass
          and attribute_record.attname = 'auth_tokens_invalid_before_epoch'
          and attribute_record.atttypid = 'bigint'::regtype
          and attribute_record.attnotnull
          and not attribute_record.attisdropped
     )
    or not exists (
       select 1
         from pg_catalog.pg_attrdef default_record
         join pg_catalog.pg_attribute attribute_record
           on attribute_record.attrelid = default_record.adrelid
          and attribute_record.attnum = default_record.adnum
        where default_record.adrelid = 'private.employee_accounts'::regclass
          and attribute_record.attname = 'auth_tokens_invalid_before_epoch'
          and pg_get_expr(default_record.adbin, default_record.adrelid) = '0'
     )
    or not exists (
       select 1
         from pg_catalog.pg_attribute attribute_record
        where attribute_record.attrelid = 'private.employee_accounts'::regclass
          and attribute_record.attname = 'current_emergency_revocation_id'
          and attribute_record.atttypid = 'uuid'::regtype
          and not attribute_record.attnotnull
          and not attribute_record.attisdropped
     )
  then
    raise exception 'Employee account emergency marker columns do not match the reviewed contract.';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_constraint constraint_record
     where constraint_record.conname = any(array[
       'emergency_access_operation_restore_parent',
       'emergency_access_operation_completion',
       'emergency_access_provider_error_length',
       'employee_accounts_emergency_revocation_fkey'
     ]::text[])
       and constraint_record.convalidated
  ) is distinct from 4::bigint
  then
    raise exception 'One or more reviewed emergency access constraints are missing or unvalidated.';
  end if;

  if (
    select count(*)
      from pg_catalog.pg_index index_record
     where index_record.indexrelid = any(array[
       'private.emergency_access_operations_target_created_idx'::regclass,
       'private.emergency_access_operations_open_idx'::regclass,
       'private.emergency_access_operation_events_operation_idx'::regclass,
       'private.emergency_revoked_auth_sessions_employee_idx'::regclass
     ]::oid[])
       and index_record.indisvalid
       and index_record.indisready
  ) is distinct from 4::bigint
  then
    raise exception 'One or more reviewed emergency access indexes are not valid and ready.';
  end if;

  if not exists (
       select 1
         from pg_catalog.pg_trigger trigger_record
        where trigger_record.tgrelid = 'private.emergency_access_operation_events'::regclass
          and trigger_record.tgname = 'emergency_access_operation_events_append_only'
          and trigger_record.tgfoid = 'private.prevent_append_only_change()'::regprocedure
          and trigger_record.tgenabled = 'O'
          and not trigger_record.tgisinternal
     )
    or not exists (
       select 1
         from pg_catalog.pg_trigger trigger_record
        where trigger_record.tgrelid = 'private.emergency_revoked_auth_sessions'::regclass
          and trigger_record.tgname = 'emergency_revoked_auth_sessions_append_only'
          and trigger_record.tgfoid = 'private.prevent_append_only_change()'::regprocedure
          and trigger_record.tgenabled = 'O'
          and not trigger_record.tgisinternal
     )
  then
    raise exception 'One or more append-only emergency evidence triggers are missing or disabled.';
  end if;
end
$emergency_access_postflight_tables$;`
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
  return `do $emergency_access_history_postflight$
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
    raise exception 'Emergency access migration ledger does not contain one exact full source statement.';
  end if;
end
$emergency_access_history_postflight$;`
}

function releasePreamble() {
  return `begin;
set local lock_timeout = '5s';
set local statement_timeout = '3min';
select pg_advisory_xact_lock(
  hashtextextended('sygshift:emergency-access-revocation:2026-10-29', 0)
);
${candidateAbsentSql()}
${preflightFunctionsSql()}
${preflightColumnsSql()}`
}

export function buildEmergencyAccessRevocationArtifact({ root, mode }) {
  if (!['rehearsal', 'release'].includes(mode)) {
    throw new Error('Choose exactly one mode: rehearsal or release')
  }

  const migrationSource = sourceFor(root, 'migrations', migrationFile)
  const migrationBody = requireReviewedMigrationSource(migrationSource)
  const commonBody = `${releasePreamble()}

-- Migration: ${migrationFile}
${migrationBody}

${postflightFunctionsSql()}

${postflightTablesSql()}

${historyStatement(migrationSource)}

${historyPostflightSql(migrationSource)}`

  if (mode === 'rehearsal') {
    const regressions = regressionFiles.map((fileName) =>
      `-- Regression: ${fileName}\n${regressionBody(root, fileName)}`,
    ).join('\n\n')
    const sql = `${commonBody}

${regressions}
rollback;
`
    validateGeneratedTransaction(
      sql,
      'rollback',
      'emergency access revocation rollback-only rehearsal',
    )
    return sql
  }

  const sql = `${commonBody}
commit;
`
  validateGeneratedTransaction(
    sql,
    'commit',
    'emergency access revocation atomic release',
  )
  return sql
}

function main() {
  const arguments_ = process.argv.slice(2)
  if (
    arguments_.length !== 1
    || !['--rehearsal', '--release'].includes(arguments_[0])
  ) {
    throw new Error('Choose exactly one mode: --rehearsal or --release')
  }

  const root = resolve(import.meta.dirname, '..')
  const mode = arguments_[0] === '--rehearsal' ? 'rehearsal' : 'release'
  const outputDirectory = resolve(root, 'tmp', 'emergency-access-revocation-release')
  mkdirSync(outputDirectory, { recursive: true })
  const outputPath = resolve(
    outputDirectory,
    mode === 'rehearsal' ? 'rollback-only-rehearsal.sql' : 'atomic-release.sql',
  )
  writeFileSync(
    outputPath,
    buildEmergencyAccessRevocationArtifact({ root, mode }),
  )
  console.log(
    `Prepared emergency access revocation ${mode === 'rehearsal' ? 'rollback-only rehearsal' : 'atomic release'} at ${outputPath}.`,
  )
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main()
}

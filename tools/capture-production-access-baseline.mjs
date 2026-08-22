import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const date = process.argv.find((argument) => /^\d{2}-\d{2}-\d{4}$/.test(argument))
  ?? new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/Denver',
    year: 'numeric',
  }).format(new Date()).replaceAll('/', '-')
const outputPath = join(root, 'outputs', 'access-control', `production-access-baseline-${date}.json`)
const sqlPath = join(root, 'outputs', 'access-control', 'production-access-baseline.sql')
const matrixPath = join(root, 'docs', 'security', `ACCESS_CONTROL_CURRENT_ROLE_MATRIX_${date}.csv`)

const pnpmEntrypoint = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : process.env.SYGSHIFT_PNPM_ENTRYPOINT && existsSync(process.env.SYGSHIFT_PNPM_ENTRYPOINT)
    ? process.env.SYGSHIFT_PNPM_ENTRYPOINT
    : null
if (!pnpmEntrypoint || !existsSync(pnpmEntrypoint)) {
  throw new Error('pnpm was not found. Run this tool through pnpm or set SYGSHIFT_PNPM_ENTRYPOINT to pnpm\'s JavaScript entrypoint.')
}

const sql = `
with role_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'code', role.code,
      'name', role.name,
      'baseAppRole', role.base_app_role,
      'systemRole', role.system_role,
      'protected', role.protected,
      'mfaRequired', role.mfa_required,
      'active', role.active,
      'permissionCodes', coalesce((
        select jsonb_agg(permission.permission_code order by permission.permission_code)
        from public.access_role_permissions permission
        where permission.role_id = role.id and permission.enabled
      ), '[]'::jsonb)
    ) order by role.name
  ) as payload
  from public.access_roles role
), employee_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'id', employee.id,
      'employeeNumber', employee.employee_number,
      'username', employee.username,
      'primaryRole', employee.role,
      'effectivePermissionCodes', private.employee_effective_permissions(employee.id),
      'assignedRoleCodes', coalesce((
        select jsonb_agg(role.code order by role.code)
        from public.employee_access_roles assignment
        join public.access_roles role on role.id = assignment.role_id
        where assignment.employee_id = employee.id
      ), '[]'::jsonb),
      'overrides', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'permissionCode', override.permission_code,
            'effect', override.effect,
            'reason', override.reason
          ) order by override.permission_code
        )
        from public.employee_permission_overrides override
        where override.employee_id = employee.id and override.active
      ), '[]'::jsonb)
    ) order by employee.employee_number nulls last, employee.username
  ) as payload
  from public.employees employee
  where employee.status = 'active'
), permission_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'code', permission.code,
      'category', permission.category,
      'name', permission.name,
      'riskLevel', permission.risk_level,
      'requiresMfa', permission.requires_mfa,
      'locked', permission.locked,
      'active', permission.active
    ) order by permission.category, permission.code
  ) as payload
  from public.permission_catalog permission
), function_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'schema', namespace.nspname,
      'name', procedure.proname,
      'identityArguments', pg_get_function_identity_arguments(procedure.oid),
      'securityDefiner', procedure.prosecdef,
      'definitionHash', md5(pg_get_functiondef(procedure.oid)),
      'usesEffectivePermission', pg_get_functiondef(procedure.oid) ~* 'has_effective_permission|require_effective_permission|require_any_effective_permission|timekeeping_require_permission',
      'usesRoleReference', pg_get_functiondef(procedure.oid) ~* 'current_app_role|is_admin\\s*\\(|is_supervisor_or_admin\\s*\\(|require_admin_mfa|require_supervisor_mfa|role\\s+in\\s*\\(',
      'usesMfaReference', pg_get_functiondef(procedure.oid) ~* 'aal2|has_mfa|required_mfa|require_admin_mfa|require_supervisor_mfa|require_effective_permission|timekeeping_require_permission'
    ) order by namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid)
  ) as payload
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname in ('private', 'public')
), policy_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'schema', policy.schemaname,
      'table', policy.tablename,
      'name', policy.policyname,
      'command', policy.cmd,
      'roles', policy.roles,
      'usingExpression', policy.qual,
      'checkExpression', policy.with_check,
      'usesEffectivePermission', coalesce(policy.qual, '') ~* 'has_effective_permission' or coalesce(policy.with_check, '') ~* 'has_effective_permission',
      'usesRoleReference', coalesce(policy.qual, '') ~* 'current_app_role|is_admin\\s*\\(|is_supervisor_or_admin\\s*\\(|role\\s+in\\s*\\(' or coalesce(policy.with_check, '') ~* 'current_app_role|is_admin\\s*\\(|is_supervisor_or_admin\\s*\\(|role\\s+in\\s*\\('
    ) order by policy.schemaname, policy.tablename, policy.policyname
  ) as payload
  from pg_policies policy
  where policy.schemaname in ('public', 'storage')
), function_grant_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'schema', routine_grant.routine_schema,
      'name', routine_grant.routine_name,
      'grantee', routine_grant.grantee,
      'privilege', routine_grant.privilege_type
    ) order by routine_grant.routine_schema, routine_grant.routine_name, routine_grant.grantee
  ) as payload
  from information_schema.routine_privileges routine_grant
  where routine_grant.routine_schema in ('private', 'public')
    and routine_grant.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
), table_grant_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'schema', table_grant.table_schema,
      'table', table_grant.table_name,
      'grantee', table_grant.grantee,
      'privilege', table_grant.privilege_type
    ) order by table_grant.table_schema, table_grant.table_name, table_grant.grantee, table_grant.privilege_type
  ) as payload
  from information_schema.table_privileges table_grant
  where table_grant.table_schema in ('public', 'storage')
    and table_grant.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
), table_security_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'schema', namespace.nspname,
      'table', relation.relname,
      'rowLevelSecurity', relation.relrowsecurity,
      'forceRowLevelSecurity', relation.relforcerowsecurity,
      'policyCount', (
        select count(*)
        from pg_policies policy
        where policy.schemaname = namespace.nspname
          and policy.tablename = relation.relname
      )
    ) order by namespace.nspname, relation.relname
  ) as payload
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'storage')
    and relation.relkind in ('r', 'p')
), schema_access_payload as (
  select jsonb_agg(
    jsonb_build_object(
      'role', candidate.role_name,
      'publicUsage', has_schema_privilege(candidate.role_name, 'public', 'USAGE'),
      'publicCreate', has_schema_privilege(candidate.role_name, 'public', 'CREATE'),
      'privateUsage', has_schema_privilege(candidate.role_name, 'private', 'USAGE'),
      'privateCreate', has_schema_privilege(candidate.role_name, 'private', 'CREATE'),
      'storageUsage', has_schema_privilege(candidate.role_name, 'storage', 'USAGE'),
      'storageCreate', has_schema_privilege(candidate.role_name, 'storage', 'CREATE')
    ) order by candidate.role_name
  ) as payload
  from (values ('anon'), ('authenticated'), ('service_role')) candidate(role_name)
), migration_payload as (
  select jsonb_build_object(
    'count', count(*),
    'latestVersion', max(version)
  ) as payload
  from supabase_migrations.schema_migrations
)
select jsonb_build_object(
  'capturedAt', now(),
  'projectRef', 'eqkdfrbwtioiqtjsyglg',
  'permissions', permission_payload.payload,
  'roles', role_payload.payload,
  'activeEmployees', employee_payload.payload,
  'databaseFunctions', function_payload.payload,
  'databasePolicies', policy_payload.payload,
  'databaseFunctionGrants', function_grant_payload.payload,
  'databaseTableGrants', table_grant_payload.payload,
  'databaseTableSecurity', table_security_payload.payload,
  'databaseSchemaAccess', schema_access_payload.payload,
  'migrations', migration_payload.payload
) as access_baseline
from permission_payload, role_payload, employee_payload, function_payload, policy_payload, function_grant_payload, table_grant_payload, table_security_payload, schema_access_payload, migration_payload;
`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(sqlPath, sql.trimStart())
const result = spawnSync(
  process.execPath,
  [pnpmEntrypoint, 'dlx', 'supabase@latest', 'db', 'query', '--linked', '--output', 'json', '--file', sqlPath],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)};${process.env.PATH ?? ''}`,
    },
  },
)
if (result.status !== 0) {
  throw new Error(`Production access baseline query failed.\n${result.stderr || result.stdout}`)
}

const raw = result.stdout.slice(result.stdout.indexOf('{'))
const response = JSON.parse(raw)
const baseline = response.rows?.[0]?.access_baseline
if (!baseline || !Array.isArray(baseline.activeEmployees) || !Array.isArray(baseline.roles)) {
  throw new Error('Production access baseline query returned an unexpected payload.')
}

writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`)
const csvCell = (value) => {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const roleColumns = [...baseline.roles].sort((left, right) => left.name.localeCompare(right.name))
const matrixRows = [
  ['Permission code', 'Category', 'Permission name', 'Risk level', 'MFA required', ...roleColumns.map((role) => role.name)],
  ...baseline.permissions.map((permission) => [
    permission.code,
    permission.category,
    permission.name,
    permission.riskLevel,
    permission.requiresMfa ? 'Yes' : 'No',
    ...roleColumns.map((role) => role.permissionCodes.includes(permission.code) ? 'Granted' : ''),
  ]),
]
mkdirSync(dirname(matrixPath), { recursive: true })
writeFileSync(matrixPath, `${matrixRows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`)
const { capturedAt: _capturedAt, ...stableBaseline } = baseline
const fingerprint = createHash('sha256').update(JSON.stringify(stableBaseline)).digest('hex')
console.log(JSON.stringify({
  activeEmployees: baseline.activeEmployees.length,
  assignedRoles: baseline.activeEmployees.reduce((total, employee) => total + employee.assignedRoleCodes.length, 0),
  fingerprint,
  functions: baseline.databaseFunctions.length,
  functionGrants: baseline.databaseFunctionGrants.length,
  latestMigration: baseline.migrations.latestVersion,
  matrix: matrixPath,
  output: outputPath,
  policies: baseline.databasePolicies.length,
  permissionOverrides: baseline.activeEmployees.reduce((total, employee) => total + employee.overrides.length, 0),
  permissions: baseline.permissions.length,
  roles: baseline.roles.length,
  schemaAccess: baseline.databaseSchemaAccess.length,
  tableGrants: baseline.databaseTableGrants.length,
  tables: baseline.databaseTableSecurity.length,
}, null, 2))

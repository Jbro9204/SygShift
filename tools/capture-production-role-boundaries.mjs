import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const outputPath = join(root, 'outputs', 'access-control', 'production-role-boundaries.json')
const sqlPath = join(root, 'outputs', 'access-control', 'production-role-boundaries.sql')
const pnpmEntrypoint = process.env.npm_execpath && existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : process.env.SYGSHIFT_PNPM_ENTRYPOINT && existsSync(process.env.SYGSHIFT_PNPM_ENTRYPOINT)
    ? process.env.SYGSHIFT_PNPM_ENTRYPOINT
    : null

if (!pnpmEntrypoint) {
  throw new Error('pnpm was not found. Run this tool through pnpm or set SYGSHIFT_PNPM_ENTRYPOINT.')
}

const sql = `
select jsonb_build_object(
  'functions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', namespace.nspname,
      'name', procedure.proname,
      'identityArguments', pg_get_function_identity_arguments(procedure.oid),
      'definition', pg_get_functiondef(procedure.oid)
    ) order by namespace.nspname, procedure.proname, pg_get_function_identity_arguments(procedure.oid))
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname in ('public', 'private')
      and procedure.prokind = 'f'
      and pg_get_functiondef(procedure.oid) ~* 'current_app_role|is_admin\\s*\\(|is_supervisor_or_admin\\s*\\(|require_admin_mfa|require_supervisor_mfa|role\\s+in\\s*\\('
  ), '[]'::jsonb),
  'policies', coalesce((
    select jsonb_agg(to_jsonb(policy) order by policy.schemaname, policy.tablename, policy.policyname)
    from pg_policies policy
    where policy.schemaname in ('public', 'storage')
      and (
        coalesce(policy.qual, '') ~* 'current_app_role|is_admin\\s*\\(|is_supervisor_or_admin\\s*\\(|role\\s+in\\s*\\('
        or coalesce(policy.with_check, '') ~* 'current_app_role|is_admin\\s*\\(|is_supervisor_or_admin\\s*\\(|role\\s+in\\s*\\('
      )
  ), '[]'::jsonb)
) as boundaries;
`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(sqlPath, sql.trimStart())
const result = spawnSync(
  process.execPath,
  [pnpmEntrypoint, 'dlx', 'supabase@latest', 'db', 'query', '--linked', '--output', 'json', '--file', sqlPath],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)};${process.env.PATH ?? ''}` },
  },
)

if (result.status !== 0) {
  throw new Error(`Production boundary query failed.\n${result.stderr || result.stdout}`)
}

const raw = result.stdout.slice(result.stdout.indexOf('{'))
const response = JSON.parse(raw)
const boundaries = response.rows?.[0]?.boundaries
if (!boundaries || !Array.isArray(boundaries.functions) || !Array.isArray(boundaries.policies)) {
  throw new Error('Production boundary query returned an unexpected payload.')
}

writeFileSync(outputPath, `${JSON.stringify(boundaries, null, 2)}\n`)
console.log(JSON.stringify({
  functions: boundaries.functions.length,
  output: outputPath,
  policies: boundaries.policies.length,
}, null, 2))

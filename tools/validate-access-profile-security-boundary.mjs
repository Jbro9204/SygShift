import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const config = readFileSync(resolve(root, 'supabase/config.toml'), 'utf8')
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260930173000_access_profile_security_invoker_boundary.sql'),
  'utf8',
)

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

const exposedSchemas = config.match(/^schemas\s*=\s*\[([^\]]*)\]/m)?.[1] ?? ''
const implementationSchema = 'sygshift_access_internal'
requireValue(
  !new RegExp(`(?:^|[,'"\\s])${implementationSchema}(?:$|[,'"\\s])`).test(exposedSchemas),
  'The dedicated implementation schema must not be exposed by the Supabase Data API.',
)

for (const functionName of [
  'set_employee_access_profile_with_primary_role',
  'set_employee_workforce_roles',
]) {
  const publicStart = migration.indexOf(`create function public.${functionName}(`)
  requireValue(publicStart >= 0, `Missing public ${functionName} wrapper.`)
  const publicEnd = migration.indexOf('$$;', publicStart)
  const publicDefinition = migration.slice(publicStart, publicEnd)
  requireValue(
    /security invoker/i.test(publicDefinition) && !/security definer/i.test(publicDefinition),
    `Public ${functionName} must be SECURITY INVOKER.`,
  )
  requireValue(
    publicDefinition.includes(`${implementationSchema}.${functionName}(`),
    `Public ${functionName} does not delegate to its internal helper.`,
  )

  const internalMarker = functionName === 'set_employee_workforce_roles'
    ? `create or replace function ${implementationSchema}.${functionName}(`
    : `alter function ${implementationSchema}.${functionName}(`
  const internalStart = migration.indexOf(internalMarker)
  requireValue(internalStart >= 0, `Missing internal ${functionName} helper boundary.`)
  requireValue(
    migration.includes(`grant execute on function ${implementationSchema}.${functionName}(`),
    `Missing authenticated helper execution grant for ${functionName}.`,
  )
}

requireValue(
  /create or replace function sygshift_access_internal\.set_employee_workforce_roles\([\s\S]*?security definer[\s\S]*?set search_path = ''/i.test(migration),
  'The internal role-only helper must be a search-path-hardened SECURITY DEFINER function.',
)
requireValue(
  /alter function sygshift_access_internal\.set_employee_access_profile_with_primary_role\([\s\S]*?\) security definer;/i.test(migration)
    && /alter function sygshift_access_internal\.set_employee_access_profile_with_primary_role\([\s\S]*?\) set search_path = '';/i.test(migration),
  'The internal full-profile helper must remain search-path-hardened SECURITY DEFINER.',
)
requireValue(
  /create schema sygshift_access_internal authorization postgres;/i.test(migration)
    && /revoke all on schema sygshift_access_internal from public, anon, authenticated, service_role;/i.test(migration)
    && /grant usage on schema sygshift_access_internal to authenticated;/i.test(migration),
  'The internal schema grants do not match the authenticated invoker bridge.',
)
requireValue(
  /pg_catalog\.pg_depend[\s\S]*?refclassid\s*=\s*'pg_catalog\.pg_proc'::regclass[\s\S]*?raise dependent_objects_still_exist/i.test(migration),
  'The OID-preserving SET SCHEMA operation must fail closed on bound database consumers.',
)

console.log('Access-profile SECURITY INVOKER boundary validation passed.')

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const migration = readFileSync(resolve(root, 'supabase/migrations/20260919170000_sygsphere_communications_tenant_authorization_foundation.sql'), 'utf8')
const contract = readFileSync(resolve(root, 'shared/sygsphere-communications/v1/contract.ts'), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(root, 'shared/sygsphere-communications/v1/contract-manifest.json'), 'utf8')) as { artifactDigestSha256: string }

describe('SygSphere Communications Stage B foundation', () => {
  it('creates only a private canonical tenant and server-only resolver', () => {
    expect(migration).toContain('create table if not exists private.sygsphere_tenants')
    expect(migration).toContain("'sygshift-primary'")
    expect(migration).toContain('create or replace function private.current_sygsphere_tenant_id()')
    expect(migration).toContain('revoke all on table private.sygsphere_tenants from public, anon, authenticated')
    expect(migration).toContain('grant execute on function private.current_sygsphere_tenant_id() to service_role')
  })

  it('keeps the shared communications permission vocabulary exact and ungranted', () => {
    const permissions = [...contract.matchAll(/'((?:sygsphere\.comms\.[a-z.]+))'/g)].map((match) => match[1])
    expect(new Set(permissions).size).toBe(14)
    for (const permission of permissions) expect(migration).toContain(`'${permission}'`)
    expect(migration).not.toContain("insert into public.access_role_permissions")
  })

  it('allows the future coordinator to derive identity only through a service-only bridge', () => {
    expect(migration).toContain('create or replace function public.service_get_sygsphere_communications_context(target_auth_user_id uuid)')
    expect(migration).toContain("if (select auth.role()) <> 'service_role'")
    expect(migration).toContain('private.sygsphere_comms_permissions(employee_record.id)')
    expect(migration).toContain('revoke all on function public.service_get_sygsphere_communications_context(uuid) from public, anon, authenticated')
    expect(migration).toContain('grant execute on function public.service_get_sygsphere_communications_context(uuid) to service_role')
    const digest = createHash('sha256')
    for (const file of ['contract.ts', 'command-envelope.schema.json', 'event-envelope.schema.json']) {
      digest.update(readFileSync(resolve(root, 'shared/sygsphere-communications/v1', file)))
    }
    expect(manifest.artifactDigestSha256).toBe(digest.digest('hex'))
  })
})

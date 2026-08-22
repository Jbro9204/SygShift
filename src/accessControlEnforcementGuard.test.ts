import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeAccessPolicies } from './app/accessPolicy'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('effective-permission enforcement guard', () => {
  it('covers every authenticated application route with a central policy', () => {
    const router = read('src/app/router.tsx')
    const childPaths = [...router.matchAll(/\bpath:\s*'([^']+)'/g)]
      .map((match) => match[1])
      .filter((path) => path !== '/login')
      .map((path) => (path.startsWith('/') ? path : `/${path}`))

    expect(Object.keys(routeAccessPolicies).sort()).toEqual([...new Set(childPaths)].sort())
  })

  it('keeps navigation and core application guards permission-only', () => {
    const navigation = read('src/app/navigation.ts')
    const timePermissions = read('src/time/timePermissions.ts')
    const shell = read('src/components/AppShell.tsx')

    expect(navigation).not.toMatch(/\broles?\s*:/)
    expect(timePermissions).not.toMatch(/session\?\.role\s*===/)
    expect(shell).not.toMatch(/item\.roles|roles\?\.includes/)
  })

  it('keeps Worker administration and notification processing permission-bound', () => {
    const worker = read('worker/index.ts')

    expect(worker).not.toContain('notificationProcessorRoles')
    expect(worker).not.toContain('hasLegacyAdminAccess')
    expect(worker).toContain("result.context.permissions?.includes(requiredPermission)")
    expect(worker).toContain("permission === 'notifications.manage' || permission === 'announcements.send'")
  })

  it('keeps the database migration fail-closed and access-preserving', () => {
    const migration = read('supabase/migrations/20260821203000_permission_enforcement_integrity.sql')

    expect(migration).toContain('Access assignment integrity check failed; the migration was rolled back.')
    expect(migration).toContain('revoke execute on all functions in schema private from public, anon, authenticated;')
    expect(migration).toContain("public.has_effective_permission('admin.roles.manage')")
    expect(migration).toContain("public.has_effective_permission('schedule.manage')")
    expect(migration).toContain("array[''time.manage'', ''time.export_payroll'']")
  })
})

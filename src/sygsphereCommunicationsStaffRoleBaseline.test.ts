import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260921152504_sygsphere_communications_staff_role_baseline.sql'),
  'utf8',
)
const accessControl = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260727203000_access_control_center.sql'),
  'utf8',
)
const effectivePermissions = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260912180000_connected_reliability_repair.sql'),
  'utf8',
)

const baselinePermissions = [
  'sygsphere.comms.use',
  'sygsphere.comms.ptt.listen',
  'sygsphere.comms.ptt.transmit',
  'sygsphere.comms.call.start',
  'sygsphere.comms.call.receive',
]

describe('SygSphere Communications staff-role baseline', () => {
  it('repairs every active employee role and applies the same baseline on role creation or reactivation', () => {
    for (const permission of baselinePermissions) {
      expect(migration).toContain(`'${permission}'`)
    }

    expect(migration).toContain('from public.access_roles access_role\nwhere access_role.active')
    expect(migration).toContain('create trigger ensure_sygsphere_communications_staff_role_baseline')
    expect(migration).toContain('after insert or update of active on public.access_roles')
    expect(migration).toContain('when (new.active)')
    expect(migration).toContain('private.ensure_sygsphere_communications_staff_role_baseline(new.id)')
  })

  it('keeps a full role-editor save from removing direct-call or PTT listener readiness', () => {
    expect(migration).toContain('case when target_role.active then baseline_permissions else array[]::text[] end')
    expect(migration).toContain("'sygsphere.comms.call.receive'")
    expect(migration).toContain("'sygsphere.comms.ptt.listen'")
    expect(migration).toContain("'access_role_permissions',\n    'UPDATE'")
  })

  it('limits the repair to employee role bundles and retains the individual-deny boundary', () => {
    expect(accessControl).toContain('employee_id uuid not null references public.employees(id)')
    expect(accessControl).toContain('role_id uuid not null references public.access_roles(id)')
    expect(migration).toContain('Client and public-portal identities do not use this table')
    expect(migration).toContain('revoke all on function private.ensure_sygsphere_communications_staff_role_baseline(uuid) from public, anon, authenticated')
    expect(migration).toContain('revoke all on function private.apply_sygsphere_communications_staff_role_baseline() from public, anon, authenticated')
    expect(migration).toContain('revoke all on function public.set_access_role_permissions(uuid, text[]) from public, anon')
    expect(migration).toContain('grant execute on function public.set_access_role_permissions(uuid, text[]) to authenticated')
    expect(effectivePermissions).toContain('direct_denies as (')
    expect(effectivePermissions).toContain('where not exists (\n    select 1 from direct_denies denied')
  })
})

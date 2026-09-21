import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260921153502_sygsphere_communications_checkpoint_inbound_access.sql'),
  'utf8',
)
const shell = readFileSync(resolve(root, 'src/components/AppShell.tsx'), 'utf8')
const runtime = readFileSync(resolve(root, 'src/components/communications/SygSphereCommunicationsRuntime.tsx'), 'utf8')

describe('required-actions communications presence', () => {
  it('keeps only inbound communications permissions during a blocking checkpoint', () => {
    for (const permission of [
      'sygsphere.comms.use',
      'sygsphere.comms.call.receive',
      'sygsphere.comms.ptt.listen',
    ]) {
      expect(migration).toContain(`('${permission}'::text)`)
    }

    expect(migration).not.toContain("('sygsphere.comms.call.start'::text)")
    expect(migration).not.toContain("('sygsphere.comms.ptt.transmit'::text)")
    expect(migration).toContain('direct_denies as (')
    expect(migration).toContain('where not exists (\n    select 1 from direct_denies denied')
    expect(migration).toContain('revoke all on function private.employee_effective_permissions(uuid) from public, anon, authenticated')
  })

  it('keeps the global runtime mounted while required-action views and redirects remain blocked', () => {
    const runtimeBoundary = shell.slice(
      shell.indexOf('const communicationsRuntimeEnabled'),
      shell.indexOf('if (authLoading)'),
    )

    expect(runtimeBoundary).toContain("sessionContext?.permissions.includes('sygsphere.comms.use')")
    expect(runtimeBoundary).toContain('&& !needsSecurityCheckpoint')
    expect(runtimeBoundary).not.toContain('requiredActionCheckpointActive')
    expect(runtimeBoundary).toContain('SygSphereCommunicationsRuntimeProvider')

    expect(shell).toContain('requiredActionCheckpointActive && !checkpointAllowsLocation(location.pathname, location.search)')
    expect(shell).toContain('return withCommunicationsRuntime(<Navigate to="/actions?checkpoint=required" replace state={{ from: location }} />)')
    expect(shell).toContain('if (isSupabaseConfigured && lacksRouteAccess)')
    expect(shell).toContain('return withCommunicationsRuntime(<Navigate to={resolveAuthorizedLandingRoute(sessionContext)} replace />)')
  })

  it('retains the provider-level incoming call and remote-audio handlers', () => {
    expect(runtime).toContain('IncomingCommunicationsCallNotice')
    expect(runtime).toContain('GlobalCommunicationsAudio')
  })
})

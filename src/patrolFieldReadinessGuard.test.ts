import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260912140000_patrol_release_readiness.sql'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'PatrolPage.tsx'), 'utf8')

describe('Patrol field release readiness', () => {
  it('derives release gates from canonical operational records without changing them', () => {
    for (const table of ['public.clients', 'public.sites', 'public.patrol_routes', 'public.patrol_assignments', 'public.patrol_hits', 'public.patrol_hit_evidence']) expect(migration).toContain(table)
    expect(migration).toContain('Patrol readiness migration changed protected operational records.')
    expect(migration).not.toContain('insert into public.patrol_')
    expect(migration).not.toContain('update public.patrol_')
  })

  it('keeps broad release blocked until ownership, address, field, and media evidence all pass', () => {
    expect(migration).toContain('readyForBroadRelease')
    for (const check of ['site_ownership', 'site_addresses', 'active_route', 'field_assignment', 'media_validation', 'authorization_integrity']) expect(migration).toContain(check)
    expect(migration).toContain('longest_video_seconds, 0) >= 180')
    expect(migration).toContain('and authorization_integrity_ready')
  })

  it('shows managers a live, actionable checklist in the existing Patrol workflow', () => {
    expect(page).toContain('getPatrolReleaseReadiness')
    expect(page).toContain('Complete these checks before broad release')
    expect(page).toContain('This live checklist is derived from canonical clients, sites, routes, assignments, and stored field evidence.')
  })
})

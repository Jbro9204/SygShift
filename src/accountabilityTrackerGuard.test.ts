import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync('supabase/migrations/20260822143000_accountability_tracker_workspace.sql', 'utf8')
const page = readFileSync('src/time/AccountabilityPage.tsx', 'utf8')
const accessPolicy = readFileSync('src/app/accessPolicy.ts', 'utf8')

describe('Accountability Tracker production guardrails', () => {
  it('keeps decision history append-only and every decision attributable', () => {
    expect(migration).toContain('Accountability decision history is append-only.')
    expect(migration).toContain('actor_id uuid not null')
    expect(migration).toContain('action_at timestamptz not null')
    expect(migration).toContain('before_record jsonb')
    expect(migration).toContain('after_record jsonb not null')
  })

  it('enforces exact effective permissions and MFA at the database boundary', () => {
    expect(migration).toContain("public.has_effective_permission('accountability.create')")
    expect(migration).toContain("public.has_effective_permission('accountability.manage')")
    expect(migration).toContain("array['accountability.view', 'accountability.manage']")
    expect(migration).toContain('not public.has_mfa()')
  })

  it('does not change role assignments while adding the workspace', () => {
    expect(migration).not.toContain('insert into public.access_role_permissions')
    expect(migration).not.toContain('update public.access_role_permissions')
    expect(migration).not.toContain('delete from public.access_role_permissions')
  })

  it('keeps long-shift clock-in review aligned to twelve-hour operations', () => {
    expect(migration).toContain("'timekeeping.missing_clock_in_grace_minutes'")
    expect(migration).toContain("'840'::jsonb")
  })

  it('preserves punches and directs hard payroll controls to Time Exceptions', () => {
    expect(page).toContain('never changes punches')
    expect(page).toContain('Gaps are not counted as worked time.')
    expect(page).toContain('They cannot be overridden from Accountability Tracker.')
    expect(page).toContain('to="/time/exceptions"')
  })

  it('requires reasons, shows loading state, refreshes connected views, and closes saved dialogs', () => {
    expect(page).toContain('minLength={8}')
    expect(page).toContain('busy={mutation.isPending}')
    expect(page).toContain("invalidateQueries({ queryKey: ['accountability-workspace'] })")
    expect(page).toContain('await onSaved(); onClose()')
  })

  it('registers an effective-permission route without adding sidebar clutter', () => {
    expect(accessPolicy).toContain("'/time/accountability': { anyOf: ['accountability.view', 'accountability.manage'] }")
  })
})

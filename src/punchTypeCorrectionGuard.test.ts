/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260819170000_audited_punch_type_corrections.sql'),
  'utf8',
)
const dataSource = readFileSync(join(process.cwd(), 'src', 'data', 'timekeeping.ts'), 'utf8')
const pageSource = readFileSync(join(process.cwd(), 'src', 'pages', 'TimePage.tsx'), 'utf8')

describe('audited punch-type correction guard', () => {
  it('stores effective punch types in the append-only correction record', () => {
    expect(migration).toContain('replacement_kind public.time_event_kind')
    expect(migration).toContain('private.current_effective_time_event_kind')
    expect(migration).toContain('replacement_kind is distinct from old.replacement_kind')
    expect(migration).toContain("raise exception 'time_event_corrections is append-only.'")
    expect(migration).not.toContain('update public.time_events')
    expect(migration).not.toContain('delete from public.time_events')
  })

  it('requires authorized, reasoned corrections and keeps void separate', () => {
    expect(migration).toContain('public.supervisor_correct_time_event_details')
    expect(migration).toContain('not public.is_supervisor_or_admin() or not public.has_mfa()')
    expect(migration).toContain("raise check_violation using message = 'A maintenance reason is required.'")
    expect(migration).toContain('punch_type_update')
    expect(migration).toContain('Void the duplicate or accidental punch, or correct its details; do not do both.')
  })

  it('applies the effective type to clock state, attendance, review, and automation readers', () => {
    for (const target of [
      'public.get_time_maintenance(date,date,uuid)',
      'private.get_timekeeping_review_base(date,date)',
      'private.get_timekeeping_occurrence_context(uuid,uuid,date)',
      'public.get_team_attendance_summary(date,date)',
      'private.get_attendance_reconciliation_snapshot(uuid)',
      'public.get_overview_metrics_payload()',
      'public.get_timekeeping_dashboard(date)',
      'public.record_time_event(public.time_event_kind,uuid,timestamptz,text)',
      'public.service_run_timekeeping_automation(uuid)',
    ]) {
      expect(migration).toContain(target)
    }
  })

  it('exposes a clear maintenance workflow and submits the corrected type', () => {
    expect(dataSource).toContain("rpc('supervisor_correct_time_event_details'")
    expect(dataSource).toContain('target_replacement_kind: input.replacementKind ?? null')
    expect(pageSource).toContain('Change punch')
    expect(pageSource).toContain('Void duplicate/accidental')
    expect(pageSource).toContain('Save corrected punch')
    expect(pageSource).toContain("replacementKind: correctionMode === 'adjust' ? correctionKind : null")
    expect(pageSource).toContain('Originally:')
  })
})

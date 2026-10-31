/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('./lib/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }))

import { supervisorCorrectTimeEvent } from './data/timekeeping'

const root = process.cwd()
const repairMigration = '20261031224853_time_correction_effective_permission_repair.sql'
const migrationDirectory = join(root, 'supabase/migrations')
const migration = readFileSync(join(migrationDirectory, repairMigration), 'utf8')
const fixture = readFileSync(join(root, 'supabase/tests/time_correction_effective_permission_regression.sql'), 'utf8')
const runner = readFileSync(join(root, 'tools/run-time-correction-permission-regression.mjs'), 'utf8')
const eventId = 'e9400000-0000-4000-8000-000000000001'
const actorId = 'e9400000-0000-4000-8000-000000000002'
const correctionId = 'e9400000-0000-4000-8000-000000000003'

describe('time correction effective-permission repair', () => {
  beforeEach(() => rpc.mockReset())

  it('repairs only the reviewed function authorization and denial text', () => {
    expect(migration).toContain("'f02c97cb8c2623ccbdc31b0d29646b22'")
    expect(migration).toContain("'314077c4569f01d5fd2a76769d9c5d9d'")
    expect(migration).toContain('if public.has_mfa() is not true')
    expect(migration).toContain("public.has_any_effective_permission(array['time.manage', 'time.manual_entry.edit']) is not true")
    expect(migration).toContain("to_jsonb(procedure) - 'prosrc'")
    expect(migration).toContain('after_metadata is distinct from before_metadata')
    expect(migration).toContain('replace(replace(before_definition, old_guard, new_guard), old_message, new_message)')
    expect(migration).not.toMatch(/\b(?:insert\s+into|update\s+(?:public|private)\.|delete\s+from|grant\s+|revoke\s+)\b/iu)
  })

  it('requires renewed permission-contract review if a later migration replaces this RPC', () => {
    const laterDefinitions = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith('.sql') && name > repairMigration)
      .filter((name) => /create\s+(?:or\s+replace\s+)?function\s+public\.supervisor_correct_time_event_details\s*\(/iu.test(readFileSync(join(migrationDirectory, name), 'utf8')))
    // The original regression came from a later full-function replacement.
    // Updating this guard requires rerunning the native authenticated matrix.
    expect(laterDefinitions).toEqual([])
  })

  it('keeps the native regression isolated, proves the old failure, and rolls back fixture rows', () => {
    expect(runner).toContain("run('initdb'")
    expect(runner).toContain("const database = 'sygshift_time_correction_fixture'")
    expect(runner).toContain('oldGuardReproduced: true')
    expect(runner).toContain("assert.equal(remaining, '0|0|0|0|0'")
    expect(runner).toContain("finally {")
    expect(runner).toContain("'-m', 'fast', '-w', 'stop'")
    expect(fixture.trim()).toMatch(/rollback;$/u)
    expect(fixture).not.toMatch(/^\s*commit\s*;/imu)
    expect(fixture).toContain("current_database() <> 'sygshift_time_correction_fixture'")
    expect(fixture).toContain("inet_server_addr() is distinct from inet '127.0.0.1'")
    for (const cohort of ['assigned_admin_non_operations_primary', 'direct_time_manage', 'legacy_manual_entry_edit', 'deny_manage_retains_independent_edit', 'both_permissions_denied', 'no_permission', 'password_only_aal1', 'inactive_account', 'disabled_account']) {
      expect(fixture).toContain(`'${cohort}'`)
    }
    expect(fixture).toContain('set local role authenticated;')
    expect(fixture).toContain('public.supervisor_correct_time_event_details(')
    expect(fixture).toContain("'Original punch was modified.'")
    expect(fixture).toContain("'Existing audit history was modified.'")
    expect(fixture).toContain("'Denied action resolved pending requests.'")
  })

  it('submits one audited correction and uses the authenticated RPC result', async () => {
    rpc.mockResolvedValueOnce({ data: {
      id: correctionId, timeEventId: eventId, replacementTime: '2026-10-01T08:05:00Z', replacementKind: 'clock_out', recordedKind: 'clock_in',
      voided: false, requestedBy: actorId, approvedBy: actorId, approvedAt: '2026-10-31T23:00:00Z',
    }, error: null })
    const corrected = await supervisorCorrectTimeEvent({ timeEventId: eventId, replacementTime: '2026-10-01T08:05:00Z', replacementKind: 'clock_out', reason: 'Verified source timecard' })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('supervisor_correct_time_event_details', {
      target_time_event_id: eventId, target_replacement_time: '2026-10-01T08:05:00Z', target_replacement_kind: 'clock_out', target_voided: false, target_reason: 'Verified source timecard',
    })
    expect(corrected.approvedBy).toBe(actorId)
    expect(corrected.timeEventId).toBe(eventId)
    expect(corrected.recordedKind).toBe('clock_in')
  })

  it('keeps void separate and surfaces permission failures without retry or success', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Time correction permission with MFA is required to maintain employee time.' } })
    await expect(supervisorCorrectTimeEvent({ timeEventId: eventId, voided: true, reason: 'Verified duplicate punch' })).rejects.toThrow('Time correction permission with MFA is required to maintain employee time.')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('supervisor_correct_time_event_details', {
      target_time_event_id: eventId, target_replacement_time: null, target_replacement_kind: null, target_voided: true, target_reason: 'Verified duplicate punch',
    })
  })
})

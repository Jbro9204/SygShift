/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const actionMigration = readFileSync(join(root, 'supabase', 'migrations', '20260810180000_employee_action_center.sql'), 'utf8')
const workTypeMigration = readFileSync(join(root, 'supabase', 'migrations', '20260810181000_training_and_post_time.sql'), 'utf8')
const recoveryMigration = readFileSync(join(root, 'supabase', 'migrations', '20260810182000_mfa_recovery_codes.sql'), 'utf8')
const accountSecurityPage = readFileSync(join(root, 'src', 'pages', 'AccountSecurityPage.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('employee security and action-center guardrails', () => {
  it('provides a complete mobile authenticator and one-use recovery path', () => {
    expect(accountSecurityPage).toContain('Open authenticator app')
    expect(accountSecurityPage).toContain('copy this setup key and add it manually')
    expect(accountSecurityPage).toContain('Recovery code')
    expect(accountSecurityPage).toContain('Download')
    expect(worker).toContain("url.pathname === '/api/v1/account/mfa-recovery-codes'")
    expect(worker).toContain("url.pathname === '/api/v1/account/mfa-recovery'")
    expect(worker).toContain("accessTokenAssuranceLevel(session.token) !== 'aal2'")
    expect(worker).toContain('target_code_hash: await sha256Hex(suppliedCode)')
    expect(recoveryMigration).toContain('used_at is null')
    expect(recoveryMigration).toContain('revoked_at is null')
    expect(recoveryMigration).toContain('used_at = clock_timestamp()')
    expect(recoveryMigration).not.toMatch(/\braw_code\b/i)
  })

  it('versions required announcements and preserves prior receipt history', () => {
    expect(actionMigration).toContain('create or replace function private.apply_announcement_version_defaults()')
    expect(actionMigration).toContain('new.root_announcement_id := coalesce(new.root_announcement_id, new.id)')
    expect(actionMigration).toContain('create or replace function public.revise_templated_announcement')
    expect(actionMigration).toContain('create or replace function public.publish_templated_announcement_with_acknowledgment')
    expect(actionMigration).toContain('A newer announcement version already exists. Reload before revising it.')
    expect(actionMigration).toContain("status = 'superseded'")
    expect(actionMigration).toContain('title_snapshot')
    expect(actionMigration).toContain('body_snapshot')
    expect(actionMigration).toContain('Acknowledgment is not an electronic signature')
  })

  it('stores immutable training versions, scoped assignments, attestations, and audit history', () => {
    expect(actionMigration).toContain('create table public.training_course_versions')
    expect(actionMigration).toContain('constraint training_course_versions_unique unique (course_id, version_number)')
    expect(actionMigration).toContain("target_roles public.app_role[]")
    expect(actionMigration).toContain('target_site_ids uuid[]')
    expect(actionMigration).toContain('target_states text[]')
    expect(actionMigration).toContain('completion_attestation = clean_attestation')
    expect(actionMigration).toContain('create trigger training_assignments_audit')
    expect(actionMigration).toContain('create or replace function public.get_employee_action_compliance_report()')
  })

  it('requests schedule acknowledgment only for changed hourly or flex employee snapshots', () => {
    expect(actionMigration).toContain("employee.employment_type in ('hourly', 'flex')")
    expect(actionMigration).toContain('prior_acknowledgment.shifts_digest = fingerprint')
    expect(actionMigration).toContain('continue;')
    expect(actionMigration).toContain('shifts_snapshot jsonb not null')
    expect(actionMigration).toContain('schedule_revision integer not null')
    expect(actionMigration).toContain('never a payroll blocker')
  })

  it('tracks the California baton permit without asserting assignment eligibility', () => {
    expect(actionMigration).toContain("'ca_baton_permit'")
    expect(actionMigration).toContain("array[90, 60, 30, 14, 7]")
    expect(actionMigration).toContain('This record alone does not establish assignment eligibility.')
    expect(actionMigration).toMatch(/'California Baton Permit'[\s\S]+?true,\s+false,\s+array\[90, 60, 30, 14, 7\]/)
  })

  it('keeps Post and Training time paid, overtime-eligible, separately coded, and correction-audited', () => {
    expect(workTypeMigration).toContain("check (work_type in ('post', 'training'))")
    expect(workTypeMigration).toContain("('post', 'POST', 'Post Time', true, true")
    expect(workTypeMigration).toContain("('training', 'TRAINING', 'Training Time', true, true")
    expect(workTypeMigration).toContain('create table public.time_event_work_type_corrections')
    expect(workTypeMigration).toContain('time_event_work_type_corrections_append_only')
    expect(workTypeMigration).toContain('public.confirm_work_type_configuration')
    expect(workTypeMigration).toContain('confirmed_at')
  })
})

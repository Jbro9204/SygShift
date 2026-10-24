import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const originalMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261024160000_profile_photo_upload_idempotency.sql'),
  'utf8',
)
const recoveryMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261024163000_protected_storage_artifact_recovery.sql'),
  'utf8',
)
const migration = `${originalMigration}\n${recoveryMigration}`

describe('profile photo upload durability migration', () => {
  it('persists the predecessor and applies completion with a row-locked compare-and-set', () => {
    expect(migration).toContain('create table if not exists private.employee_photo_upload_operations')
    expect(recoveryMigration).toContain('create or replace function public.service_prepare_employee_photo_upload_v2')
    expect(recoveryMigration).toContain('create or replace function public.service_complete_employee_photo_upload_v2')
    expect(recoveryMigration).toContain('create or replace function public.service_remove_employee_photo_v2')
    expect(migration).toContain('for update;')
    expect(recoveryMigration).toContain('employee_record.photo_path is distinct from operation_record.expected_photo_path')
    expect(recoveryMigration).toContain("set status = 'cleanup_pending'")
    expect(recoveryMigration).toContain('private.protected_storage_cleanup_jobs')
    expect(recoveryMigration).toContain("candidate_path := target_employee_id::text || '/' || operation_id::text")
    expect(recoveryMigration).toContain('drop constraint if exists employee_photo_upload_operations_employee_id_photo_path_key')
  })

  it('keeps the private operation ledger unavailable to browser roles', () => {
    expect(migration).toContain('alter table private.employee_photo_upload_operations enable row level security;')
    expect(migration).toContain('revoke all on table private.employee_photo_upload_operations from public, anon, authenticated;')
    expect(recoveryMigration).toContain('revoke all on table private.protected_storage_cleanup_jobs from public, anon, authenticated;')
    expect(recoveryMigration).toContain('from public, anon, authenticated, service_role;')
    expect(recoveryMigration).toContain('to service_role;')
  })
})

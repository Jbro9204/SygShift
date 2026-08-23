import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = join(process.cwd(), 'supabase', 'migrations', '20260823190000_personal_email_delivery_routing.sql')
const migration = readFileSync(migrationPath, 'utf8')

describe('personal email delivery migration', () => {
  it('defines personal-first routing and excludes the temporarily blocked company domain', () => {
    expect(migration).toContain('unnest(array[personal_email, company_email])')
    expect(migration).toContain("<> 'guardianshipsecurity.net'")
  })

  it('routes onboarding, announcements, schedules, call-offs, and timekeeping through the shared rule', () => {
    expect(migration).toContain('service_get_employee_login_email_target')
    expect(migration).toContain('service_get_employee_login_email_targets')
    expect(migration).toContain('service_claim_notification_batch')
    expect(migration).toContain('service_claim_timekeeping_notification_batch')
    expect(migration.match(/private\.preferred_delivery_email/g)?.length).toBeGreaterThanOrEqual(10)
  })

  it('keeps employees without a deliverable address visible to bulk invite failure reporting', () => {
    const bulkTargetFunction = migration.slice(
      migration.indexOf('create or replace function public.service_get_employee_login_email_targets'),
      migration.indexOf('create or replace function public.service_claim_notification_batch'),
    )
    expect(bulkTargetFunction).not.toContain('preferred_delivery_email(contact.personal_email, contact.company_email) is not null')
  })
})

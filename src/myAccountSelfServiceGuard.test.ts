/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260827110000_my_account_self_service.sql'),
  'utf8',
)
const page = readFileSync(join(root, 'src', 'pages', 'MyAccountPage.tsx'), 'utf8')
const data = readFileSync(join(root, 'src', 'data', 'myAccount.ts'), 'utf8')
const shell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')

describe('My Account self-service guardrails', () => {
  it('keeps self-service updates employee-scoped and audited', () => {
    expect(migration).toContain('actor_id uuid := private.current_employee_id()')
    expect(migration).toContain("'self_profile_update'")
    expect(migration).toContain("'self_notification_preferences_update'")
    expect(migration).toContain("'personal_email_verified'")
    expect(migration).toContain("'self_photo_update'")
    expect(migration).toContain('enable row level security')
    expect(migration).toContain('revoke all on table private.employee_email_verifications')
  })

  it('protects photo and personal-email changes at the server boundary', () => {
    expect(worker).toContain("url.pathname === '/api/v1/account/photo'")
    expect(worker).toContain('verifiedImageType')
    expect(worker).toContain('5 * 1024 * 1024')
    expect(worker).toContain("url.pathname === '/api/v1/account/email-verification/request'")
    expect(worker).toContain("url.pathname === '/api/v1/account/email-verification/confirm'")
    expect(migration).toContain('Wait one minute and try again')
    expect(data).toContain("getTrustedDeviceToken()")
  })

  it('makes notification preferences operational without suppressing required alerts', () => {
    expect(migration).toContain('service_filter_notification_recipients')
    expect(migration).toContain("target_message_type = 'call_off_supervisor_alert'")
    expect(worker).toContain('deliverJobs(generalJobs, true)')
    expect(worker).toContain('Suppressed — Employee Preference')
    expect(page).toContain('Security and account notices')
    expect(page).toContain('cannot be disabled')
  })

  it('keeps security-sensitive actions explicit and the account workspace accessible', () => {
    expect(page).toContain('window.confirm')
    expect(page).toContain('role="tablist"')
    expect(page).toContain('role="tabpanel"')
    expect(page).toContain("event.key === 'ArrowRight'")
    expect(page).toContain('aria-controls')
    expect(page).toContain('Password setup needed')
    expect(data).toContain('record_my_account_security_action')
    expect(shell).toContain('to="/account"')
  })

  it('keeps the profile photo idle state compact and opens editing only after selection', () => {
    expect(page).toContain('className="account-photo-summary"')
    expect(page).toContain("photoUrl ? 'Change photo' : 'Add photo'")
    expect(page).toContain("sourceUrl ? (")
    expect(page).not.toContain('Choose a new photo')
    expect(page).not.toContain('account-photo-empty')
  })
})

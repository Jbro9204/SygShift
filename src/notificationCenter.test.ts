/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const accessPolicy = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const shell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const headerButton = readFileSync(join(root, 'src', 'components', 'HeaderNotificationButton.tsx'), 'utf8')
const page = readFileSync(join(root, 'src', 'pages', 'NotificationsPage.tsx'), 'utf8')
const supportPage = readFileSync(join(root, 'src', 'pages', 'SupportTicketsPage.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260906133034_employee_notification_center.sql'), 'utf8')
const composerRepair = readFileSync(join(root, 'supabase', 'migrations', '20260906140000_employee_notification_composer_title_fix.sql'), 'utf8')

describe('employee notification center', () => {
  it('gives every authenticated employee a personal inbox and visible header entry point', () => {
    expect(accessPolicy).toContain("'/notifications': { anyOf: [] }")
    expect(shell).toContain('<HeaderNotificationButton')
    expect(headerButton).toContain('to="/notifications"')
    expect(headerButton).toContain('refetchInterval: 30_000')
    expect(headerButton).toContain('header-notification--urgent')
    expect(page).toContain('My Notifications')
    expect(page).toContain('clearMyNotifications')
    expect(page).toContain('Clear all')
    expect(page).toContain('required items remain until acknowledged')
    expect(page).toContain('Mark read')
    expect(page).toContain('Acknowledge')
  })

  it('restricts sending, companywide delivery, and delivery operations at the database boundary', () => {
    expect(migration).toContain("public.has_effective_permission('notifications.manage')")
    expect(migration).toContain('not public.has_mfa()')
    expect(migration).toContain('Only an Administrator can notify every active employee.')
    expect(migration).toContain('force row level security')
    expect(migration).toContain('public.employee_notifications, public.employee_notification_email_deliveries from public, anon, authenticated')
    expect(page).toContain('Administrator-only company-wide delivery')
    expect(composerRepair).toContain("'title', employee.job_title")
    expect(composerRepair).not.toContain("'title', employee.title")
  })

  it('supports direct people and role audiences with lifecycle email and ticket updates', () => {
    expect(page).toContain('Find individual employees')
    expect(page).toContain('Role and individual selections are deduplicated')
    expect(page).toContain('Also send by email')
    expect(migration).toContain('mirror_support_ticket_notification_to_inbox')
    expect(migration).toContain('employee_notification_email_deliveries')
    expect(worker).toContain("'service_claim_employee_notification_batch'")
    expect(worker).toContain("relatedRecordType: 'employee_notification'")
  })

  it('keeps ticket filters and pagination compact instead of stretching the empty panel', () => {
    expect(supportPage).toContain('communications-pagination communications-pagination--compact')
    expect(styles).toContain('.support-board { display: grid;')
    expect(styles).toContain('align-items: start;')
    expect(styles).toContain('.support-list-panel > .data-state { min-height: 150px;')
    expect(styles).toContain('.communications-pagination--compact { min-height: 58px;')
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) 160px')
  })

  it('keeps notification form controls rounded without stretching checkbox inputs', () => {
    expect(styles).toContain('.notification-center .notification-composer { display: grid;')
    expect(styles).toContain('.notification-composer :is(input:not([type="checkbox"]), textarea, select)')
    expect(styles).toContain('.notification-composer input[type="checkbox"] { width: 18px;')
    expect(styles).toContain('.notification-composer textarea { min-height: 170px; resize: vertical; line-height: 1.65; }')
    expect(styles).not.toContain('.notification-compose-fields input,')
  })
})

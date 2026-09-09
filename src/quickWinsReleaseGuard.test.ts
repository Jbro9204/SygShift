/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const css = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const lifecyclePage = readFileSync(join(root, 'src', 'pages', 'HrisStage9Page.tsx'), 'utf8')
const reportsPage = readFileSync(join(root, 'src', 'pages', 'ReportsPage.tsx'), 'utf8')
const migration = readFileSync(join(root, 'supabase', 'migrations', '20260910070000_secure_forgot_username_and_personal_board_privacy.sql'), 'utf8')

describe('approved quick-win release boundaries', () => {
  it('keeps My Time metric labels and supporting copy at the approved readable sizes', () => {
    expect(css).toMatch(/\.time-metric__top span\s*\{[^}]*font-size:\s*16px/s)
    expect(css).toMatch(/\.time-metric small\s*\{[^}]*font-size:\s*15px/s)
  })

  it('separates new lifecycle cases from case-specific review controls', () => {
    expect(lifecyclePage).toContain("actionKeys={module === 'offboarding' ? ['create_case'] : undefined}")
    expect(lifecyclePage).toContain("item.status === 'pending_approval'")
    expect(lifecyclePage).toContain("actionKeys={['review_case']}")
    expect(lifecyclePage).toContain("initialValues={{ id: item.id }}")
  })

  it('does not request the generic operations snapshot for domain-only report access', () => {
    expect(reportsPage).toContain("enabled: isSupabaseConfigured && canViewOperationalSummary")
    expect(reportsPage).toContain("sessionQuery.isSuccess ? <ReportLibrary")
    expect(reportsPage).toContain("definition && sessionQuery.isSuccess && !canViewTimeReport")
  })

  it('makes signed-out username recovery enumeration-safe and personal boards owner-only', () => {
    expect(migration).toContain('create table if not exists private.employee_self_service_username_requests')
    expect(migration).toContain('grant execute on function public.service_claim_self_service_username')
    expect(migration).toContain("board.scope <> 'personal'")
    expect(migration).toContain('private.sygtasks_can_view_task(target_recipient_employee_id, target_task_id)')
    expect(migration).toContain('create trigger sygtasks_personal_membership_owner_only')
    expect(migration).toContain('create trigger sygtasks_personal_assignee_owner_only')
    expect(migration).toContain('create trigger sygtasks_personal_watcher_owner_only')
    expect(migration).not.toContain("board.scope = 'personal'\n          and private.sygtasks_has_permission")
  })
})

/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260906141658_repair_timekeeping_automation_and_self_service_password_reset.sql'),
  'utf8',
)
const worker = readFileSync(join(root, 'worker', 'index.ts'), 'utf8')
const loginPage = readFileSync(join(root, 'src', 'pages', 'LoginPage.tsx'), 'utf8')
const router = readFileSync(join(root, 'src', 'app', 'router.tsx'), 'utf8')
const routeElements = readFileSync(join(root, 'src', 'app', 'RouteElements.tsx'), 'utf8')

describe('timekeeping automation and self-service password recovery guardrails', () => {
  it('closes only legitimate historical Dispatch sessions without permitting new Dispatch punches', () => {
    expect(migration).toContain("new.kind = 'clock_out'")
    expect(migration).toContain("new.source = 'system'")
    expect(migration).toContain("private.current_effective_time_event_kind(prior_event.id) in ('clock_in', 'break_start', 'break_end')")
    expect(migration).toContain('Dispatch phone duty is a concurrent responsibility and does not create a separate time-clock session.')
    expect(migration).not.toContain("new.kind = 'clock_in'\n      and new.source = 'system'")
  })

  it('keeps recovery claims private, append-only, rate-limited, and service-only', () => {
    expect(migration).toContain('employee_self_service_password_reset_requests')
    expect(migration).toContain('force row level security')
    expect(migration).toContain('private.prevent_append_only_change()')
    expect(migration).toContain("username_attempt_count >= 3 or fingerprint_attempt_count >= 10")
    expect(migration).toContain('pg_advisory_xact_lock')
    expect(migration).toContain('revoke all on function public.service_claim_self_service_password_reset')
    expect(migration).toContain('grant execute on function public.service_claim_self_service_password_reset')
  })

  it('provides a generic username-based recovery response without exposing account data', () => {
    expect(worker).toContain("'/api/v1/auth/password-reset/request'")
    expect(worker).toContain('If an active SygShift account and approved personal email match that username')
    expect(worker).toContain("notificationType: 'password_reset_self_service'")
    expect(worker).not.toContain("message: error instanceof Error ? error.message : 'Unknown password-reset failure'")
    expect(loginPage).toContain('Forgot password?')
    expect(loginPage).toContain('approved personal email on file')
  })

  it('keeps the one-time recovery callback and completion screen out of replaceable lazy chunks', () => {
    expect(router).toContain("import { AccountSecurityPage } from '../pages/AccountSecurityPage'")
    expect(router).toContain("import { PasswordRecoveryLinkPage } from '../pages/PasswordRecoveryLinkPage'")
    expect(router).toContain("path: '/password-recovery'")
    expect(routeElements).not.toContain('AccountSecurityPageRoute')
    expect(routeElements).not.toContain('PasswordRecoveryLinkPageRoute')
  })
})

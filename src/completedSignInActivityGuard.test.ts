import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '20260910030000_completed_sign_in_activity.sql'),
  'utf8',
)
const shell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')

describe('completed sign-in activity guardrails', () => {
  it('requires password proof and every application security checkpoint', () => {
    expect(migration).toContain("authentication_method ->> 'method' = 'password'")
    expect(migration).toContain('account.must_change_password')
    expect(migration).toContain('private.employee_requires_mfa(actor_id) and not public.has_mfa()')
    expect(migration).toContain('create table private.employee_sign_in_completions')
    expect(migration).toContain('auth_session_id uuid primary key')
    expect(migration).toContain('join auth.sessions auth_session')
    expect(migration).toContain('for update of account, employee, auth_session')
    expect(migration).toContain('get diagnostics updated_account_count = row_count')
    expect(migration).toContain('on conflict (auth_session_id) do nothing')
    expect(migration).toContain('greatest(coalesce(account.last_sign_in_at, recorded_at), recorded_at)')
    expect(migration).not.toContain('activated_at =')
  })

  it('keeps recovery and provider timestamps from becoming completed login activity', () => {
    expect(migration).toContain('Recovery, invite, magic-link, and service-created sessions')
    expect(migration).toContain("replace(function_definition, provider_activity_expression, 'account.last_sign_in_at')")
    expect(migration).not.toContain("last_sign_in_at = auth_user.last_sign_in_at")
  })

  it('records only after the shell determines that no security checkpoint remains', () => {
    expect(shell).toContain('completedSignInRecordKind(')
    expect(shell).toContain('if (!isSupabaseConfigured || !completedSignInKind || !authSessionId) return')
    expect(shell).toContain('recordCompletedSignInWithRetry(')
    expect(shell).toContain("new URLSearchParams(location.search).get('mode') === 'password-recovery'")
    expect(shell).toContain('signal: abortController.signal')
    expect(shell).toContain('setAuthSessionId(data.session ? authSessionIdFromAccessToken(data.session.access_token) : null)')
    expect(shell).toContain('[authSessionId, completedSignInKind, sessionContext?.employeeId]')
  })

  it('requires a bound, unexpired shared identity assertion for SygSphere', () => {
    expect(migration).toContain('public.has_shared_identity_session()')
    expect(migration).toContain("private.request_header('x-sygshift-shared-identity')")
    expect(migration).toContain('shared_session.auth_session_id = jwt_session_id')
    expect(migration).toContain('shared_session.expires_at > clock_timestamp()')
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(path, 'utf8')

describe('shared SygSphere release guard', () => {
  it('keeps the handoff one-time, employee-bound, and MFA-backed', () => {
    const worker = read('worker/sharedIdentity.ts')
    const migration = read('supabase/migrations/20260908183000_shared_sygsphere_session_bridge.sql')
    expect(worker).toContain("const destination = '/sygsphere'")
    expect(worker).toContain("request.headers.get('origin') !== config.issuer")
    expect(worker).toContain("service_get_employee_login_email_target")
    expect(worker).toContain("service_issue_shared_identity_session")
    expect(worker).not.toContain('externalRole')
    expect(migration).toContain('launch_request_id uuid not null unique')
    expect(migration).toContain("account.auth_user_id = target_auth_user_id")
    expect(migration).toContain("employee.status = 'active'")
    expect(migration).toContain('or public.has_shared_identity_session()')
    expect(migration).toContain('force row level security')
  })
})

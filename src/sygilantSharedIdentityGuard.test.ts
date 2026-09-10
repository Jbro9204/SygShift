import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('Sygilant reciprocal launch release guard', () => {
  it('keeps authorization in effective permissions and the launch single-use', () => {
    const migration = read('supabase/migrations/20260909233000_sygilant_platform_shared_launch.sql')
    const worker = read('worker/sygilantSharedIdentity.ts')
    const issueFunction = migration.slice(
      migration.indexOf('create or replace function public.service_issue_sygilant_shared_launch'),
      migration.indexOf('create or replace function public.service_consume_sygilant_shared_launch'),
    )
    const consumeFunction = migration.slice(
      migration.indexOf('create or replace function public.service_consume_sygilant_shared_launch'),
    )

    expect(migration).toContain("'apps.sygilant.access'")
    expect(migration).toContain("where access_role.code = 'system_admin'")
    expect(migration).toContain("any(private.employee_effective_permissions(employee.id))")
    expect(migration).toContain('assertion_hash text not null unique')
    expect(migration).toContain('nonce_hash text not null unique')
    expect(migration).toContain('source_session_id uuid not null')
    expect(issueFunction).toContain("'sourceAuthSessionId'")
    expect(issueFunction).toContain("source_session.id = source_session_id_value")
    expect(issueFunction).toContain('source_session.user_id = account.auth_user_id')
    expect(issueFunction).toContain('source_session.not_after is null or source_session.not_after > clock_timestamp()')
    expect(consumeFunction).toContain('source_session.id = launch_record.source_session_id')
    expect(consumeFunction).toContain('source_session.user_id = launch_record.auth_user_id')
    expect(consumeFunction).toContain('source_session.not_after is null or source_session.not_after > clock_timestamp()')
    expect(consumeFunction).toContain('for update')
    expect(consumeFunction).toContain('launch_record.consumed_at is not null')
    expect(consumeFunction).toContain('and launch.consumed_at is null')
    expect(consumeFunction).toContain('get diagnostics updated_count = row_count')
    expect(migration).toContain('force row level security')
    expect(worker).toContain("const assertionPattern = /^ssli_v1")
    expect(worker).toContain("request.headers.get('origin') !== config.issuer")
    expect(worker).toContain("context.permissions?.includes('apps.sygilant.access')")
    expect(worker).toContain('service_issue_sygilant_shared_launch')
    expect(worker).toContain('service_consume_sygilant_shared_launch')
    expect(worker).toContain('sourceAuthSessionId: claims.session_id')
    expect(worker).toContain('constantTimeEqual(signingSecret, consumerSecret)')
    expect(worker).not.toMatch(/localStorage|sessionStorage/)
  })

  it('keeps the handoff out of URLs and browser storage', () => {
    const browser = read('src/data/platformLaunch.ts')
    const workerIndex = read('worker/index.ts')
    expect(browser).toContain("input.name = name")
    expect(browser).toContain("form.method = 'POST'")
    expect(browser).toContain("['assertion', launch.assertion]")
    expect(browser).toContain('appendProtectedSessionHeaders')
    expect(browser).not.toMatch(/localStorage|sessionStorage/)
    expect(browser).not.toMatch(/[?&](?:assertion|token)=/)
    expect(workerIndex).toContain("form-action 'self' https://sygilant.us")
  })

  it('limits universal access to the ten approved roles and keeps AAL1 Guard-only', () => {
    const migration = read('supabase/migrations/20260912010000_universal_sygilant_launch_access.sql')
    const worker = read('worker/sygilantSharedIdentity.ts')
    const approvedRoles = [
      'system_guard',
      'system_dispatcher',
      'system_scheduler',
      'system_recruiting_licensing',
      'system_supervisor',
      'system_admin',
      'custom_chief',
      'operations_manager',
      'human_resources',
      'human_resources_employee',
    ]

    for (const role of approvedRoles) expect(migration).toContain(`'${role}'::text`)
    expect(migration).toContain("('system_guard'::text, false)")
    expect(migration.match(/::text, true\)/g)).toHaveLength(9)
    expect(migration).toContain("employee.role = 'guard'")
    expect(migration).toContain('not private.employee_requires_mfa(employee.id)')
    expect(migration).toContain("assurance_level <> 'aal1' or role_id = 'guard'")
    expect(migration).toContain('enforce_sygilant_launch_assurance')
    expect(migration).toContain('private.sygilant_launch_assurance_allowed(employee.id, assurance_value)')
    expect(worker).toContain("context.role === 'guard' && context.mfa_required === false")
    expect(worker).toContain("if (!hasMfa) return 'aal1'")
  })
})

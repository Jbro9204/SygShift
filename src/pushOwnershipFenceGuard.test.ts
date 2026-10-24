// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const migration = readFileSync(join(root, 'supabase', 'migrations', '20261024172500_fence_push_subscription_ownership.sql'), 'utf8')
const sqlRegression = readFileSync(join(root, 'supabase', 'tests', 'push_subscription_ownership_fence_regression.sql'), 'utf8')
const client = readFileSync(join(root, 'src', 'data', 'pushNotifications.ts'), 'utf8')

describe('push subscription ownership fence', () => {
  it('bounds migration lock and statement waits for the live push table', () => {
    expect(migration).toContain("set local lock_timeout = '5s'")
    expect(migration).toContain("set local statement_timeout = '60s'")
    expect(migration.indexOf("set local lock_timeout = '5s'")).toBeLessThan(migration.indexOf('alter table private.employee_push_subscriptions'))
  })

  it('requires immutable employee, auth user, auth session, and operation evidence', () => {
    expect(migration).toContain('target_expected_employee_id uuid')
    expect(migration).toContain('target_expected_auth_user_id uuid')
    expect(migration).toContain('target_expected_auth_session_id uuid')
    expect(migration).toContain('target_expected_owner_operation_id uuid')
    expect(migration).toContain('target_operation_id uuid')
    expect(migration).toContain('actor_id <> target_expected_employee_id')
    expect(migration).toContain('actor_auth_user_id <> target_expected_auth_user_id')
    expect(migration).toContain('actor_auth_session_id <> target_expected_auth_session_id')
    expect(migration).toContain('owner_auth_session_id = actor_auth_session_id')
    expect(migration).toContain('owner_operation_id = target_operation_id')
  })

  it('retires the ambient mutator without exposing private ownership state', () => {
    expect(migration).toContain('revoke execute on function public.set_my_push_subscription(jsonb,boolean) from authenticated')
    expect(migration).toContain('revoke all on function public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid) from public, anon, authenticated')
    expect(migration).toContain('grant execute on function public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid) to authenticated')
    expect(migration).not.toContain('grant execute on function public.set_my_push_subscription_guarded(jsonb,boolean,uuid,uuid,uuid,uuid,uuid) to anon')
  })

  it('redacts every owner identifier unless the full employee, user, and session identity matches', () => {
    const fullOwnerDisclosureGuard = /case when owner_employee_id = actor_id\s+and owner_auth_user_id = actor_auth_user_id\s+and owner_auth_session_id = actor_auth_session_id then owner_(?:employee_id|auth_user_id|auth_session_id) else null end/g
    expect([...migration.matchAll(fullOwnerDisclosureGuard)]).toHaveLength(6)
  })

  it('keeps an immutable private operation ledger and never lets an old replay mutate current ownership', () => {
    expect(migration).toContain('create table private.employee_push_ownership_operations')
    expect(migration).toContain('operation_id uuid primary key')
    expect(migration).toContain('desired_enabled boolean not null')
    expect(migration).toContain('expected_owner_operation_id uuid')
    expect(migration).toContain('auth_session_id uuid not null')
    expect(migration).toContain('alter table private.employee_push_ownership_operations enable row level security')
    expect(migration).toContain('alter table private.employee_push_ownership_operations force row level security')
    expect(migration).toContain('revoke all on private.employee_push_ownership_operations from public, anon, authenticated')
    expect(migration).toContain('existing_operation.endpoint <> endpoint_value')
    expect(migration).toContain('existing_operation.desired_enabled <> target_enabled')
    expect(migration).toContain('existing_operation.expected_owner_operation_id is distinct from target_expected_owner_operation_id')
    expect(migration).toContain('existing_operation.employee_id <> actor_id')
    expect(migration).toContain('existing_operation.auth_user_id <> actor_auth_user_id')
    expect(migration).toContain('existing_operation.auth_session_id <> actor_auth_session_id')
    expect(migration).toContain('operation_is_replay := true')
    expect(migration).toContain('owner_operation_id is not distinct from target_expected_owner_operation_id')
    expect(migration).toContain('if operation_confirmed and not operation_is_replay then')
    expect(migration.indexOf('if operation_is_replay then')).toBeLessThan(migration.indexOf("'confirmed', operation_confirmed"))
  })

  it('keeps the SQL rehearsal standalone, rollback-only, and unable to skip behavioral coverage', () => {
    expect(sqlRegression.trimStart()).toMatch(/^begin;/)
    expect(sqlRegression).toContain("set local statement_timeout = '30s'")
    expect(sqlRegression).toContain('set local plpgsql.check_asserts = on')
    expect(sqlRegression.trimEnd()).toMatch(/rollback;$/)
    expect(sqlRegression).toContain('raise exception \'Push ownership behavioral regression requires an active Auth session fixture.\'')
    expect(sqlRegression).not.toContain("raise notice 'No active Auth session")
    expect(sqlRegression).toContain('A unique operation delayed behind its expected predecessor is rejected')
  })

  it('fails closed without origin-wide coordination and validates every server response', () => {
    expect(client).toContain("const PUSH_OWNERSHIP_LOCK = 'sygshift:push-ownership:v2'")
    expect(client).toContain('navigator.locks')
    expect(client).toContain('BroadcastChannel')
    expect(client).toContain('PUSH_OWNERSHIP_EPOCH_KEY')
    expect(client).toContain('validateEvidence(data, identity, endpoint, operationId)')
    expect(client).toContain('target_expected_owner_operation_id: expectedOwnerOperationId')
    expect(client).toContain('const unsubscribed = await subscription.unsubscribe()')
    expect(client.indexOf('!evidence.confirmed || evidence.enabled')).toBeLessThan(client.indexOf('const unsubscribed = await subscription.unsubscribe()'))
    expect(client).not.toContain("rpc('set_my_push_subscription',")
  })
})

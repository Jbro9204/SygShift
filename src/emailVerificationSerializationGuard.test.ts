import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20261024157000_licensing_availability_recovery_and_email_source_ids.sql',
  'utf8',
)
const worker = readFileSync('worker/index.ts', 'utf8')
const accountData = readFileSync('src/data/myAccount.ts', 'utf8')
const accountPage = readFileSync('src/pages/MyAccountPage.tsx', 'utf8')

const functionStart = migration.indexOf(
  'create or replace function public.service_create_email_verification_operation(',
)
const functionEnd = migration.indexOf(
  'revoke all on function public.service_list_licensing_document_availability_recovery',
  functionStart,
)
const createVerificationOperation = migration.slice(functionStart, functionEnd)

describe('email verification operation serialization guardrails', () => {
  it('locks the immutable operation before the employee cooldown fence', () => {
    const authorization = createVerificationOperation.indexOf("if (select auth.role()) <> 'service_role'")
    const operationLock = createVerificationOperation.indexOf("'employee-email-verification-operation:'")
    const employeeLock = createVerificationOperation.indexOf("'employee-email-verification:'", operationLock)
    const replayLookup = createVerificationOperation.indexOf('where verification.operation_id = target_operation_id', employeeLock)
    const cooldown = createVerificationOperation.indexOf('if exists (', replayLookup)

    expect(functionStart).toBeGreaterThanOrEqual(0)
    expect(functionEnd).toBeGreaterThan(functionStart)
    expect(authorization).toBeGreaterThanOrEqual(0)
    expect(operationLock).toBeGreaterThan(authorization)
    expect(employeeLock).toBeGreaterThan(operationLock)
    expect(replayLookup).toBeGreaterThan(employeeLock)
    expect(cooldown).toBeGreaterThan(replayLookup)
  })

  it('recovers exact replays before cooldown and rejects binding drift', () => {
    const replayLookup = createVerificationOperation.indexOf('where verification.operation_id = target_operation_id')
    const bindingCheck = createVerificationOperation.indexOf("raise check_violation using message = 'Verification operation does not match its original binding.'", replayLookup)
    const replayed = createVerificationOperation.indexOf('replayed := true', bindingCheck)
    const cooldown = createVerificationOperation.indexOf('if exists (', replayed)
    const invalidate = createVerificationOperation.indexOf(
      'update private.employee_email_verifications',
      cooldown,
    )
    const replacement = createVerificationOperation.indexOf(
      'insert into private.employee_email_verifications',
      invalidate,
    )
    const result = createVerificationOperation.indexOf(
      "'operationId', operation_record.operation_id",
      replacement,
    )

    expect(replayLookup).toBeGreaterThanOrEqual(0)
    expect(bindingCheck).toBeGreaterThan(replayLookup)
    expect(replayed).toBeGreaterThan(bindingCheck)
    expect(cooldown).toBeGreaterThan(replayed)
    expect(invalidate).toBeGreaterThan(cooldown)
    expect(replacement).toBeGreaterThan(invalidate)
    expect(result).toBeGreaterThan(replacement)
    expect(createVerificationOperation.match(/pg_catalog\.pg_advisory_xact_lock\(/g)).toHaveLength(2)
  })

  it('never persists plaintext link material and makes the caller operation explicit', () => {
    expect(migration).toContain('operation_id uuid')
    expect(migration).toContain('purpose text')
    expect(migration).toContain('superseded_at timestamptz')
    expect(migration).toContain('employee_email_verification_binding_immutable')
    expect(migration).toContain('on private.employee_email_verifications(employee_id)')
    expect(migration).toContain('before update or delete on private.employee_email_verifications')
    expect(migration).toContain('drop function if exists public.service_create_email_verification(uuid, text, text, timestamptz)')
    expect(migration).toContain('drop function if exists public.service_create_email_verification_operation(uuid, text, text, timestamptz)')
    expect(migration).toContain('and item.superseded_at is null')
    expect(migration).not.toMatch(/raw_token|plaintext_token/)
    expect(worker).toContain('derivePersonalEmailVerificationToken(')
    expect(worker).toContain('target_operation_id: operationId')
    expect(worker).toContain('target_purpose: personalEmailVerificationPurpose')
    expect(worker).toContain('target_token_hash: tokenHash')
    expect(worker).not.toContain('const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()')
    expect(accountData).toContain('JSON.stringify({ email, operationId })')
    const persistIntent = accountPage.indexOf('persistPersonalEmailVerificationIntent(intent)')
    const dispatchIntent = accountPage.indexOf('await requestPersonalEmailVerification(', persistIntent)
    expect(persistIntent).toBeGreaterThanOrEqual(0)
    expect(dispatchIntent).toBeGreaterThan(persistIntent)
    expect(accountPage).toContain('clearPersonalEmailVerificationIntent()')
    expect(accountPage).toContain('intent.operationId')
  })

  it('returns the original confirmation receipt on an exact response-loss replay', () => {
    const confirmationStart = migration.indexOf(
      'create or replace function public.service_confirm_email_verification(',
    )
    const confirmationEnd = migration.indexOf(
      'create or replace function public.service_create_email_verification_operation(',
      confirmationStart,
    )
    const confirmation = migration.slice(confirmationStart, confirmationEnd)

    expect(confirmation).toContain('if verification.verified_at is not null then')
    expect(confirmation).toContain("'replayed', true")
    expect(confirmation).toContain("'verifiedAt', verification.verified_at")
    expect(confirmation).toContain('set verified_at = completed_at')
    expect(confirmation).toContain("'replayed', false")
  })

  it('resolves password and username retry chains to one canonical delivery source', () => {
    expect(migration.match(/with recursive claim_chain\(id, requested_at\) as \(/g)).toHaveLength(2)
    expect(migration).toContain('(request.requested_at, request.id) < (later.requested_at, later.id)')
    expect(migration).not.toContain(
      'request.requested_at between current_request.requested_at - interval \'5 minutes\'',
    )
  })

  it('uses the durable verification record as the one email source fence', () => {
    const routeStart = worker.indexOf("url.pathname === '/api/v1/account/email-verification/request'")
    const routeEnd = worker.indexOf("url.pathname === '/api/v1/account/email-verification/confirm'", routeStart)
    const route = worker.slice(routeStart, routeEnd)

    expect(route).toContain('completionFailureMayBeAmbiguous(error)')
    expect(route).toContain('verification = await createVerification()')
    expect(route).toContain('sendDurableInlineEmail(environment, verification.verificationId, email')
    expect(route.match(/sendDurableInlineEmail\(/g)).toHaveLength(1)
  })
})

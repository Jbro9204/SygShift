import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { z } from 'zod'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'
import { setSecurityKeySession } from '../lib/securityKeySession'
import { getSupabaseClient } from '../lib/supabase'
import { identityVerificationActorIsCurrent, identityVerificationActorIsCurrentNow, type IdentityVerificationActor } from '../lib/identityVerificationCoordinator'

export const securityKeySchema = z.object({
  id: z.string().uuid(),
  credentialId: z.string().min(1),
  label: z.string().min(1),
  deviceType: z.string().nullable(),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
})

const keyListSchema = z.object({
  featureEnabled: z.boolean(),
  pilotEligible: z.boolean(),
  keys: z.array(securityKeySchema),
  requestId: z.string(),
})

const optionsSchema = z.object({
  challengeId: z.string().uuid(),
  options: z.record(z.string(), z.unknown()),
  requestId: z.string(),
})

const registrationResultSchema = z.object({
  key: securityKeySchema,
  requestId: z.string(),
})

const authenticationResultSchema = z.object({
  securityKeyToken: z.string().min(32),
  expiresAt: z.string(),
  requestId: z.string(),
})

const removalResultSchema = z.object({
  removed: z.boolean(),
  requestId: z.string(),
})

const renameResultSchema = z.object({
  key: securityKeySchema,
  requestId: z.string(),
})

export type SecurityKeySummary = z.infer<typeof securityKeySchema>
export type SecurityKeyDirectory = z.infer<typeof keyListSchema>

async function assertActor(actor?: IdentityVerificationActor): Promise<void> {
  if (actor && !await identityVerificationActorIsCurrent(actor)) throw new Error('The signed-in session changed. Retry from the current page.')
}

async function securityKeyHeaders(actor?: IdentityVerificationActor): Promise<Headers> {
  await assertActor(actor)
  const { data, error } = await (actor?.client ?? getSupabaseClient()).auth.getSession()
  await assertActor(actor)
  if (error || !data.session?.access_token) {
    throw new Error('Your secure session has expired. Sign in again.')
  }

  return appendProtectedSessionHeaders({
    authorization: `Bearer ${data.session.access_token}`,
    'content-type': 'application/json',
  })
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : typeof payload?.message === 'string'
        ? payload.message
        : 'The security-key request could not be completed.'
    throw new Error(message)
  }
  return schema.parse(payload)
}

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>, actor?: IdentityVerificationActor): Promise<T> {
  const headers = await securityKeyHeaders(actor)
  await assertActor(actor)
  const result = await parseResponse(await fetch(path, { ...init, headers }), schema)
  await assertActor(actor)
  return result
}

export function isSecurityKeySupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && typeof window.PublicKeyCredential !== 'undefined'
}

export async function getSecurityKeyDirectory(): Promise<SecurityKeyDirectory> {
  return request('/api/v1/account/security-keys', { method: 'GET' }, keyListSchema)
}

export async function listSecurityKeys(): Promise<SecurityKeySummary[]> {
  return (await getSecurityKeyDirectory()).keys
}

export async function registerSecurityKey(label: string): Promise<SecurityKeySummary> {
  if (!isSecurityKeySupported()) {
    throw new Error('This browser or connection cannot use security keys.')
  }

  const trimmedLabel = label.trim()
  if (!trimmedLabel) throw new Error('Enter a name for this security key.')

  const setup = await request(
    '/api/v1/account/security-keys/registration/options',
    { body: JSON.stringify({ label: trimmedLabel }), method: 'POST' },
    optionsSchema,
  )
  const response = await startRegistration({ optionsJSON: setup.options as never })
  const result = await request(
    '/api/v1/account/security-keys/registration/verify',
    { body: JSON.stringify({ challengeId: setup.challengeId, label: trimmedLabel, response }), method: 'POST' },
    registrationResultSchema,
  )
  return result.key
}

export async function authenticateWithSecurityKey(actor?: IdentityVerificationActor): Promise<void> {
  await assertActor(actor)
  if (!isSecurityKeySupported()) {
    throw new Error('This browser or connection cannot use security keys.')
  }

  const setup = await request(
    '/api/v1/account/security-keys/authentication/options',
    { body: '{}', method: 'POST' },
    optionsSchema,
    actor,
  )
  const response = await startAuthentication({ optionsJSON: setup.options as never })
  await assertActor(actor)
  const result = await request(
    '/api/v1/account/security-keys/authentication/verify',
    { body: JSON.stringify({ challengeId: setup.challengeId, response }), method: 'POST' },
    authenticationResultSchema,
    actor,
  )
  if (actor && !identityVerificationActorIsCurrentNow(actor)) throw new Error('The signed-in session changed. Retry from the current page.')
  setSecurityKeySession(result.securityKeyToken, result.expiresAt)
}

export async function removeSecurityKey(keyId: string): Promise<void> {
  const result = await request(
    `/api/v1/account/security-keys/${encodeURIComponent(keyId)}`,
    { method: 'DELETE' },
    removalResultSchema,
  )
  if (!result.removed) throw new Error('The security key was not removed.')
}

export async function renameSecurityKey(keyId: string, label: string): Promise<SecurityKeySummary> {
  const trimmedLabel = label.trim()
  if (!trimmedLabel) throw new Error('Enter a name for this security key.')
  return (await request(
    `/api/v1/account/security-keys/${encodeURIComponent(keyId)}`,
    { body: JSON.stringify({ label: trimmedLabel }), method: 'PATCH' },
    renameResultSchema,
  )).key
}

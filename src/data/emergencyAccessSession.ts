import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'

export const EMERGENCY_PLATFORM_SESSION_REGISTER_ENDPOINT = '/api/v1/security/emergency-session/register'
export const EMERGENCY_PLATFORM_SESSION_ACKNOWLEDGEMENT_ENDPOINT = '/api/v1/security/emergency-session/revocation-acknowledgement'

const registrationSchema = z.object({
  accessGeneration: z.number().int().positive(),
  application: z.literal('sygshift'),
  expiresAt: z.string().datetime(),
  id: z.string().uuid(),
  registered: z.literal(true),
})

const acknowledgementSchema = z.object({
  accessGeneration: z.number().int().positive(),
  acknowledged: z.literal(true),
  acknowledgedAt: z.string().datetime(),
  application: z.literal('sygshift'),
  closed: z.literal(true),
  operationId: z.string().uuid(),
})

export type EmergencyPlatformSessionRegistration = z.infer<typeof registrationSchema>
export type EmergencyPlatformSessionAcknowledgement = z.infer<typeof acknowledgementSchema>

export class EmergencyPlatformSessionError extends Error {
  readonly transient: boolean

  constructor(transient: boolean) {
    super('Your centralized access session could not be verified.')
    this.name = 'EmergencyPlatformSessionError'
    this.transient = transient
  }
}

function isTransientStatus(status: number): boolean {
  return status === 0
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
}

async function currentAccessToken(): Promise<string> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new EmergencyPlatformSessionError(false)
  return data.session.access_token
}

async function postEmergencySessionRequest(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  suppliedAccessToken?: string,
): Promise<{ payload: unknown, status: number }> {
  const accessToken = suppliedAccessToken?.trim() || await currentAccessToken()
  let response: Response
  try {
    response = await fetch(endpoint, {
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal,
    })
  } catch {
    throw new EmergencyPlatformSessionError(true)
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new EmergencyPlatformSessionError(isTransientStatus(response.status))
  return { payload, status: response.status }
}

export async function registerEmergencyPlatformSession(
  expectedAccessGeneration: number,
  signal?: AbortSignal,
): Promise<EmergencyPlatformSessionRegistration> {
  if (!Number.isInteger(expectedAccessGeneration) || expectedAccessGeneration <= 0) {
    throw new EmergencyPlatformSessionError(false)
  }
  const { payload } = await postEmergencySessionRequest(
    EMERGENCY_PLATFORM_SESSION_REGISTER_ENDPOINT,
    { expectedAccessGeneration },
    signal,
  )
  const parsed = registrationSchema.safeParse(payload)
  if (!parsed.success || parsed.data.accessGeneration !== expectedAccessGeneration) {
    throw new EmergencyPlatformSessionError(false)
  }
  return parsed.data
}

export async function acknowledgeEmergencyPlatformSessionRevocation(
  operationId: string,
  accessGeneration: number,
  revokedAccessToken: string,
  signal?: AbortSignal,
): Promise<EmergencyPlatformSessionAcknowledgement> {
  if (!z.string().uuid().safeParse(operationId).success
    || !Number.isInteger(accessGeneration)
    || accessGeneration <= 0
    || !revokedAccessToken.trim()) {
    throw new EmergencyPlatformSessionError(false)
  }
  const { payload } = await postEmergencySessionRequest(
    EMERGENCY_PLATFORM_SESSION_ACKNOWLEDGEMENT_ENDPOINT,
    { accessGeneration, operationId },
    signal,
    revokedAccessToken,
  )
  const parsed = acknowledgementSchema.safeParse(payload)
  if (!parsed.success
    || parsed.data.operationId !== operationId
    || parsed.data.accessGeneration !== accessGeneration) {
    throw new EmergencyPlatformSessionError(false)
  }
  return parsed.data
}

export function isTransientEmergencyPlatformSessionError(error: unknown): boolean {
  return error instanceof EmergencyPlatformSessionError && error.transient
}

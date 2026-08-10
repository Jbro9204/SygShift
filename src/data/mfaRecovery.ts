import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { getTrustedDeviceToken } from '../lib/trustedDeviceToken'

const recoveryCodeBatchSchema = z.object({
  batchId: z.string().uuid(),
  codes: z.array(z.string().regex(/^SYG-[A-Z0-9]{4}-[A-Z0-9]{4}$/)).length(10),
  expiresAt: z.string(),
  requestId: z.string(),
})

const recoveryResultSchema = z.object({
  factorsRemoved: z.number().int().nonnegative(),
  trustedDevicesRevoked: z.number().int().nonnegative(),
  requestId: z.string(),
})

export type MfaRecoveryCodeBatch = z.infer<typeof recoveryCodeBatchSchema>
export type MfaRecoveryResult = z.infer<typeof recoveryResultSchema>

async function accountRequest<T>(path: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure session has expired. Sign in again.')

  const trustedDeviceToken = getTrustedDeviceToken()
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${data.session.access_token}`,
      'content-type': 'application/json',
      ...(trustedDeviceToken ? { 'x-sygshift-trusted-device': trustedDeviceToken } : {}),
    },
    method: 'POST',
  })
  const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? 'The secure account request could not be completed.')
  }
  return schema.parse(payload)
}

export function generateMfaRecoveryCodes(): Promise<MfaRecoveryCodeBatch> {
  return accountRequest('/api/v1/account/mfa-recovery-codes', {}, recoveryCodeBatchSchema)
}

export function recoverMfaWithCode(code: string): Promise<MfaRecoveryResult> {
  return accountRequest('/api/v1/account/mfa-recovery', { code }, recoveryResultSchema)
}

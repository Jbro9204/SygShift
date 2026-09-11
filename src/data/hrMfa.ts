import { z } from 'zod'
import { documentApiRequest } from './hrDocuments'

const hrMfaWindowSchema = z.object({
  expiresAt: z.string(),
  method: z.enum(['authenticator', 'security_key']),
  verifiedAt: z.string(),
})

export type HrMfaWindow = z.infer<typeof hrMfaWindowSchema>

export async function requireHrMfaWindow(): Promise<HrMfaWindow> {
  const response = await documentApiRequest('/api/v1/hr/mfa/window')
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null
  if (!response.ok) {
    throw new Error(typeof payload?.detail === 'string'
      ? payload.detail
      : 'Your HR verification window is unavailable. Try again.')
  }
  return hrMfaWindowSchema.parse(payload)
}

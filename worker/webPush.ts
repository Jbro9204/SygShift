import { buildPushPayload } from '@block65/webcrypto-web-push'
import { z } from 'zod'

export type PushConfiguration = { publicKey: string; privateKey: string; hookSecret: string }
export type PushRpc = (name: string, input: Record<string, unknown>) => Promise<unknown>
const jobSchema = z.object({
  id: z.string().uuid(), claimToken: z.string().uuid(), notificationId: z.string().uuid(), employeeId: z.string().uuid(),
  createdAt: z.string(), path: z.string(), attempt: z.number(), eligible: z.boolean(),
  subscription: z.object({ endpoint: z.string(), expirationTime: z.null(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
})
export function allowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return endpoint.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/.test(url.hostname)
  } catch { return false }
}
export async function validPushHook(provided: string | null, expected: string): Promise<boolean> {
  if (!expected) return false
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`Bearer ${expected}`))
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(provided || ''))
}
export async function deliverPushBatch(config: PushConfiguration, rpc: PushRpc): Promise<number> {
  const jobs = z.array(jobSchema).parse(await rpc('service_claim_employee_push', { target_limit: 25 }))
  for (let offset = 0; offset < jobs.length; offset += 5) {
    await Promise.all(jobs.slice(offset, offset + 5).map(async (job) => {
      let outcome = 'expired'
      if (job.eligible && allowedPushEndpoint(job.subscription.endpoint)) {
        try {
          const path = job.path.startsWith('/') && !job.path.startsWith('//') && !/[\\\r\n]/.test(job.path) ? job.path : '/notifications'
          const payload = await buildPushPayload({ data: JSON.stringify({ id: job.notificationId, employeeId: job.employeeId, createdAt: job.createdAt, path }), options: { ttl: 120 } },
            job.subscription, { publicKey: config.publicKey, privateKey: config.privateKey, subject: 'mailto:scheduling@sygilant.us' })
          const response = await fetch(job.subscription.endpoint, { ...payload, redirect: 'error', signal: AbortSignal.timeout(4000) })
          outcome = response.ok ? 'delivered' : response.status === 404 || response.status === 410 ? 'unavailable'
            : response.status === 429 || response.status >= 500 ? 'retry' : 'failed'
          await response.body?.cancel()
        } catch { outcome = 'retry' }
      }
      await rpc('service_complete_employee_push', { target_id: job.id, target_claim_token: job.claimToken, target_outcome: outcome })
    }))
  }
  return jobs.length
}

import { buildPushPayload } from '@block65/webcrypto-web-push'
import { z } from 'zod'

export type PushConfiguration = { publicKey: string; privateKey: string; hookSecret: string }
export type PushRpc = (name: string, input: Record<string, unknown>) => Promise<unknown>
type PushOutcome = 'delivered' | 'expired' | 'failed' | 'retry' | 'unavailable'
const completionAttemptLimit = 3
type PushProviderState = 'accepted' | 'pending' | 'resolved' | 'uncertain'
type PushTerminalOutcome = Exclude<PushOutcome, 'retry'>
const reconciliationSchema = z.object({
  reconciled: z.number().int().nonnegative(),
  disabledSubscriptions: z.number().int().nonnegative(),
  completionPending: z.number().int().nonnegative(),
  reviewRequired: z.number().int().nonnegative(),
})
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

async function completePushDelivery(
  rpc: PushRpc,
  job: z.infer<typeof jobSchema>,
  outcome: PushOutcome,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= completionAttemptLimit; attempt += 1) {
    try {
      // The completion RPC is claim-token scoped and idempotent. Retrying this
      // exact write reconciles both a pre-commit failure and a lost response
      // without making another provider request.
      await rpc('service_complete_employee_push', {
        target_id: job.id,
        target_claim_token: job.claimToken,
        target_outcome: outcome,
      })
      return
    } catch (error) {
      lastError = error
    }
  }

  console.error(JSON.stringify({
    event: 'push_delivery_completion_unknown',
    jobId: job.id,
    providerAccepted: outcome === 'delivered',
  }))
  throw lastError
}

async function markPushProviderState(
  rpc: PushRpc,
  job: z.infer<typeof jobSchema>,
  providerState: PushProviderState,
  providerOutcome: PushTerminalOutcome | null,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= completionAttemptLimit; attempt += 1) {
    try {
      await rpc('service_mark_employee_push_provider_state', {
        target_id: job.id,
        target_claim_token: job.claimToken,
        target_provider_state: providerState,
        target_provider_outcome: providerOutcome,
      })
      return
    } catch (error) {
      lastError = error
    }
  }
  console.error(JSON.stringify({
    event: 'push_provider_state_persistence_unknown',
    jobId: job.id,
    providerState,
  }))
  throw lastError
}

export async function reconcilePushProviderOutcomes(rpc: PushRpc): Promise<z.infer<typeof reconciliationSchema>> {
  const result = reconciliationSchema.parse(await rpc(
    'service_reconcile_employee_push_provider_outcomes',
    { target_limit: 100 },
  ))
  if (result.reviewRequired > 0) {
    console.warn(JSON.stringify({
      event: 'push_provider_review_required',
      count: result.reviewRequired,
    }))
  }
  return result
}

export async function deliverPushBatch(config: PushConfiguration, rpc: PushRpc): Promise<number> {
  const jobs = z.array(jobSchema).parse(await rpc('service_claim_employee_push', { target_limit: 25 }))
  // Scheduled database containment relies on one in-flight RPC at a time. A
  // transient completion failure must stop the batch before four sibling
  // completion calls are already competing for the same constrained pool.
  for (const job of jobs) {
    let outcome: PushOutcome = 'expired'
    if (job.eligible && allowedPushEndpoint(job.subscription.endpoint)) {
      let payload: Awaited<ReturnType<typeof buildPushPayload>>
      try {
        const path = job.path.startsWith('/') && !job.path.startsWith('//') && !/[\\\r\n]/.test(job.path) ? job.path : '/notifications'
        payload = await buildPushPayload({ data: JSON.stringify({ id: job.notificationId, employeeId: job.employeeId, createdAt: job.createdAt, path }), options: { ttl: 120 } },
          job.subscription, { publicKey: config.publicKey, privateKey: config.privateKey, subject: 'mailto:scheduling@sygilant.us' })
      } catch {
        // No provider request was made. Preserve the existing bounded retry
        // behavior for a transient encryption/runtime failure.
        outcome = 'retry'
        await markPushProviderState(rpc, job, 'pending', null)
        await completePushDelivery(rpc, job, outcome)
        continue
      }

      let response: Response
      try {
        response = await fetch(job.subscription.endpoint, { ...payload, redirect: 'error', signal: AbortSignal.timeout(4000) })
      } catch {
        // Fetch does not expose whether bytes left the Worker. Persist the
        // ambiguity and fence this attempt from automatic resend. Operations
        // may explicitly retry only after provider evidence proves it unsent.
        await markPushProviderState(rpc, job, 'uncertain', null)
        console.warn(JSON.stringify({ event: 'push_provider_outcome_unknown', jobId: job.id }))
        continue
      }

      outcome = response.ok ? 'delivered' : response.status === 404 || response.status === 410 ? 'unavailable'
        : response.status === 429 || response.status >= 500 ? 'retry' : 'failed'
      const providerState: PushProviderState = outcome === 'delivered'
        ? 'accepted'
        : outcome === 'retry'
          ? 'pending'
          : 'resolved'
      const providerOutcome: PushTerminalOutcome | null = outcome === 'retry' ? null : outcome
      // Persisting the provider result is deliberately outside the fetch
      // catch. A committed write whose response is lost must be retried with
      // the same state/outcome, never relabeled as an uncertain provider call.
      await markPushProviderState(rpc, job, providerState, providerOutcome)
      // Body disposal is transport housekeeping, not part of the provider
      // acceptance decision. A cancellation failure cannot relabel an
      // accepted push as retryable and cause a duplicate send.
      try { await response.body?.cancel() } catch { /* response outcome remains authoritative */ }
    } else {
      await markPushProviderState(rpc, job, 'resolved', 'expired')
    }
    await completePushDelivery(rpc, job, outcome)
  }
  return jobs.length
}

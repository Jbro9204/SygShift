export type OperationalEmailLane = 'general' | 'timekeeping' | 'time_off' | 'support' | 'employee'

export interface OperationalEmailJobIdentity {
  id: string
  messageType?: string
  aggregateId?: string
}

export interface OperationalEmailDeliveryResult {
  status: 'delivered' | 'suppressed' | 'held'
  acceptedCount: number
  suppressedCount: number
  heldCount: number
}

interface DeliveryDependencies {
  rpc: (name: string, parameters: Record<string, unknown>) => Promise<unknown>
  send: (email: string) => Promise<void>
  blocked: (email: string) => boolean
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const maximumRecipients = 10_000

function invalidProof(): never {
  throw new Error('The operational email delivery result could not be verified.')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidProof()
  return value as Record<string, unknown>
}

function identity(value: unknown, job: OperationalEmailJobIdentity, lane: OperationalEmailLane) {
  const proof = object(value)
  if (proof.jobId !== job.id || proof.lane !== lane || proof.messageType !== job.messageType
    || proof.aggregateId !== (job.aggregateId ?? null)) return invalidProof()
  return proof
}

/** Operational queue mail only; account recovery and security notices do not use this path. */
export async function deliverOperationalEmailJob(
  job: OperationalEmailJobIdentity,
  lane: OperationalEmailLane,
  dependencies: DeliveryDependencies,
): Promise<OperationalEmailDeliveryResult> {
  if (typeof job.id !== 'string' || !uuidPattern.test(job.id)
    || typeof job.messageType !== 'string' || !job.messageType || job.messageType.length > 100
    || (job.aggregateId !== undefined && (typeof job.aggregateId !== 'string' || !uuidPattern.test(job.aggregateId)))) return invalidProof()
  const parameters = { target_job_id: job.id, target_lane: lane }
  const resolved = identity(await dependencies.rpc('service_resolve_operational_email_recipients', parameters), job, lane)
  if (!Array.isArray(resolved.recipientEmployeeIds) || resolved.recipientEmployeeIds.length > maximumRecipients
    || resolved.recipientEmployeeIds.some((id) => typeof id !== 'string' || !uuidPattern.test(id))
    || new Set(resolved.recipientEmployeeIds).size !== resolved.recipientEmployeeIds.length) return invalidProof()

  for (const employeeId of resolved.recipientEmployeeIds as string[]) {
    const recipientParameters = { ...parameters, target_employee_id: employeeId }
    const claimed = identity(await dependencies.rpc('service_claim_operational_email_recipient', recipientParameters), job, lane)
    if (claimed.employeeId !== employeeId) return invalidProof()
    if (claimed.state === 'accepted' || claimed.state === 'suppressed' || claimed.state === 'held') continue
    if (claimed.state !== 'send' || typeof claimed.attemptId !== 'string' || !uuidPattern.test(claimed.attemptId)
      || typeof claimed.email !== 'string' || claimed.email.length > 254
      || claimed.email !== claimed.email.trim().toLowerCase() || !emailPattern.test(claimed.email)) return invalidProof()

    const resultParameters = { ...recipientParameters, target_attempt_id: claimed.attemptId }
    let outcome: 'accepted' | 'unknown' | 'suppressed' = 'unknown'
    if (dependencies.blocked(claimed.email)) outcome = 'suppressed'
    else {
      try {
        await dependencies.send(claimed.email)
        outcome = 'accepted'
      } catch {
        // A provider exception does not prove that handoff failed. Keep this
        // exact recipient on hold instead of blindly sending it a second time.
      }
    }
    try {
      const recorded = identity(await dependencies.rpc('service_record_operational_email_recipient_result', {
        ...resultParameters, target_outcome: outcome,
      }), job, lane)
      if (recorded.employeeId !== employeeId
        || !['accepted', 'suppressed', 'held'].includes(String(recorded.state))) return invalidProof()
      if (outcome === 'accepted' && recorded.state !== 'accepted') return invalidProof()
      if (outcome === 'suppressed' && recorded.state !== 'suppressed') return invalidProof()
      if (outcome === 'unknown' && !['accepted', 'held'].includes(String(recorded.state))) return invalidProof()
    } catch (error) {
      if (outcome !== 'accepted') throw error
      // If acceptance was committed but its reply was lost, the same immutable
      // attempt remains accepted. Otherwise this closes it as uncertain.
      const held = identity(await dependencies.rpc('service_record_operational_email_recipient_result', {
        ...resultParameters, target_outcome: 'unknown',
      }), job, lane)
      if (held.employeeId !== employeeId || !['accepted', 'held'].includes(String(held.state))) return invalidProof()
    }
  }

  let completion: unknown
  try {
    completion = await dependencies.rpc('service_finalize_operational_email_job', parameters)
  } catch {
    // This operation derives a terminal state solely from immutable recipient
    // evidence. Reconcile its exact lost response once; never repeat a send.
    completion = await dependencies.rpc('service_finalize_operational_email_job', parameters)
  }
  const finalized = identity(completion, job, lane)
  if (!['delivered', 'suppressed', 'held'].includes(String(finalized.status))) return invalidProof()
  for (const field of ['acceptedCount', 'suppressedCount', 'heldCount'] as const) {
    if (!Number.isSafeInteger(finalized[field]) || (finalized[field] as number) < 0
      || (finalized[field] as number) > maximumRecipients) return invalidProof()
  }
  const acceptedCount = finalized.acceptedCount as number
  const suppressedCount = finalized.suppressedCount as number
  const heldCount = finalized.heldCount as number
  if (acceptedCount + suppressedCount + heldCount !== resolved.recipientEmployeeIds.length
    || (finalized.status === 'held') !== (heldCount > 0)
    || (finalized.status === 'delivered' && acceptedCount === 0)
    || (finalized.status === 'suppressed' && (acceptedCount > 0 || heldCount > 0))) return invalidProof()
  return { status: finalized.status as OperationalEmailDeliveryResult['status'], acceptedCount, suppressedCount, heldCount }
}

export async function deferOperationalEmailJob(
  job: OperationalEmailJobIdentity,
  lane: OperationalEmailLane,
  rpc: DeliveryDependencies['rpc'],
): Promise<'delivered' | 'suppressed' | 'held' | 'deferred'> {
  const result = identity(await rpc('service_defer_operational_email_job', { target_job_id: job.id, target_lane: lane }), job, lane)
  if (!['delivered', 'suppressed', 'held', 'deferred'].includes(String(result.status))) return invalidProof()
  return result.status as 'delivered' | 'suppressed' | 'held' | 'deferred'
}

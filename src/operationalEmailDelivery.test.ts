import { describe, expect, it, vi } from 'vitest'
import { deferOperationalEmailJob, deliverOperationalEmailJob, type OperationalEmailLane } from '../worker/operationalEmailDelivery'

const job = { id: '10000000-0000-4000-8000-000000000001', aggregateId: '20000000-0000-4000-8000-000000000001', messageType: 'announcement_published' }
const employeeA = '30000000-0000-4000-8000-000000000001'
const employeeB = '30000000-0000-4000-8000-000000000002'
const attempt = '40000000-0000-4000-8000-000000000001'
const lane: OperationalEmailLane = 'general'
const proof = (extra: Record<string, unknown> = {}, selectedLane: OperationalEmailLane = lane) => ({ jobId: job.id, lane: selectedLane, messageType: job.messageType, aggregateId: job.aggregateId, ...extra })

function ledger(ids = [employeeA], selectedLane: OperationalEmailLane = lane) {
  const states = new Map<string, string>()
  let terminalState: string | null = null
  const rpc = vi.fn(async (name: string, parameters: Record<string, unknown>): Promise<unknown> => {
    const employeeId = parameters.target_employee_id as string
    if (name === 'service_resolve_operational_email_recipients') return proof({ recipientEmployeeIds: ids }, selectedLane)
    if (name === 'service_claim_operational_email_recipient') {
      const previous = states.get(employeeId)
      if (previous) return proof({ employeeId, state: previous }, selectedLane)
      states.set(employeeId, 'held')
      return proof({ employeeId, state: 'send', attemptId: attempt, email: `${employeeId === employeeA ? 'current' : 'second'}@example.test` }, selectedLane)
    }
    if (name === 'service_record_operational_email_recipient_result') {
      const previous = states.get(employeeId)
      const state = previous === 'accepted' ? previous : parameters.target_outcome === 'accepted' ? 'accepted'
        : parameters.target_outcome === 'suppressed' ? 'suppressed' : 'held'
      states.set(employeeId, state)
      return proof({ employeeId, state }, selectedLane)
    }
    if (name === 'service_finalize_operational_email_job') {
      const counts = { acceptedCount: 0, suppressedCount: 0, heldCount: 0 }
      for (const id of ids) {
        if (states.get(id) === 'accepted') counts.acceptedCount += 1
        else if (states.get(id) === 'suppressed') counts.suppressedCount += 1
        else counts.heldCount += 1
      }
      const status = counts.heldCount ? 'held' : counts.acceptedCount ? 'delivered' : 'suppressed'
      if (terminalState !== null && terminalState !== status) throw new Error('Held delivery requires reconciliation')
      terminalState = status
      return proof({ ...counts, status }, selectedLane)
    }
    throw new Error('Unexpected synthetic RPC')
  })
  return { states, rpc, send: vi.fn<(email: string) => Promise<void>>().mockResolvedValue(undefined), blocked: vi.fn(() => false) }
}

describe('operational email delivery recipient boundary', () => {
  it.each(['delivered', 'suppressed', 'held', 'deferred'] as const)('retains the exact authoritative %s result when deferring an uncertain job', async (status) => {
    const rpc = vi.fn().mockResolvedValue(proof({ status }))
    expect(await deferOperationalEmailJob(job, lane, rpc)).toBe(status)
    expect(rpc).toHaveBeenCalledExactlyOnceWith('service_defer_operational_email_job', { target_job_id: job.id, target_lane: lane })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('delivery_error')
  })

  it('rejects mismatched deferral proof instead of trusting an unrelated terminal result', async () => {
    const rpc = vi.fn().mockResolvedValue(proof({ jobId: employeeA, status: 'delivered' }))
    await expect(deferOperationalEmailJob(job, lane, rpc)).rejects.toThrow('could not be verified')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each(['general', 'timekeeping', 'time_off', 'support', 'employee'] as const)('uses the exact job and canonical recipient in the %s lane', async (selectedLane) => {
    const dependencies = ledger([employeeA], selectedLane)
    expect(await deliverOperationalEmailJob(job, selectedLane, dependencies)).toEqual({ status: 'delivered', acceptedCount: 1, suppressedCount: 0, heldCount: 0 })
    expect(dependencies.send).toHaveBeenCalledExactlyOnceWith('current@example.test')
    expect(dependencies.rpc.mock.calls[1]).toEqual(['service_claim_operational_email_recipient', { target_job_id: job.id, target_lane: selectedLane, target_employee_id: employeeA }])
    expect(JSON.stringify(dependencies.rpc.mock.calls)).not.toContain('@example.test')
  })

  it('does not send when the canonical employee becomes ineligible after audience resolution', async () => {
    const dependencies = ledger()
    dependencies.states.set(employeeA, 'suppressed')
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'suppressed', suppressedCount: 1 })
    expect(dependencies.send).not.toHaveBeenCalled()
  })

  it('retains an uncertain provider handoff and never retries that employee automatically', async () => {
    const dependencies = ledger()
    dependencies.send.mockRejectedValue(new Error('Provider response lost https://private.invalid/?token=do-not-record'))
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'held', heldCount: 1 })
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'held', heldCount: 1 })
    expect(dependencies.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(dependencies.rpc.mock.calls)).not.toContain('token=')
    expect(dependencies.rpc).toHaveBeenCalledWith('service_record_operational_email_recipient_result', expect.objectContaining({ target_outcome: 'unknown', target_attempt_id: attempt }))
  })

  it('preserves committed acceptance when only its response is lost', async () => {
    const dependencies = ledger()
    const original = dependencies.rpc.getMockImplementation()!
    let lost = false
    dependencies.rpc.mockImplementation(async (name, parameters) => {
      const result = await original(name, parameters)
      if (name === 'service_record_operational_email_recipient_result' && parameters.target_outcome === 'accepted' && !lost) {
        lost = true
        throw new Error('Acceptance response lost')
      }
      return result
    })
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'delivered', acceptedCount: 1 })
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'delivered', acceptedCount: 1 })
    expect(dependencies.send).toHaveBeenCalledTimes(1)
  })

  it('does not replay earlier accepted recipients after a later recipient lookup fails', async () => {
    const dependencies = ledger([employeeA, employeeB])
    const original = dependencies.rpc.getMockImplementation()!
    let fail = true
    dependencies.rpc.mockImplementation(async (name, parameters) => {
      if (name === 'service_claim_operational_email_recipient' && parameters.target_employee_id === employeeB && fail) {
        fail = false
        throw new Error('Eligibility lookup temporarily unavailable')
      }
      return original(name, parameters)
    })
    await expect(deliverOperationalEmailJob(job, lane, dependencies)).rejects.toThrow('Eligibility lookup')
    expect(dependencies.send).toHaveBeenCalledExactlyOnceWith('current@example.test')
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'delivered', acceptedCount: 2 })
    expect(dependencies.send.mock.calls).toEqual([['current@example.test'], ['second@example.test']])
  })

  it('holds a claimed recipient if all result acknowledgments are unavailable', async () => {
    const dependencies = ledger()
    const original = dependencies.rpc.getMockImplementation()!
    dependencies.rpc.mockImplementation(async (name, parameters) => {
      if (name === 'service_record_operational_email_recipient_result') throw new Error('Result unavailable')
      return original(name, parameters)
    })
    await expect(deliverOperationalEmailJob(job, lane, dependencies)).rejects.toThrow('Result unavailable')
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'held', heldCount: 1 })
    expect(dependencies.send).toHaveBeenCalledTimes(1)
  })

  it('retains the independent blocked-domain safeguard without calling the provider', async () => {
    const dependencies = ledger()
    dependencies.blocked.mockReturnValue(true)
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'suppressed', suppressedCount: 1 })
    expect(dependencies.send).not.toHaveBeenCalled()
    expect(dependencies.rpc).toHaveBeenCalledWith('service_record_operational_email_recipient_result', expect.objectContaining({ target_outcome: 'suppressed' }))
  })

  it.each([{ jobId: employeeA }, { lane: 'employee' }, { messageType: 'account_recovery' }, { aggregateId: employeeA }, { recipientEmployeeIds: [employeeA, employeeA] }, { recipientEmployeeIds: [[employeeA]] }])('rejects mismatched or malformed audience proof %j without sending', async (override) => {
    const dependencies = ledger()
    dependencies.rpc.mockResolvedValue(proof({ recipientEmployeeIds: [employeeA], ...override }))
    await expect(deliverOperationalEmailJob(job, lane, dependencies)).rejects.toThrow('could not be verified')
    expect(dependencies.send).not.toHaveBeenCalled()
  })

  it.each([{ employeeId: employeeB }, { attemptId: [attempt] }, { email: 'raw\r\nBcc: private@example.test' }, { state: 'ready' }])('rejects malformed recipient proof %j before provider handoff', async (override) => {
    const dependencies = ledger()
    const original = dependencies.rpc.getMockImplementation()!
    dependencies.rpc.mockImplementation(async (name, parameters) => name === 'service_claim_operational_email_recipient'
      ? proof({ employeeId: employeeA, state: 'send', attemptId: attempt, email: 'current@example.test', ...override }) : original(name, parameters))
    await expect(deliverOperationalEmailJob(job, lane, dependencies)).rejects.toThrow('could not be verified')
    expect(dependencies.send).not.toHaveBeenCalled()
  })

  it('does not accept incomplete final counts as a completed delivery', async () => {
    const dependencies = ledger()
    const original = dependencies.rpc.getMockImplementation()!
    dependencies.rpc.mockImplementation(async (name, parameters) => name === 'service_finalize_operational_email_job'
      ? proof({ status: 'delivered', acceptedCount: 0, suppressedCount: 0, heldCount: 0 }) : original(name, parameters))
    await expect(deliverOperationalEmailJob(job, lane, dependencies)).rejects.toThrow('could not be verified')
    expect(dependencies.send).toHaveBeenCalledTimes(1)
  })

  it('reconciles a lost finalization response without resending or reporting a persistent failure', async () => {
    const dependencies = ledger()
    const original = dependencies.rpc.getMockImplementation()!
    let lost = false
    dependencies.rpc.mockImplementation(async (name, parameters) => {
      const result = await original(name, parameters)
      if (name === 'service_finalize_operational_email_job' && !lost) {
        lost = true
        throw new Error('Finalization response lost after commit')
      }
      return result
    })
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'delivered', acceptedCount: 1 })
    expect(dependencies.send).toHaveBeenCalledTimes(1)
    expect(dependencies.rpc.mock.calls.filter(([name]) => name === 'service_finalize_operational_email_job')).toHaveLength(2)
    expect(dependencies.rpc.mock.calls.some(([name]) => name.startsWith('service_mark_'))).toBe(false)
  })

  it('does not repeat a provider handoff when competing processing sees an in-flight claim', async () => {
    const dependencies = ledger()
    let release!: () => void
    dependencies.send.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const first = deliverOperationalEmailJob(job, lane, dependencies)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(await deliverOperationalEmailJob(job, lane, dependencies)).toMatchObject({ status: 'held', heldCount: 1 })
    release()
    await expect(first).rejects.toThrow('Held delivery requires reconciliation')
    expect(dependencies.send).toHaveBeenCalledTimes(1)
  })
})

import { z } from 'zod'
import { documentApiHeaders, parseApiError } from './hrDocuments'

const payFrequencySchema = z.enum(['hourly', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'annual'])

const payRateSchema = z.object({
  id: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  currencyCode: z.string(),
  payFrequency: payFrequencySchema,
  effectiveFrom: z.string(),
  effectiveThrough: z.string().nullable(),
})

const payRateProposalSchema = z.object({
  id: z.string().uuid(),
  amountCents: z.number().int().nonnegative(),
  currencyCode: z.string(),
  payFrequency: payFrequencySchema,
  effectiveFrom: z.string(),
  reason: z.string(),
  proposedBy: z.string(),
  proposedByCurrentActor: z.boolean(),
  proposedAt: z.string(),
})

const employeeCompensationSchema = z.object({
  employeeId: z.string().uuid(),
  employeeName: z.string(),
  employeeNumber: z.string().nullable(),
  canManage: z.boolean(),
  canApprove: z.boolean(),
  currentRate: payRateSchema.nullable(),
  pendingProposals: z.array(payRateProposalSchema).max(5),
  history: z.array(payRateSchema).max(10),
  requestId: z.string().optional(),
})

const payRateProposalResultSchema = z.object({
  proposalId: z.string().uuid(),
  status: z.literal('pending'),
  proposedAt: z.string(),
  requestId: z.string().optional(),
})

const payRateDecisionResultSchema = z.object({
  proposalId: z.string().uuid(),
  employeeId: z.string().uuid(),
  status: z.enum(['approved', 'rejected']),
  compensationRecordId: z.string().uuid().nullable(),
  decidedAt: z.string(),
  requestId: z.string().optional(),
})

export type HrEmployeeCompensation = z.infer<typeof employeeCompensationSchema>
export type HrPayFrequency = z.infer<typeof payFrequencySchema>

export type HrPayRateProposalInput = {
  employeeId: string
  amountCents: number
  payFrequency: HrPayFrequency
  effectiveFrom: string
  reason: string
}

export type HrPayRateDecisionInput = {
  proposalId: string
  decision: 'approved' | 'rejected'
  reason: string
}

async function compensationRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = await documentApiHeaders(init.body ? 'application/json' : undefined)
  return fetch(path, { ...init, cache: 'no-store', headers })
}

export async function getHrEmployeeCompensation(employeeId: string): Promise<HrEmployeeCompensation> {
  const response = await compensationRequest(`/api/v1/hr/compensation/employees/${employeeId}`)
  if (!response.ok) throw await parseApiError(response, 'Protected compensation could not be loaded.')
  return employeeCompensationSchema.parse(await response.json())
}

export async function proposeHrEmployeePayRate(input: HrPayRateProposalInput) {
  const response = await compensationRequest(`/api/v1/hr/compensation/employees/${input.employeeId}/pay-rate-proposals`, {
    body: JSON.stringify({
      amountCents: input.amountCents,
      effectiveFrom: input.effectiveFrom,
      payFrequency: input.payFrequency,
      reason: input.reason.trim(),
    }),
    method: 'POST',
  })
  if (!response.ok) throw await parseApiError(response, 'The pay-rate proposal could not be saved.')
  return payRateProposalResultSchema.parse(await response.json())
}

export async function reviewHrEmployeePayRate(input: HrPayRateDecisionInput) {
  const response = await compensationRequest(`/api/v1/hr/compensation/pay-rate-proposals/${input.proposalId}/decision`, {
    body: JSON.stringify({ decision: input.decision, reason: input.reason.trim() }),
    method: 'POST',
  })
  if (!response.ok) throw await parseApiError(response, 'The pay-rate decision could not be saved.')
  return payRateDecisionResultSchema.parse(await response.json())
}

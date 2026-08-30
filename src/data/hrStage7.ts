import { z } from 'zod'
import { documentApiHeaders, parseApiError } from './hrDocuments'

const pageSizeSchema = z.union([z.literal(5), z.literal(10), z.literal(20)])

const leaveWorkspaceSchema = z.object({
  enabled: z.boolean(),
  pageSize: pageSizeSchema,
  offset: z.number().int().nonnegative(),
  counts: z.object({ openCases: z.number().int().nonnegative(), approvedCases: z.number().int().nonnegative(), activePolicies: z.number().int().nonnegative() }),
  items: z.array(z.object({
    id: z.string().uuid(), employeeId: z.string().uuid(), employeeNumber: z.string(), employeeName: z.string(),
    caseType: z.string(), status: z.string(), startOn: z.string(), returnOn: z.string().nullable(), payTreatment: z.string(), requestId: z.string().uuid().nullable(),
  })).max(20),
  policies: z.array(z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), status: z.string(), effectiveFrom: z.string(), effectiveThrough: z.string().nullable() })),
  requestId: z.string().optional(),
})

const benefitsWorkspaceSchema = z.object({
  enabled: z.boolean(),
  pageSize: pageSizeSchema,
  offset: z.number().int().nonnegative(),
  counts: z.object({ activePlans: z.number().int().nonnegative(), openWindows: z.number().int().nonnegative(), pendingEnrollments: z.number().int().nonnegative() }),
  items: z.array(z.object({
    id: z.string().uuid(), code: z.string(), name: z.string(), planType: z.string(), carrierName: z.string().nullable(), status: z.string(),
  })).max(20),
  windows: z.array(z.object({ id: z.string().uuid(), name: z.string(), windowType: z.string(), opensAt: z.string(), closesAt: z.string(), status: z.string() })),
  requestId: z.string().optional(),
})

const compensationWorkspaceSchema = z.object({
  enabled: z.boolean(),
  pageSize: pageSizeSchema,
  offset: z.number().int().nonnegative(),
  counts: z.object({ activeComponents: z.number().int().nonnegative(), pendingProposals: z.number().int().nonnegative(), activeRecords: z.number().int().nonnegative() }),
  items: z.array(z.object({
    id: z.string().uuid(), employeeId: z.string().uuid(), employeeNumber: z.string(), employeeName: z.string(), componentName: z.string(),
    amountCents: z.number().int(), currencyCode: z.string(), payFrequency: z.string(), effectiveFrom: z.string(), status: z.string(), proposedAt: z.string(),
  })).max(20),
  components: z.array(z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), componentType: z.string(), status: z.string() })),
  requestId: z.string().optional(),
})

export type HrLeaveWorkspace = z.infer<typeof leaveWorkspaceSchema>
export type HrBenefitsWorkspace = z.infer<typeof benefitsWorkspaceSchema>
export type HrCompensationWorkspace = z.infer<typeof compensationWorkspaceSchema>

async function workspaceRequest(path: string): Promise<Response> {
  return fetch(path, { cache: 'no-store', headers: await documentApiHeaders() })
}

function parameters(pageSize: 5 | 10 | 20, offset: number): string {
  return new URLSearchParams({ pageSize: String(pageSize), offset: String(Math.max(0, offset)) }).toString()
}

export async function getHrLeaveWorkspace(pageSize: 5 | 10 | 20 = 10, offset = 0): Promise<HrLeaveWorkspace> {
  const response = await workspaceRequest(`/api/v1/hr/leave/workspace?${parameters(pageSize, offset)}`)
  if (!response.ok) throw await parseApiError(response, 'Leave Administration could not be loaded.')
  return leaveWorkspaceSchema.parse(await response.json())
}

export async function getHrBenefitsWorkspace(pageSize: 5 | 10 | 20 = 10, offset = 0): Promise<HrBenefitsWorkspace> {
  const response = await workspaceRequest(`/api/v1/hr/benefits/workspace?${parameters(pageSize, offset)}`)
  if (!response.ok) throw await parseApiError(response, 'Benefits could not be loaded.')
  return benefitsWorkspaceSchema.parse(await response.json())
}

export async function getHrCompensationWorkspace(pageSize: 5 | 10 | 20 = 10, offset = 0): Promise<HrCompensationWorkspace> {
  const response = await workspaceRequest(`/api/v1/hr/compensation/workspace?${parameters(pageSize, offset)}`)
  if (!response.ok) throw await parseApiError(response, 'Compensation could not be loaded.')
  return compensationWorkspaceSchema.parse(await response.json())
}

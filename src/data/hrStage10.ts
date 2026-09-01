import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const pageSizeSchema = z.union([z.literal(5), z.literal(10), z.literal(20)])
const gateSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().nullable(),
})

const hrStage10WorkspaceSchema = z.object({
  enabled: z.boolean(),
  authority: z.string(),
  contract: z.object({
    version: z.string(),
    status: z.string(),
    digest: z.string().nullable(),
    effectiveOn: z.string().nullable(),
    approvedAt: z.string().nullable(),
  }).nullable(),
  gates: z.object({
    integration: gateSchema,
    webhooks: gateSchema,
    cutover: gateSchema,
  }),
  counts: z.object({
    pendingProposals: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    reconciliationRuns: z.number().int().nonnegative(),
    differences: z.number().int().nonnegative(),
  }),
  items: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    subtitle: z.string(),
    status: z.string(),
    dateLabel: z.string().nullable(),
    detail: z.string().nullable(),
  })).max(20),
  pageSize: pageSizeSchema,
  offset: z.number().int().nonnegative(),
  requestId: z.string().optional(),
})

export type HrStage10Workspace = z.infer<typeof hrStage10WorkspaceSchema>
export type HrStage10PageSize = 5 | 10 | 20

export async function getHrStage10Workspace(
  pageSize: HrStage10PageSize = 10,
  offset = 0,
): Promise<HrStage10Workspace> {
  const parameters = new URLSearchParams({
    pageSize: String(pageSize),
    offset: String(Math.max(0, offset)),
  })
  const response = await documentApiRequest(`/api/v1/hr/payroll-integration/workspace?${parameters}`)
  if (!response.ok) throw await parseApiError(response, 'Payroll integration controls could not be loaded.')
  return hrStage10WorkspaceSchema.parse(await response.json())
}

import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

export const hrStage9ModuleSchema = z.enum(['offboarding', 'self_service', 'reporting'])
const pageSizeSchema = z.union([z.literal(5), z.literal(10), z.literal(20)])

const hrStage9WorkspaceSchema = z.object({
  enabled: z.boolean(),
  module: hrStage9ModuleSchema,
  pageSize: pageSizeSchema,
  offset: z.number().int().nonnegative(),
  counts: z.object({
    primary: z.number().int().nonnegative(),
    secondary: z.number().int().nonnegative(),
    tertiary: z.number().int().nonnegative(),
  }),
  items: z.array(z.object({
    id: z.string().uuid(),
    title: z.string(),
    subtitle: z.string(),
    status: z.string(),
    dateLabel: z.string().nullable(),
    detail: z.string().nullable(),
  })).max(20),
  requestId: z.string().optional(),
})

export type HrStage9Module = z.infer<typeof hrStage9ModuleSchema>
export type HrStage9Workspace = z.infer<typeof hrStage9WorkspaceSchema>
export type HrStage9PageSize = 5 | 10 | 20

const modulePaths: Record<HrStage9Module, string> = {
  offboarding: 'offboarding',
  self_service: 'self-service',
  reporting: 'reporting',
}

export async function getHrStage9Workspace(
  module: HrStage9Module,
  pageSize: HrStage9PageSize = 10,
  offset = 0,
): Promise<HrStage9Workspace> {
  const parameters = new URLSearchParams({
    pageSize: String(pageSize),
    offset: String(Math.max(0, offset)),
  })
  const response = await documentApiRequest(`/api/v1/hr/${modulePaths[module]}/workspace?${parameters}`)
  if (!response.ok) throw await parseApiError(response, `${module.replace('_', ' ')} workspace could not be loaded.`)
  return hrStage9WorkspaceSchema.parse(await response.json())
}

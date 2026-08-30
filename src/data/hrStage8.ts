import { z } from 'zod'
import { documentApiHeaders, parseApiError } from './hrDocuments'

export const hrStage8ModuleSchema = z.enum(['talent', 'learning', 'cases', 'safety', 'assets'])
const pageSizeSchema = z.union([z.literal(5), z.literal(10), z.literal(20)])

const hrStage8WorkspaceSchema = z.object({
  enabled: z.boolean(),
  module: hrStage8ModuleSchema,
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

export type HrStage8Module = z.infer<typeof hrStage8ModuleSchema>
export type HrStage8Workspace = z.infer<typeof hrStage8WorkspaceSchema>
export type HrStage8PageSize = 5 | 10 | 20

export async function getHrStage8Workspace(
  module: HrStage8Module,
  pageSize: HrStage8PageSize = 10,
  offset = 0,
): Promise<HrStage8Workspace> {
  const parameters = new URLSearchParams({
    pageSize: String(pageSize),
    offset: String(Math.max(0, offset)),
  })
  const response = await fetch(`/api/v1/hr/${module}/workspace?${parameters}`, {
    cache: 'no-store',
    headers: await documentApiHeaders(),
  })
  if (!response.ok) throw await parseApiError(response, `${module} workspace could not be loaded.`)
  return hrStage8WorkspaceSchema.parse(await response.json())
}

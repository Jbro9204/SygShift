import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

export const hrOperationalModuleSchema = z.enum([
  'leave', 'benefits', 'talent', 'learning', 'cases', 'safety', 'assets', 'offboarding', 'self_service', 'reporting',
])

const resultSchema = z.object({
  id: z.string().uuid(),
  module: hrOperationalModuleSchema,
  action: z.string(),
  status: z.literal('completed'),
  requestId: z.string().optional(),
})

const optionsSchema = z.object({
  employees: z.array(z.object({ id: z.string().uuid(), name: z.string(), employeeNumber: z.string().nullable() })),
  references: z.array(z.object({ id: z.string().uuid(), label: z.string(), detail: z.string().nullable() })),
  requestId: z.string().optional(),
})

export type HrOperationalModule = z.infer<typeof hrOperationalModuleSchema>

export async function getHrOperationalOptions(module: HrOperationalModule) {
  const response = await documentApiRequest(`/api/v1/hr/operations/options?module=${encodeURIComponent(module)}`)
  if (!response.ok) throw await parseApiError(response, 'HR action options could not be loaded.')
  return optionsSchema.parse(await response.json())
}

export async function runHrOperationalAction(input: {
  module: HrOperationalModule
  action: string
  payload: Record<string, unknown>
  reason: string
}) {
  const response = await documentApiRequest('/api/v1/hr/operations/actions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!response.ok) throw await parseApiError(response, 'The HR action could not be completed.')
  return resultSchema.parse(await response.json())
}

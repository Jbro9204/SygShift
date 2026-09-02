import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const audienceSchema = z.enum(['all_employees', 'supervisors_and_hr', 'hr_only'])
const sensitivitySchema = z.enum(['standard', 'restricted', 'highly_restricted'])

const libraryItemSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  title: z.string(),
  category: z.string(),
  recordClass: z.string(),
  purpose: z.string(),
  audience: audienceSchema,
  sensitivity: sensitivitySchema,
  sourceFilename: z.string(),
  sourceDocumentId: z.string().uuid().nullable(),
  availability: z.enum(['cataloged', 'available']),
})

const libraryWorkspaceSchema = z.object({
  releaseState: z.literal('released'),
  libraryVersion: z.string(),
  permissions: z.object({
    canSeeSupervisor: z.boolean(),
    canSeeHr: z.boolean(),
  }),
  summary: z.object({
    visibleCount: z.number().int().nonnegative(),
    matchingCount: z.number().int().nonnegative(),
    availableCount: z.number().int().nonnegative(),
    categoryCount: z.number().int().nonnegative(),
  }),
  categories: z.array(z.object({
    name: z.string(),
    count: z.number().int().nonnegative(),
  })),
  items: z.array(libraryItemSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
  requestId: z.string().optional(),
})

export type HrDocumentLibraryItem = z.infer<typeof libraryItemSchema>
export type HrDocumentLibraryWorkspace = z.infer<typeof libraryWorkspaceSchema>
export type HrDocumentLibraryAudience = z.infer<typeof audienceSchema>

export interface HrDocumentLibraryFilters {
  audience?: HrDocumentLibraryAudience
  category?: string
  page?: number
  pageSize?: 5 | 10 | 20
  search?: string
}

export async function getHrDocumentLibrary(
  filters: HrDocumentLibraryFilters = {},
): Promise<HrDocumentLibraryWorkspace> {
  const query = new URLSearchParams()
  if (filters.audience) query.set('audience', filters.audience)
  if (filters.category) query.set('category', filters.category)
  if (filters.page) query.set('page', String(filters.page))
  if (filters.pageSize) query.set('pageSize', String(filters.pageSize))
  if (filters.search?.trim()) query.set('search', filters.search.trim())
  const response = await documentApiRequest(`/api/v1/hr/documents/library?${query.toString()}`)
  if (!response.ok) throw await parseApiError(response, 'The document library could not be loaded.')
  return libraryWorkspaceSchema.parse(await response.json())
}

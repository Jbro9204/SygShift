import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const audienceSchema = z.enum(['all_employees', 'supervisors_and_hr', 'hr_only'])
const sensitivitySchema = z.enum(['standard', 'restricted', 'highly_restricted'])
const documentKindSchema = z.enum(['hr_source', 'training_admin', 'training_module', 'document_guide', 'training_form'])

export const libraryItemSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  title: z.string(),
  category: z.string(),
  section: z.string(),
  recordClass: z.string(),
  purpose: z.string(),
  audience: audienceSchema,
  sensitivity: sensitivitySchema,
  sourceFilename: z.string(),
  // Older Workers omit the reviewed subtype during the additive v2 rollout.
  // Presentation code treats an omitted or unclassified value as preview-only.
  sourceType: z.enum(['controlled_form', 'reference_material', 'training_form', 'training_reference', 'unclassified']).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  updatedAt: z.string().datetime().optional(),
  sourceDocumentId: z.string().uuid().nullable(),
  availability: z.enum(['cataloged', 'available']),
  documentKind: documentKindSchema,
  lifecycleStatus: z.enum(['draft_for_adoption', 'adopted', 'retired']),
  guideCode: z.string().nullable(),
  relatedModules: z.array(z.string()),
  pageCount: z.number().int().positive().nullable(),
})

const libraryWorkspaceSchema = z.object({
  releaseState: z.literal('released'),
  libraryVersion: z.string(),
  permissions: z.object({
    canSeeSupervisor: z.boolean(),
    canSeeHr: z.boolean(),
    canManage: z.boolean().optional(),
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
export type HrDocumentLibraryKind = z.infer<typeof documentKindSchema>

export interface HrDocumentLibraryFilters {
  audience?: HrDocumentLibraryAudience
  category?: string
  kind?: HrDocumentLibraryKind
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
  if (filters.kind) query.set('kind', filters.kind)
  if (filters.page) query.set('page', String(filters.page))
  if (filters.pageSize) query.set('pageSize', String(filters.pageSize))
  if (filters.search?.trim()) query.set('search', filters.search.trim())
  const response = await documentApiRequest(`/api/v1/hr/documents/library?${query.toString()}`)
  if (!response.ok) throw await parseApiError(response, 'The document library could not be loaded.')
  return libraryWorkspaceSchema.parse(await response.json())
}

export async function adoptHrDocumentLibrarySource(input: { libraryItemId: string; reason: string; sourceSha256: string; updatedAt: string }): Promise<void> {
  const { libraryItemId, reason, sourceSha256, updatedAt } = input
  const response = await documentApiRequest(`/api/v1/hr/documents/library/${libraryItemId}/adopt`, {
    body: JSON.stringify({ reason, sourceSha256, updatedAt }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw await parseApiError(response, 'The source could not be adopted.')
}

export async function retireHrDocumentLibrarySource(input: { libraryItemId: string; reason: string; sourceSha256: string; updatedAt: string }): Promise<void> {
  const { libraryItemId, reason, sourceSha256, updatedAt } = input
  const response = await documentApiRequest(`/api/v1/hr/documents/library/${libraryItemId}/retire`, {
    body: JSON.stringify({ reason, sourceSha256, updatedAt }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw await parseApiError(response, 'The source could not be retired.')
}

import { z } from 'zod'
import { documentApiRequest, parseApiError, uploadHrDocument } from './hrDocuments'

export const hrSystemKindSchema = z.enum(['hr_source', 'training_admin', 'training_module', 'document_guide', 'training_form'])
const itemSchema = z.object({
  kind: hrSystemKindSchema,
  code: z.string().min(2).max(80),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(160),
  section: z.string().min(1).max(240),
  recordClass: z.string().min(1).max(300),
  purpose: z.string().min(1).max(4000),
  audience: z.literal('hr_only'),
  sensitivity: z.enum(['confidential', 'restricted', 'highly_restricted']),
  vaultCode: z.enum(['hr-general', 'hr-financial', 'hr-identity', 'hr-medical', 'hr-disciplinary', 'hr-legal-safety']),
  status: z.literal('draft_for_adoption'),
  sourceRelativePath: z.string(),
  pdfRelativePath: z.string(),
  relatedModules: z.array(z.string()).default([]),
  guideCode: z.string().nullable().optional(),
  pageCount: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  searchText: z.string(),
})

const catalogSchema = z.object({
  package: z.literal('Guardianship Security HR System v2.1 with Training'),
  libraryVersion: z.literal('2.1'),
  status: z.literal('draft_for_company_adoption'),
  canonicalPdfCount: z.literal(537),
  excluded: z.array(z.object({ path: z.string(), reason: z.string() })),
  items: z.array(itemSchema).length(537),
})

export type HrSystemCatalog = z.infer<typeof catalogSchema>
export type HrSystemCatalogItem = z.infer<typeof itemSchema>

export function parseHrSystemCatalog(value: unknown): HrSystemCatalog {
  const parsed = catalogSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const first = parsed.error.issues[0]
  const location = first?.path.length ? ` at ${first.path.join('.')}` : ''
  throw new Error(`The rollout catalog is not compatible${location}. Rebuild the validated package before importing.`)
}

export function normalizedPackagePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^pdf\//, '').toLowerCase()
}

function deterministicUploadId(sha256: string): string {
  const value = sha256.slice(0, 32).split('')
  value[12] = '4'
  value[16] = ['8', '9', 'a', 'b'][Number.parseInt(value[16], 16) % 4]
  const joined = value.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

export async function importHrSystemItem(
  item: HrSystemCatalogItem,
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ documentId: string }> {
  const upload = await uploadHrDocument({
    accessClassification: item.sensitivity,
    category: item.category.slice(0, 100),
    description: `${item.code} · ${item.purpose}`.slice(0, 2000),
    employeeId: null,
    file,
    idempotencyKey: deterministicUploadId(item.sha256),
    title: item.title.slice(0, 180),
    vaultCode: item.vaultCode,
  }, onProgress)
  const response = await documentApiRequest('/api/v1/hr/documents/library/registration', {
    body: JSON.stringify({
      category: item.category,
      code: item.code,
      documentId: upload.documentId,
      documentKind: item.kind,
      fullText: item.searchText.slice(0, 700_000),
      guideCode: item.guideCode ?? null,
      lifecycleStatus: item.status,
      packageMetadata: {
        libraryVersion: '2.1',
        pdfRelativePath: item.pdfRelativePath,
        sizeBytes: item.sizeBytes,
        sourceRelativePath: item.sourceRelativePath,
      },
      pageCount: item.pageCount,
      purpose: item.purpose,
      recordClass: item.recordClass,
      relatedModules: item.relatedModules,
      section: item.section,
      sensitivity: item.sensitivity === 'confidential' ? 'standard' : item.sensitivity,
      sourceFilename: item.pdfRelativePath.split('/').at(-1) ?? `${item.code}.pdf`,
      sourceSha256: item.sha256,
      title: item.title,
    }),
    method: 'POST',
  })
  if (!response.ok) throw await parseApiError(response, `The protected record for ${item.code} could not be registered.`)
  return { documentId: upload.documentId }
}

export async function getAssignedTrainingDocument(documentId: string, action: 'preview' | 'download' = 'preview') {
  const response = await documentApiRequest(`/api/v1/training/documents/${documentId}?action=${action}`)
  if (!response.ok) throw await parseApiError(response, 'The assigned training document could not be opened.')
  return response.blob()
}

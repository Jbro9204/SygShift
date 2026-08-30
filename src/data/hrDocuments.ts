import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

const nullableText = z.string().nullable()

const vaultSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  classification: z.enum(['confidential', 'restricted', 'highly_restricted']),
  canView: z.boolean(),
  canManage: z.boolean(),
  maximumFileSizeBytes: z.number().nonnegative(),
  allowedMimeTypes: z.array(z.string()),
})

const employeeSchema = z.object({
  id: z.string().uuid(),
  employeeNumber: nullableText,
  legalName: z.string(),
  status: z.string(),
})

const versionSchema = z.object({
  id: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  filename: z.string(),
  mimeType: nullableText,
  sizeBytes: z.number().nonnegative(),
  uploadedAt: z.string(),
  scanState: z.enum(['quarantined', 'scan_pending', 'clean', 'rejected', 'scan_error']),
})

const documentSchema = z.object({
  id: z.string().uuid(),
  employeeId: z.string().uuid().nullable(),
  employeeNumber: nullableText,
  employeeLegalName: nullableText,
  vaultCode: z.string(),
  title: z.string(),
  category: z.string(),
  description: nullableText,
  accessClassification: z.enum(['confidential', 'restricted', 'highly_restricted']),
  effectiveDate: nullableText,
  expirationDate: nullableText,
  archivedAt: nullableText,
  canManage: z.boolean(),
  canPreview: z.boolean(),
  canDownload: z.boolean(),
  version: versionSchema.nullable(),
})

const workspaceSchema = z.object({
  releaseState: z.literal('released'),
  actor: z.object({ canManageAny: z.boolean() }),
  vaults: z.array(vaultSchema),
  employees: z.array(employeeSchema),
  documents: z.array(documentSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]),
    totalCount: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
  requestId: z.string().optional(),
})

const uploadResultSchema = z.object({
  documentId: z.string().uuid(),
  operationId: z.string().uuid(),
  requestId: z.string(),
  scanState: z.string(),
  versionId: z.string().uuid(),
})

const accessGrantSchema = z.object({
  accessPath: z.string().startsWith('/api/v1/hr/documents/access/'),
  expiresAt: z.string(),
  requestId: z.string(),
})

export type HrDocumentWorkspace = z.infer<typeof workspaceSchema>
export type HrDocumentRecord = z.infer<typeof documentSchema>
export type HrDocumentVault = z.infer<typeof vaultSchema>
export type HrDocumentEmployee = z.infer<typeof employeeSchema>

export interface HrDocumentWorkspaceFilters {
  employeeId?: string
  includeArchived?: boolean
  page?: number
  pageSize?: 5 | 10 | 20
  search?: string
  vaultCode?: string
}

export interface HrDocumentUploadInput {
  accessClassification: 'confidential' | 'restricted' | 'highly_restricted'
  category: string
  description: string
  documentId?: string | null
  employeeId: string
  file: File
  idempotencyKey: string
  replacementReason?: string | null
  title: string
  vaultCode: string
}

export async function documentApiHeaders(contentType?: string): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure session is not available.')
  const headers = new Headers({ authorization: `Bearer ${data.session.access_token}` })
  if (contentType) headers.set('content-type', contentType)
  return appendProtectedSessionHeaders(headers)
}

export async function parseApiError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null
  return new Error(typeof payload?.detail === 'string' ? payload.detail : fallback)
}

export async function getHrDocumentWorkspace(filters: HrDocumentWorkspaceFilters = {}): Promise<HrDocumentWorkspace> {
  const query = new URLSearchParams()
  if (filters.employeeId) query.set('employeeId', filters.employeeId)
  if (filters.includeArchived) query.set('includeArchived', 'true')
  if (filters.page) query.set('page', String(filters.page))
  if (filters.pageSize) query.set('pageSize', String(filters.pageSize))
  if (filters.search?.trim()) query.set('search', filters.search.trim())
  if (filters.vaultCode) query.set('vaultCode', filters.vaultCode)
  const response = await fetch(`/api/v1/hr/documents/workspace?${query.toString()}`, {
    cache: 'no-store',
    headers: await documentApiHeaders(),
  })
  if (!response.ok) throw await parseApiError(response, 'The protected document workspace could not be loaded.')
  return workspaceSchema.parse(await response.json())
}

function encodeMetadata(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function uploadHrDocument(
  input: HrDocumentUploadInput,
  onProgress: (percent: number) => void,
): Promise<z.infer<typeof uploadResultSchema>> {
  const headers = await documentApiHeaders(input.file.type)
  headers.set('x-sygshift-document-metadata', encodeMetadata({
    accessClassification: input.accessClassification,
    category: input.category.trim(),
    declaredMimeType: input.file.type,
    description: input.description.trim(),
    documentId: input.documentId ?? null,
    employeeId: input.employeeId,
    idempotencyKey: input.idempotencyKey,
    originalFilename: input.file.name,
    replacementReason: input.replacementReason?.trim() || null,
    title: input.title.trim(),
    vaultCode: input.vaultCode,
  }))

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', '/api/v1/hr/documents/uploads')
    headers.forEach((value, key) => request.setRequestHeader(key, value))
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    })
    request.addEventListener('load', () => {
      let payload: unknown = null
      try { payload = request.responseText ? JSON.parse(request.responseText) : null } catch { /* handled below */ }
      if (request.status >= 200 && request.status < 300) {
        onProgress(100)
        try { resolve(uploadResultSchema.parse(payload)) } catch { reject(new Error('The upload completed but its confirmation was invalid.')) }
        return
      }
      const detail = payload && typeof payload === 'object' && 'detail' in payload
        ? (payload as { detail?: unknown }).detail
        : null
      reject(new Error(typeof detail === 'string' ? detail : 'The protected document could not be uploaded.'))
    })
    request.addEventListener('error', () => reject(new Error('The upload connection was interrupted. You can retry safely.')))
    request.addEventListener('abort', () => reject(new Error('The upload was canceled. No document was released.')))
    request.send(input.file)
  })
}

export async function getHrDocumentBlob(
  documentId: string,
  action: 'preview' | 'download',
  reason: string,
): Promise<{ blob: Blob; filename: string }> {
  const grantResponse = await fetch(`/api/v1/hr/documents/${documentId}/access`, {
    body: JSON.stringify({ action, reason: reason.trim() }),
    headers: await documentApiHeaders('application/json'),
    method: 'POST',
  })
  if (!grantResponse.ok) throw await parseApiError(grantResponse, 'Protected document access could not be granted.')
  const grant = accessGrantSchema.parse(await grantResponse.json())
  const response = await fetch(grant.accessPath, {
    cache: 'no-store',
    headers: await documentApiHeaders(),
  })
  if (!response.ok) throw await parseApiError(response, 'The protected document could not be loaded.')
  const disposition = response.headers.get('content-disposition') ?? ''
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  return {
    blob: await response.blob(),
    filename: encodedFilename ? decodeURIComponent(encodedFilename) : 'SygShift-document',
  }
}

import { z } from 'zod'
import { documentApiRequest, parseApiError } from './hrDocuments'

const nullableText = z.string().nullable()

const studioTemplateSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  category: z.string(),
  status: z.string(),
  currentVersionId: z.string().uuid().nullable(),
  updatedAt: z.string(),
  versionNumber: z.number().int().positive().nullable(),
  fieldCount: z.number().int().nonnegative(),
  sourceDocumentTitle: nullableText,
  policyName: nullableText,
})

const envelopeSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  routingMode: z.enum(['sequential', 'parallel']),
  createdAt: z.string(),
  sentAt: nullableText,
  completedAt: nullableText,
  expiresAt: nullableText,
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  policyName: z.string(),
  recipientCount: z.number().int().nonnegative(),
  completedRecipientCount: z.number().int().nonnegative(),
})

const policySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  versionNumber: z.number().int().positive(),
  name: z.string(),
  category: z.string(),
  jurisdiction: z.string(),
  executionMethod: z.string(),
  authenticationTier: z.string(),
  routingMode: z.string(),
  regulated: z.boolean(),
  active: z.boolean(),
  publishedAt: nullableText,
})

const processingSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  jobType: z.string(),
  status: z.string(),
  attemptCount: z.number().int().nonnegative(),
  availableAt: z.string(),
  completedAt: nullableText,
  failedAt: nullableText,
  lastErrorCode: nullableText,
})

const documentStudioSchema = z.object({
  releaseState: z.object({
    documentPipeline: z.boolean(),
    workspace: z.boolean(),
    processing: z.boolean(),
    signatures: z.boolean(),
    advancedEditing: z.boolean(),
    regulatedDocuments: z.boolean(),
    externalSigners: z.boolean(),
    organizationalSeal: z.boolean(),
  }),
  permissions: z.object({
    canUpload: z.boolean(),
    canCreate: z.boolean(),
    canManageTemplates: z.boolean(),
    canRequestSignatures: z.boolean(),
    canManageSignatures: z.boolean(),
    canViewAudit: z.boolean(),
    canManagePolicies: z.boolean(),
    canManageRetention: z.boolean(),
    canManageLegalHold: z.boolean(),
  }),
  summary: z.object({
    documents: z.number().int().nonnegative(),
    templates: z.number().int().nonnegative(),
    awaitingAction: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    exceptions: z.number().int().nonnegative(),
    legalHolds: z.number().int().nonnegative(),
  }),
  templates: z.array(studioTemplateSchema),
  envelopes: z.array(envelopeSchema),
  policies: z.array(policySchema),
  processing: z.array(processingSchema),
  pagination: z.object({ pageSize: z.number().int(), offset: z.number().int() }),
  requestId: z.string().optional(),
})

const signatureFieldSchema = z.object({
  id: z.string().uuid(),
  fieldKey: z.string(),
  fieldType: z.string(),
  label: z.string(),
  description: nullableText,
  pageNumber: z.number().int().positive(),
  xRatio: z.coerce.number(),
  yRatio: z.coerce.number(),
  widthRatio: z.coerce.number(),
  heightRatio: z.coerce.number(),
  tabOrder: z.number().int().positive(),
  required: z.boolean(),
  readOnly: z.boolean(),
  semanticMapping: nullableText,
  authoritative: z.boolean(),
  sensitive: z.boolean(),
  validationRules: z.record(z.string(), z.unknown()),
  options: z.array(z.unknown()),
})

const signatureRecipientSchema = z.object({
  id: z.string().uuid(),
  envelopeId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  documentTitle: z.string(),
  envelopeTitle: z.string(),
  status: z.string(),
  envelopeStatus: z.string(),
  recipientRole: z.string(),
  requiredAction: z.string(),
  routingOrder: z.number().int(),
  authenticationTier: z.string(),
  expiresAt: nullableText,
  sentAt: nullableText,
  completedAt: nullableText,
  sourceChecksum: z.string(),
  versionNumber: z.number().int().positive(),
  consentText: z.string(),
  consentVersion: z.string(),
  allowsDecline: z.boolean(),
  allowsCorrectionRequest: z.boolean(),
  remainingRecipients: z.number().int().nonnegative(),
  canAct: z.boolean(),
  fields: z.array(signatureFieldSchema),
})

const mySignatureWorkspaceSchema = z.object({
  releaseState: z.enum(['released', 'unavailable']),
  adoption: z.object({ id: z.string().uuid(), method: z.string(), styleCode: nullableText, displayName: z.string(), createdAt: z.string() }).nullable(),
  recipients: z.array(signatureRecipientSchema),
  requestId: z.string().optional(),
})

const accessGrantSchema = z.object({ accessPath: z.string(), expiresAt: z.string(), requestId: z.string() })

export type DocumentStudioWorkspace = z.infer<typeof documentStudioSchema>
export type DocumentStudioTemplate = z.infer<typeof studioTemplateSchema>
export type DocumentStudioEnvelope = z.infer<typeof envelopeSchema>
export type DocumentStudioPolicy = z.infer<typeof policySchema>
export type SignatureRecipient = z.infer<typeof signatureRecipientSchema>
export type MySignatureWorkspace = z.infer<typeof mySignatureWorkspaceSchema>

async function jsonMutation(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await documentApiRequest(path, { body: JSON.stringify(body), method: 'POST' })
  if (!response.ok) throw await parseApiError(response, 'The Document Studio action could not be completed.')
  return response.json() as Promise<Record<string, unknown>>
}

export async function getDocumentStudioWorkspace(filters: { search?: string, status?: string, pageSize?: 5 | 10 | 20, offset?: number } = {}): Promise<DocumentStudioWorkspace> {
  const query = new URLSearchParams()
  if (filters.search?.trim()) query.set('search', filters.search.trim())
  if (filters.status?.trim()) query.set('status', filters.status.trim())
  if (filters.pageSize) query.set('pageSize', String(filters.pageSize))
  if (filters.offset) query.set('offset', String(filters.offset))
  const response = await documentApiRequest(`/api/v1/hr/documents/studio?${query}`)
  if (!response.ok) throw await parseApiError(response, 'Document Studio could not be loaded.')
  return documentStudioSchema.parse(await response.json())
}

export async function getMySignatureWorkspace(): Promise<MySignatureWorkspace> {
  const response = await documentApiRequest('/api/v1/hr/documents/signatures/mine')
  if (!response.ok) throw await parseApiError(response, 'Your signature actions could not be loaded.')
  return mySignatureWorkspaceSchema.parse(await response.json())
}

export async function getMyDocumentActionCount(): Promise<{ pendingCount: number, available: boolean }> {
  const response = await documentApiRequest('/api/v1/hr/documents/signatures/count')
  if (!response.ok) throw await parseApiError(response, 'Document actions could not be checked.')
  return z.object({ pendingCount: z.number().int().nonnegative(), available: z.boolean() }).parse(await response.json())
}

export async function getSavedSignatureAppearance(): Promise<Blob> {
  const response = await documentApiRequest('/api/v1/hr/documents/signatures/adoption', { body: '{}', method: 'POST' })
  if (!response.ok) throw await parseApiError(response, 'Your saved signature appearance could not be loaded.')
  return response.blob()
}

export const createDocumentPolicy = (body: Record<string, unknown>) => jsonMutation('/api/v1/hr/documents/studio/policies', body)
export const createDocumentTemplate = (body: Record<string, unknown>) => jsonMutation('/api/v1/hr/documents/studio/templates', body)
export const addDocumentTemplateField = (versionId: string, body: Record<string, unknown>) => jsonMutation(`/api/v1/hr/documents/studio/templates/${versionId}/fields`, body)
export const publishDocumentTemplate = (templateId: string) => jsonMutation(`/api/v1/hr/documents/studio/templates/${templateId}/publish`, {})
export const createSignatureEnvelope = (body: Record<string, unknown>) => jsonMutation('/api/v1/hr/documents/studio/envelopes', body)
export const sendSignatureEnvelope = (envelopeId: string) => jsonMutation(`/api/v1/hr/documents/studio/envelopes/${envelopeId}/send`, {})
export const voidSignatureEnvelope = (envelopeId: string, reason: string) => jsonMutation(`/api/v1/hr/documents/studio/envelopes/${envelopeId}/void`, { reason })
export const linkDocumentRecord = (documentId: string, body: Record<string, unknown>) => jsonMutation(`/api/v1/hr/documents/studio/documents/${documentId}/links`, body)

export async function getSignatureDocumentBlob(recipientId: string, action: 'preview' | 'download', reason: string): Promise<{ blob: Blob, filename: string }> {
  const grantResponse = await documentApiRequest(`/api/v1/hr/documents/signatures/${recipientId}/access`, { body: JSON.stringify({ action, reason }), method: 'POST' })
  if (!grantResponse.ok) throw await parseApiError(grantResponse, 'Protected signature document access could not be granted.')
  const grant = accessGrantSchema.parse(await grantResponse.json())
  const response = await documentApiRequest(grant.accessPath)
  if (!response.ok) throw await parseApiError(response, 'The protected signature document could not be loaded.')
  const disposition = response.headers.get('content-disposition') ?? ''
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  return { blob: await response.blob(), filename: encodedFilename ? decodeURIComponent(encodedFilename) : 'SygShift-document.pdf' }
}

export const completeSignatureAction = (recipientId: string, body: Record<string, unknown>) => jsonMutation(`/api/v1/hr/documents/signatures/${recipientId}/actions`, body)

export async function downloadSignatureCertificate(envelopeId: string, reason: string): Promise<Blob> {
  const response = await documentApiRequest(`/api/v1/hr/documents/signatures/${envelopeId}/certificate`, { body: JSON.stringify({ reason }), method: 'POST' })
  if (!response.ok) throw await parseApiError(response, 'The signature audit certificate could not be downloaded.')
  return response.blob()
}

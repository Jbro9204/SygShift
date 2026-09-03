import { z } from 'zod'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'
import { getSupabaseClient } from '../lib/supabase'

const clientStatusSchema = z.enum(['prospect', 'onboarding', 'active', 'paused', 'former', 'do_not_renew', 'archived'])
const actorSchema = z.object({
  canManage: z.boolean(), canManageDocuments: z.boolean(), canViewContracts: z.boolean(),
  canViewActivity: z.boolean(), canManageActivity: z.boolean(), canExport: z.boolean(),
  canManageImports: z.boolean().optional().default(false), canPublishPortal: z.boolean().optional().default(false),
  canViewDocuments: z.boolean().optional().default(false),
})
const clientSummarySchema = z.object({
  id: z.string().uuid(), clientNumber: z.string(), legalName: z.string(), displayName: z.string(), dbaName: z.string().nullable(),
  status: clientStatusSchema, city: z.string().nullable(), region: z.string().nullable(), timeZone: z.string(), renewalOn: z.string().nullable(),
  siteCount: z.number().int().nonnegative(), contactCount: z.number().int().nonnegative(), documentCount: z.number().int().nonnegative(),
})
const paginationSchema = z.object({ page: z.number().int().positive(), pageSize: z.union([z.literal(5), z.literal(10), z.literal(20)]), totalCount: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative().optional() })
const workspaceSchema = z.object({
  actor: actorSchema, clients: z.array(clientSummarySchema), importQueueCount: z.number().int().nonnegative(),
  metrics: z.object({ active: z.number().int(), prospects: z.number().int(), renewalsDue: z.number().int(), needsAttention: z.number().int() }),
  pagination: paginationSchema,
})
const clientSchema = z.object({
  id: z.string().uuid(), clientNumber: z.string(), legalName: z.string(), displayName: z.string(), dbaName: z.string().nullable(), status: clientStatusSchema,
  serviceTier: z.string().nullable(), industry: z.string().nullable(), accountOwnerEmployeeId: z.string().uuid().nullable(), billingEmail: z.string().nullable(), billingPhone: z.string().nullable(), website: z.string().nullable(),
  addressLine1: z.string().nullable(), addressLine2: z.string().nullable(), city: z.string().nullable(), region: z.string().nullable(), postalCode: z.string().nullable(), timeZone: z.string(),
  serviceStartedOn: z.string().nullable(), serviceEndedOn: z.string().nullable(), renewalOn: z.string().nullable(), internalNotes: z.string().nullable(),
})
const contactSchema = z.object({ id: z.string().uuid(), firstName: z.string(), lastName: z.string(), title: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), contactType: z.enum(['executive', 'operations', 'billing', 'emergency', 'legal', 'other']), primaryContact: z.boolean(), emergencyContact: z.boolean(), notes: z.string().nullable(), active: z.boolean() })
const postSchema = z.object({ id: z.string().uuid(), name: z.string(), requiresArmed: z.boolean(), active: z.boolean() })
const siteSchema = z.object({ id: z.string().uuid(), code: z.string().nullable(), name: z.string(), addressLine1: z.string().nullable(), addressLine2: z.string().nullable(), city: z.string().nullable(), region: z.string().nullable(), postalCode: z.string().nullable(), timeZone: z.string(), active: z.boolean(), latitude: z.number().nullable(), longitude: z.number().nullable(), geofenceRadiusMeters: z.number().int().nullable(), posts: z.array(postSchema) })
const unassignedSiteSchema = z.object({ id: z.string().uuid(), name: z.string(), code: z.string().nullable(), city: z.string().nullable(), region: z.string().nullable() })
const documentSchema = z.object({ id: z.string().uuid(), category: z.enum(['proposal', 'contract', 'amendment', 'pricing', 'post_order', 'insurance', 'correspondence', 'report', 'photo', 'video', 'other']), title: z.string(), description: z.string().nullable(), accessClassification: z.enum(['confidential', 'restricted', 'highly_restricted']), portalState: z.enum(['internal_only', 'eligible_to_share', 'awaiting_approval', 'published_to_client', 'withdrawn']), filename: z.string(), mimeType: z.string(), byteSize: z.number(), effectiveOn: z.string().nullable(), expiresOn: z.string().nullable(), createdAt: z.string() })
const activitySchema = z.object({ id: z.string().uuid(), kind: z.string(), occurredAt: z.string(), title: z.string(), detail: z.string(), siteId: z.string().uuid().nullable(), postId: z.string().uuid().nullable() })
const clientFileSchema = z.object({
  actor: actorSchema, client: clientSchema, contacts: z.array(contactSchema), sites: z.array(siteSchema), unassignedSites: z.array(unassignedSiteSchema),
  documents: z.array(documentSchema), documentPagination: z.object({ page: z.number().int(), pageSize: z.number().int(), totalCount: z.number().int() }),
  activity: z.array(activitySchema), activityPagination: z.object({ page: z.number().int(), pageSize: z.number().int() }),
})

export type ClientWorkspace = z.infer<typeof workspaceSchema>
export type ClientSummary = z.infer<typeof clientSummarySchema>
export type ClientFile = z.infer<typeof clientFileSchema>
export type ClientRecord = z.infer<typeof clientSchema>
export type ClientContact = z.infer<typeof contactSchema>
export type ClientDocument = z.infer<typeof documentSchema>
export type ClientStatus = z.infer<typeof clientStatusSchema>
export type ClientSite = z.infer<typeof siteSchema>
const importQueueSchema = z.object({ rows: z.array(z.object({ id: z.string().uuid(), batchId: z.string().uuid(), sourceTab: z.string(), sourceRow: z.number().int(), sourcePayload: z.record(z.string(), z.unknown()), suggestedStatus: z.string().nullable(), reviewState: z.literal('needs_review') })), pagination: paginationSchema })
export type ClientImportQueue = z.infer<typeof importQueueSchema>
const clientSourceRecordsSchema = z.object({ rows: z.array(z.object({
  id: z.string().uuid(), sourceTab: z.string(), sourceRow: z.number().int(), sourcePayload: z.record(z.string(), z.unknown()),
  reviewState: z.enum(['matched', 'promoted']), reviewedAt: z.string().nullable(), reviewNote: z.string().nullable(),
})) })
export type ClientSourceRecord = z.infer<typeof clientSourceRecordsSchema>['rows'][number]

export async function getClientsWorkspace(search = '', status = 'all', page = 1, pageSize: 5 | 10 | 20 = 10): Promise<ClientWorkspace> {
  const { data, error } = await getSupabaseClient().rpc('get_clients_workspace', { target_page: page, target_page_size: pageSize, target_search: search || null, target_status: status })
  if (error) throw new Error(error.message || 'Client Files could not be loaded.')
  return workspaceSchema.parse(data)
}

export async function getClientFile(id: string, activityPage = 1, activityPageSize: 5 | 10 | 20 = 10, documentPage = 1, documentPageSize: 5 | 10 | 20 = 10): Promise<ClientFile> {
  const { data, error } = await getSupabaseClient().rpc('get_client_file', { target_activity_page: activityPage, target_activity_page_size: activityPageSize, target_client_id: id, target_document_page: documentPage, target_document_page_size: documentPageSize })
  if (error) throw new Error(error.message || 'The Client File could not be loaded.')
  return clientFileSchema.parse(data)
}

export async function saveClient(client: Record<string, unknown>): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('upsert_client', { target_client: client })
  if (error) throw new Error(error.message || 'The Client File could not be saved.')
  return z.string().uuid().parse(data)
}

export async function saveClientContact(contact: Record<string, unknown>): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('upsert_client_contact', { target_contact: contact })
  if (error) throw new Error(error.message || 'The client contact could not be saved.')
  return z.string().uuid().parse(data)
}

export async function linkSiteToClient(siteId: string, clientId: string, reason: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('assign_site_to_client', { target_client_id: clientId, target_reason: reason, target_site_id: siteId })
  if (error) throw new Error(error.message || 'The site could not be linked to this Client File.')
}

export async function updateClientSiteLocation(input: { siteId: string; clientId: string; addressLine1: string | null; addressLine2: string | null; city: string | null; region: string | null; postalCode: string | null; timeZone: string; latitude: number | null; longitude: number | null; geofenceRadiusMeters: number | null; reason: string }): Promise<void> {
  const { error } = await getSupabaseClient().rpc('update_client_site_location', {
    target_address_line_1: input.addressLine1, target_address_line_2: input.addressLine2, target_city: input.city,
    target_client_id: input.clientId, target_geofence_radius_meters: input.geofenceRadiusMeters,
    target_latitude: input.latitude, target_longitude: input.longitude, target_postal_code: input.postalCode,
    target_reason: input.reason, target_region: input.region, target_site_id: input.siteId, target_time_zone: input.timeZone,
  })
  if (error) throw new Error(error.message || 'The client site location could not be updated.')
}

export async function saveClientServiceRecord(record: Record<string, unknown>): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc('upsert_client_service_record', { target_record: record })
  if (error) throw new Error(error.message || 'The client service record could not be saved.')
  return z.string().uuid().parse(data)
}

export async function getClientImportQueue(page = 1, pageSize: 5 | 10 | 20 = 10): Promise<ClientImportQueue> {
  const { data, error } = await getSupabaseClient().rpc('get_client_import_queue', { target_page: page, target_page_size: pageSize })
  if (error) throw new Error(error.message || 'The client source review queue could not be loaded.')
  return importQueueSchema.parse(data)
}

export async function resolveClientImportRow(rowId: string, action: 'match' | 'promote' | 'ignore', clientId: string | null, note: string, client: Record<string, unknown> | null = null): Promise<void> {
  const { error } = await getSupabaseClient().rpc('resolve_client_import_row', { target_action: action, target_client: client, target_client_id: clientId, target_note: note, target_row_id: rowId })
  if (error) throw new Error(error.message || 'The source row could not be resolved.')
}

export async function getClientImportSourceRecords(clientId: string): Promise<ClientSourceRecord[]> {
  const { data, error } = await getSupabaseClient().rpc('get_client_import_source_records', { target_client_id: clientId })
  if (error) throw new Error(error.message || 'The retained client source records could not be loaded.')
  return clientSourceRecordsSchema.parse(data).rows
}

export async function exportClientActivity(clientId: string): Promise<void> {
  const { data, error } = await getSupabaseClient().rpc('export_client_activity', { target_client_id: clientId, target_from: null, target_through: null })
  if (error) throw new Error(error.message || 'Client activity could not be exported.')
  const result = z.object({ clientName: z.string(), generatedAt: z.string(), rows: z.array(z.object({ recordId: z.string(), type: z.string(), occurredAt: z.string(), title: z.string(), detail: z.string(), site: z.string().nullable(), post: z.string().nullable() })) }).parse(data)
  const escape = (input: unknown) => `"${String(input ?? '').replaceAll('"', '""')}"`
  const csv = [['Occurred', 'Type', 'Site', 'Post', 'Title', 'Detail', 'Record ID'], ...result.rows.map((row) => [row.occurredAt, row.type, row.site, row.post, row.title, row.detail, row.recordId])].map((row) => row.map(escape).join(',')).join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `${result.clientName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'client'}-activity.csv`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function apiHeaders(contentType?: string): Promise<Headers> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Your secure Client File session is unavailable. Sign in again and retry.')
  const headers = new Headers({ authorization: `Bearer ${data.session.access_token}` })
  if (contentType) headers.set('content-type', contentType)
  return appendProtectedSessionHeaders(headers)
}

function encodeMetadata(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function documentMimeType(file: File): string {
  const declared = file.type.trim().toLowerCase().split(';')[0]
  if (declared) return declared
  const extension = file.name.trim().toLowerCase().split('.').at(-1) ?? ''
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as Record<string, string>)[extension] ?? ''
}

export class ClientDocumentApiError extends Error {
  code: string | null
  constructor(message: string, code: string | null = null) { super(message); this.name = 'ClientDocumentApiError'; this.code = code }
}
export function isClientIdentityVerificationRequired(error: unknown): boolean { return error instanceof ClientDocumentApiError && error.code === 'recent_document_mfa_required' }

export async function uploadClientDocument(input: { clientId: string; file: File; idempotencyKey: string; category: ClientDocument['category']; title: string; description: string; accessClassification: ClientDocument['accessClassification']; portalState: ClientDocument['portalState']; effectiveOn: string | null; expiresOn: string | null }, onProgress: (percent: number) => void): Promise<void> {
  const mime = documentMimeType(input.file); const headers = await apiHeaders(mime)
  headers.set('x-sygshift-client-document-metadata', encodeMetadata({ ...input, file: undefined, declaredMimeType: mime, originalFilename: input.file.name }))
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('PUT', `/api/v1/clients/${encodeURIComponent(input.clientId)}/documents`)
    headers.forEach((value, key) => request.setRequestHeader(key, value))
    request.upload.addEventListener('progress', (event) => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)) })
    request.addEventListener('load', () => {
      let payload: { detail?: string; error?: string } | null = null; try { payload = JSON.parse(request.responseText) } catch { /* response handled below */ }
      if (request.status >= 200 && request.status < 300) { onProgress(100); resolve(); return }
      reject(new ClientDocumentApiError(payload?.detail || 'The client document could not be uploaded.', payload?.error ?? null))
    })
    request.addEventListener('error', () => reject(new Error('The upload connection was interrupted. You can retry safely.')))
    request.send(input.file)
  })
}

export async function getClientDocumentBlob(documentId: string, action: 'preview' | 'download', reason: string): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/v1/clients/documents/${encodeURIComponent(documentId)}/content`, { body: JSON.stringify({ action, reason: reason.trim() }), cache: 'no-store', headers: await apiHeaders('application/json'), method: 'POST' })
  if (!response.ok) { const payload = await response.json().catch(() => null) as { detail?: string; error?: string } | null; throw new ClientDocumentApiError(payload?.detail || 'The protected client document could not be loaded.', payload?.error ?? null) }
  const disposition = response.headers.get('content-disposition') ?? ''; const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  return { blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : 'SygShift-client-document' }
}

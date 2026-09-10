import { z } from 'zod'
import { Upload } from 'tus-js-client'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

const personSchema = z.object({
  id: z.string().uuid(), name: z.string(), username: z.string().optional(), role: z.string().optional(),
  firstName: z.string().optional(), preferredName: z.string().nullable().optional(), legalName: z.string().optional(),
  photoPath: z.string().nullable().default(null), presence: z.string().default('offline'), owner: z.boolean().optional(),
  active: z.boolean().optional(), typing: z.boolean().optional(),
})
const mentionSchema = z.object({ id: z.string().uuid(), name: z.string(), username: z.string(), label: z.string().optional() })
const messageSchema = z.object({
  id: z.string().uuid(), sequence: z.number(), conversationId: z.string().uuid(), authorId: z.string().uuid(), authorName: z.string(),
  body: z.string(), parentId: z.string().nullable(), createdAt: z.string(), editedAt: z.string().nullable(), deleted: z.boolean(), pinned: z.boolean(), saved: z.boolean(), read: z.boolean(),
  readBy: z.array(z.object({ id: z.string(), name: z.string() })), replyCount: z.number(), unreadReplies: z.number(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number(), mine: z.boolean() })), mentions: z.array(mentionSchema).default([]),
})
const conversationBaseSchema = z.object({
  id: z.string().uuid(), kind: z.enum(['direct', 'group', 'channel']), name: z.string(), description: z.string(),
  archived: z.boolean(), owner: z.boolean(), muted: z.boolean(), favorite: z.boolean(), updatedAt: z.string(), unread: z.number(),
  latest: z.object({ id: z.string(), authorId: z.string(), createdAt: z.string(), parentId: z.string().nullable(), body: z.string() }).nullable(),
})
const conversationSchema = conversationBaseSchema.extend({ avatar: personSchema.nullable().default(null) })
const mentionAlertSchema = z.object({
  messageId: z.string().uuid(), conversationId: z.string().uuid(), conversationName: z.string(), authorId: z.string().uuid(),
  parentId: z.string().uuid().nullable(), createdAt: z.string(),
})
const inboxSchema = z.object({ employeeId: z.string(), soundEnabled: z.boolean(), conversations: z.array(conversationSchema), mentions: z.array(mentionAlertSchema).default([]) })
export type SpherePerson = z.infer<typeof personSchema>
export type SphereMention = z.infer<typeof mentionSchema>
export type SphereMessage = z.infer<typeof messageSchema>
export type SphereConversation = z.infer<typeof conversationSchema>
export type SphereInbox = z.infer<typeof inboxSchema>

export async function sphereRequest(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const { data, error } = await getSupabaseClient().rpc('sygsphere_request', { action, input })
  if (error) throw new Error(error.message || 'SygSphere could not complete this request. Your other SygShift features are unaffected.')
  return data
}
async function spherePeople(action: 'directory' | 'conversation' | 'avatars', input: Record<string, unknown> = {}) {
  const { data, error } = await getSupabaseClient().rpc('sygsphere_people', { action, input })
  if (error) throw new Error(error.message)
  return data
}
export async function sphereInbox() {
  const rawInbox = await sphereRequest('list')
  const [avatarResult, mentionResult] = await Promise.allSettled([spherePeople('avatars'), sphereRequest('mentions')])
  const rawAvatars = avatarResult.status === 'fulfilled' ? avatarResult.value : []
  const rawMentions = mentionResult.status === 'fulfilled' ? mentionResult.value : []
  const base = z.object({ employeeId: z.string(), soundEnabled: z.boolean(), conversations: z.array(conversationBaseSchema) }).parse(rawInbox)
  const avatars = z.array(z.object({ conversationId: z.string().uuid(), person: personSchema })).parse(rawAvatars)
  const byConversation = new Map(avatars.map((item) => [item.conversationId, item.person]))
  return inboxSchema.parse({
    ...base,
    conversations: base.conversations.map((item) => ({ ...item, avatar: byConversation.get(item.id) ?? null })),
    mentions: rawMentions,
  })
}
export async function sphereDirectory(query: string) {
  try { return z.array(personSchema).parse(await spherePeople('directory', { query })) }
  catch { return z.array(personSchema).parse(await sphereRequest('directory', { query })) }
}
export async function sphereConversation(conversationId: string) {
  const schema = z.object({ description: z.string(), members: z.array(personSchema) })
  try { return schema.parse(await spherePeople('conversation', { conversationId })) }
  catch { return schema.parse(await sphereRequest('conversation', { conversationId })) }
}
export const sphereMessages = async (conversationId: string, parentId: string | null = null, before?: number, pinned = false) => z.array(messageSchema).parse(await sphereRequest('messages', { conversationId, parentId, before, pinned }))
export const sphereMessage = async (conversationId: string, messageId: string) => messageSchema.parse(await sphereRequest('message', { conversationId, messageId }))
export const sphereSearch = async (query: string, saved = false, before?: number) => z.array(messageSchema).parse(await sphereRequest(saved ? 'saved' : 'search', { query, before }))
export const sphereCreate = async (input: { kind: string; name: string; members: string[] }) => z.object({ id: z.string() }).parse(await sphereRequest('create', input))
export const sphereSend = async (input: { conversationId: string; parentId: string | null; clientId: string; body: string; mentions: SphereMention[] }) => messageSchema.parse(await sphereRequest('send', { ...input, mentionIds: sphereMentionIds(input.body, input.mentions) }))

const preferenceSchema = z.object({ textSize: z.enum(['comfortable', 'large', 'extra_large']) })
export type SphereTextSize = z.infer<typeof preferenceSchema>['textSize']
export async function spherePreferences(textSize?: SphereTextSize) {
  const { data, error } = await getSupabaseClient().rpc('sygsphere_preferences', { target_text_size: textSize ?? null })
  if (error) throw new Error(error.message)
  return preferenceSchema.parse(data)
}

export function spherePath(conversationId?: string, messageId?: string, parentId?: string | null) {
  const params = new URLSearchParams()
  if (conversationId) params.set('conversation', conversationId)
  if (messageId) params.set('message', messageId)
  if (parentId) params.set('thread', parentId)
  return `/sygsphere${params.size ? `?${params}` : ''}`
}
export function sphereUnread(inbox?: SphereInbox) { return inbox?.conversations.filter((item) => item.unread > 0).length ?? 0 }

export type SphereDraft = { body: string; clientId: string; mentions: SphereMention[] }
export function sphereDraftKey(employeeId: string, conversationId: string, parentId: string | null) { return `sygsphere.draft.v1:${employeeId}:${conversationId}:${parentId ?? 'main'}` }
export function readSphereDraft(key: string): SphereDraft {
  try {
    const data = JSON.parse(localStorage.getItem(key) || 'null')
    const parsed = z.object({ body: z.string(), clientId: z.string(), mentions: z.array(mentionSchema).default([]) }).safeParse(data)
    if (parsed.success) return { body: parsed.data.body.slice(0, 12000), clientId: parsed.data.clientId, mentions: sphereActiveMentions(parsed.data.body, parsed.data.mentions) }
  } catch { /* Private browsing may disable storage. */ }
  return { body: '', clientId: crypto.randomUUID(), mentions: [] }
}
export function writeSphereDraft(key: string, draft: SphereDraft): boolean {
  try { if (draft.body) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); return true } catch { return false }
}
function sphereEscapeExpression(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function sphereHasMentionToken(body: string, label: string) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${sphereEscapeExpression(label)}(?=$|[^\\p{L}\\p{N}_.-])`, 'iu').test(body)
}
function spherePersonAliases(person: SpherePerson) {
  return [...new Set([person.legalName, person.name, person.firstName, person.preferredName].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => right.length - left.length)
}
function sphereAliasOwners(alias: string, members: SpherePerson[]) {
  return members.filter((person) => person.active && spherePersonAliases(person).some((candidate) => candidate.toLocaleLowerCase() === alias.toLocaleLowerCase()))
}
export function spherePersonMentionLabel(person: SpherePerson, members: SpherePerson[]) {
  const first = person.firstName?.trim() || person.preferredName?.trim() || person.name.trim().split(/\s+/)[0]
  if (first && sphereAliasOwners(first, members).length === 1) return first
  return person.legalName?.trim() || person.name.trim()
}
export function sphereResolveTypedMentions(body: string, mentions: SphereMention[], members: SpherePerson[], employeeId: string) {
  const resolved = [...mentions]
  for (const person of members) {
    if (person.id === employeeId || !person.active || !person.username) continue
    const label = spherePersonAliases(person).find((alias) => sphereAliasOwners(alias, members).length === 1 && sphereHasMentionToken(body, alias))
    if (!label) continue
    const index = resolved.findIndex((mention) => mention.id === person.id)
    const next = { id: person.id, name: person.name, username: person.username, label }
    if (index < 0) resolved.push(next); else resolved[index] = next
  }
  return sphereActiveMentions(body, resolved)
}
export function sphereActiveMentions(body: string, mentions: SphereMention[]) {
  return mentions.filter((mention, index) => mentions.findIndex((item) => item.id === mention.id) === index
    && sphereHasMentionToken(body, mention.label || mention.username))
}
export function sphereMentionIds(body: string, mentions: SphereMention[]) { return sphereActiveMentions(body, mentions).map((mention) => mention.id) }
export type SphereMessagePart = { kind: 'text' | 'link' | 'mention'; text: string; mention?: SphereMention }
export function sphereMessageParts(body: string, mentions: SphereMention[]): SphereMessagePart[] {
  const byToken = new Map<string, SphereMention>()
  for (const mention of mentions) {
    byToken.set(`@${mention.label || mention.username}`.toLocaleLowerCase(), mention)
    if (!mention.label) byToken.set(`@${mention.username}`.toLocaleLowerCase(), mention)
  }
  const mentionPattern = [...byToken.keys()].sort((left, right) => right.length - left.length).map(sphereEscapeExpression).join('|')
  const parts: SphereMessagePart[] = []; const matcher = new RegExp(`https?:\\/\\/[^\\s<>]+${mentionPattern ? `|(?:${mentionPattern})(?=$|[^\\p{L}\\p{N}_.-])` : ''}`, 'giu'); let cursor = 0
  for (const match of body.matchAll(matcher)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push({ kind: 'text', text: body.slice(cursor, index) })
    const token = match[0]; const mention = token.startsWith('@') ? byToken.get(token.toLocaleLowerCase()) : undefined
    parts.push(mention ? { kind: 'mention', text: token, mention } : /^https?:\/\//i.test(token) ? { kind: 'link', text: token } : { kind: 'text', text: token })
    cursor = index + token.length
  }
  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) })
  return parts
}

const sphereFileSchema = z.object({ id: z.string(), filename: z.string(), mimeType: z.string(), sizeBytes: z.number(), messageId: z.string(), parentId: z.string().nullable(), state: z.string(), createdAt: z.string() })
export type SphereFile = z.infer<typeof sphereFileSchema>
export type SpherePreview = { kind: 'image' | 'pdf'; url: string } | { kind: 'text'; text: string }
export function sphereCanPreview(file: Pick<SphereFile, 'mimeType' | 'sizeBytes'>) {
  return (['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimeType) && file.sizeBytes <= 26214400) || (file.mimeType === 'text/plain' && file.sizeBytes <= 1048576)
}
export async function sphereFiles(conversationId: string, before?: string, messageId?: string) {
  const { data, error } = await getSupabaseClient().rpc('sygsphere_files', { action: 'list', input: { conversationId, before, messageId } })
  if (error) throw new Error(error.message)
  return z.array(sphereFileSchema).parse(data)
}
async function sphereFileHeaders(contentType?: string) {
  const { data } = await getSupabaseClient().auth.getSession()
  if (!data.session) throw new Error('Your secure session is unavailable. Sign in again.')
  const headers = appendProtectedSessionHeaders(
    new Headers({ authorization: `Bearer ${data.session.access_token}` }),
    { includeSharedIdentity: true },
  )
  if (contentType) headers.set('content-type', contentType)
  return headers
}
async function sphereFileResponse(response: Response) {
  if (!response.ok) { const result = z.object({ detail: z.string().optional() }).safeParse(await response.json().catch(() => null)); throw new Error(result.success && result.data.detail ? result.data.detail : 'The protected file request could not be completed.') }
  return response
}
const sphereResumableMaxBytes = 104857600
const sphereStandardUploadMaxBytes = 6 * 1024 * 1024
const sphereResumableTargetSchema = z.object({
  bucket: z.string().optional(), expiresAt: z.string().optional(), messageId: z.string().nullable().optional(), objectKey: z.string().optional(),
  resumableEndpoint: z.string().url().optional(), signedUploadToken: z.string().min(1).optional(),
  failureStage: z.enum(['file_validation', 'security_scan', 'storage', 'expired']).nullable().optional(),
  manualRetryCount: z.number().int().nonnegative().optional(), requestReference: z.string().uuid().nullable().optional(), retryable: z.boolean().optional(),
  state: z.enum(['prepared', 'uploading', 'uploaded', 'scanning', 'clean', 'rejected', 'error', 'expired']).optional(), uploadId: z.string().uuid(),
})
export type SphereUploadStatus = z.infer<typeof sphereResumableTargetSchema>
export type SphereUploadStage = 'uploading' | 'scanning'
export type SphereUploadResult = { state: 'clean' | 'processing'; uploadId: string; requestReference?: string }

export class SphereUploadError extends Error {
  readonly code?: string
  readonly completionPending: boolean
  readonly requestReference?: string
  readonly retryable: boolean
  readonly uploadId?: string

  constructor(message: string, options: { code?: string; completionPending?: boolean; requestReference?: string; retryable?: boolean; uploadId?: string } = {}) {
    super(message)
    this.name = 'SphereUploadError'
    this.code = options.code
    this.completionPending = options.completionPending === true
    this.requestReference = options.requestReference
    this.retryable = options.retryable === true
    this.uploadId = options.uploadId
  }
}

async function sphereApiError(response: Response, fallback: string) {
  const payload = z.object({ detail: z.string().optional(), error: z.string().optional(), requestId: z.string().uuid().optional(), requestReference: z.string().uuid().optional(), retryable: z.boolean().optional(), uploadId: z.string().uuid().optional() }).safeParse(await response.json().catch(() => null))
  const message = payload.success && payload.data.detail ? payload.data.detail : fallback
  return new SphereUploadError(message, payload.success ? { code: payload.data.error, requestReference: payload.data.requestReference ?? payload.data.requestId, retryable: payload.data.retryable, uploadId: payload.data.uploadId } : {})
}

export async function sphereUploadStatus(uploadId: string): Promise<SphereUploadStatus> {
  const response = await fetch(`/api/v1/sygsphere/uploads/${uploadId}`, { headers: await sphereFileHeaders(), cache: 'no-store' })
  if (!response.ok) throw await sphereApiError(response, 'The file security-check status could not be read.')
  return sphereResumableTargetSchema.parse(await response.json())
}

const sphereCompletionRetryDelaysMs = [0, 250]

function waitForUploadCompletionRetry(delayMs: number) {
  return delayMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve()
}

export async function sphereCompleteUpload(
  uploadId: string,
  onProgress?: (percentage: number, stage: SphereUploadStage) => void,
  retryDelaysMs = sphereCompletionRetryDelaysMs,
): Promise<SphereUploadResult> {
  let pendingError: SphereUploadError | null = null
  onProgress?.(95, 'scanning')
  for (const delayMs of retryDelaysMs) {
    await waitForUploadCompletionRetry(delayMs)
    const complete = await fetch(`/api/v1/sygsphere/uploads/${uploadId}/complete`, {
      headers: await sphereFileHeaders('application/json'), body: '{}', method: 'POST', cache: 'no-store',
    })
    if (complete.ok) {
      const completed = sphereResumableTargetSchema.safeParse(await complete.json().catch(() => null))
      onProgress?.(100, 'scanning')
      return {
        state: completed.success && completed.data.state === 'clean' ? 'clean' : 'processing',
        uploadId,
        requestReference: completed.success ? completed.data.requestReference ?? undefined : complete.headers.get('x-request-id') ?? undefined,
      }
    }
    const error = await sphereApiError(complete, 'The protected file upload could not be finalized.')
    if (error.code !== 'sygsphere_file_not_stored') throw error
    pendingError = error
  }
  throw new SphereUploadError(
    'Your file finished uploading, but secure storage is still confirming it. Tap Check upload to finish without selecting the file again.',
    {
      code: pendingError?.code,
      completionPending: true,
      requestReference: pendingError?.requestReference,
      uploadId,
    },
  )
}

async function sphereProtectedUpload(file: File, fileId: string, conversationId: string, parentId: string | null, mimeType: string, onProgress?: (percentage: number, stage: SphereUploadStage) => void): Promise<SphereUploadResult> {
  const authorizationHeaders = await sphereFileHeaders('application/json')
  const authorization = await fetch('/api/v1/sygsphere/uploads', {
    body: JSON.stringify({ clientId: fileId, conversationId, fileId, filename: file.name, mimeType, parentId, sizeBytes: file.size }),
    headers: authorizationHeaders, method: 'POST', cache: 'no-store',
  })
  if (!authorization.ok) throw await sphereApiError(authorization, 'The protected file upload could not be authorized.')
  const target = sphereResumableTargetSchema.parse(await authorization.json())
  if (target.state === 'clean') { onProgress?.(100, 'scanning'); return { state: 'clean', uploadId: target.uploadId, requestReference: target.requestReference ?? undefined } }
  if (target.state === 'error') throw new SphereUploadError('The file could not complete its security check. Retry the security check without uploading it again.', { requestReference: target.requestReference ?? undefined, retryable: target.retryable, uploadId: target.uploadId })
  onProgress?.(1, 'uploading')
  if (target.state === 'prepared') {
    if (!target.bucket || !target.objectKey || !target.resumableEndpoint || !target.signedUploadToken) throw new Error('The secure file upload target is incomplete.')
    if (file.size <= sphereStandardUploadMaxBytes) {
      const { error } = await getSupabaseClient().storage
        .from(target.bucket)
        .uploadToSignedUrl(target.objectKey, target.signedUploadToken, file, {
          cacheControl: '3600',
          contentType: mimeType,
          upsert: false,
        })
      if (error) {
        throw new SphereUploadError(
          'The protected upload was interrupted before storage received the file. Your draft and selected file are still available.',
          { code: 'sygsphere_storage_transfer_failed', requestReference: target.requestReference ?? undefined, uploadId: target.uploadId },
        )
      }
      onProgress?.(90, 'uploading')
    } else {
      await new Promise<void>((resolve, reject) => {
        const upload = new Upload(file, {
          chunkSize: sphereStandardUploadMaxBytes,
          endpoint: target.resumableEndpoint,
          fingerprint: async () => `sygsphere:${target.uploadId}:${target.objectKey}:${file.size}:${file.lastModified}`,
          headers: { 'x-signature': target.signedUploadToken! },
          metadata: { bucketName: target.bucket!, cacheControl: '3600', contentType: mimeType, filename: file.name, objectName: target.objectKey! },
          onError: (error) => reject(new Error(error.message || 'The protected upload was interrupted. Your draft and selected file are still available.')),
          onProgress: (uploaded, total) => onProgress?.(total > 0 ? Math.min(90, Math.max(1, Math.round((uploaded / total) * 90))) : 1, 'uploading'),
          onSuccess: () => resolve(),
          removeFingerprintOnSuccess: true,
          retryDelays: [0, 3000, 5000, 10000, 20000],
          uploadDataDuringCreation: true,
        })
        void upload.findPreviousUploads().then((previous) => {
          if (previous[0]) upload.resumeFromPreviousUpload(previous[0])
          upload.start()
        }).catch(reject)
      })
    }
  }
  if (target.state !== 'scanning') return sphereCompleteUpload(target.uploadId, onProgress)
  onProgress?.(100, 'scanning')
  return { state: 'processing', uploadId: target.uploadId, requestReference: target.requestReference ?? undefined }
}

export async function sphereUpload(file: File, fileId: string, conversationId: string, parentId: string | null, onProgress?: (percentage: number, stage: SphereUploadStage) => void): Promise<SphereUploadResult> {
  if (file.size > sphereResumableMaxBytes || file.size < 1) throw new Error('Choose a file between 1 byte and 100 MB.')
  const fallbackMime: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  const mimeType = file.type || fallbackMime[file.name.split('.').at(-1)?.toLowerCase() || ''] || 'application/octet-stream'
  return sphereProtectedUpload(file, fileId, conversationId, parentId, mimeType, onProgress)
}

export async function sphereRetryUpload(uploadId: string): Promise<SphereUploadStatus> {
  const response = await fetch(`/api/v1/sygsphere/uploads/${uploadId}/retry`, {
    headers: await sphereFileHeaders('application/json'), body: '{}', method: 'POST', cache: 'no-store',
  })
  if (!response.ok) throw await sphereApiError(response, 'The file security check could not be retried.')
  return sphereResumableTargetSchema.parse(await response.json())
}
export async function sphereDownload(file: SphereFile) {
  const response = await sphereFileResponse(await fetch(`/api/v1/sygsphere/files/${file.id}`, { headers: await sphereFileHeaders(), cache: 'no-store' }))
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}
export async function spherePreview(file: SphereFile): Promise<SpherePreview> {
  if (!sphereCanPreview(file)) throw new Error(file.mimeType === 'text/plain' ? 'Text previews are limited to 1 MB. Download it instead.' : 'Preview is not available for this file type. Download it instead.')
  const response = await sphereFileResponse(await fetch(`/api/v1/sygsphere/files/${file.id}?mode=preview`, { headers: await sphereFileHeaders(), cache: 'no-store' }))
  const blob = await response.blob()
  if (file.mimeType === 'text/plain') return { kind: 'text', text: await blob.text() }
  return { kind: file.mimeType === 'application/pdf' ? 'pdf' : 'image', url: URL.createObjectURL(blob) }
}
export async function spherePhoto(photoPath: string) {
  if (photoPath.includes('\0') || photoPath.includes('..') || photoPath.length > 700) throw new Error('The profile photo path is invalid.')
  const { data, error } = await getSupabaseClient().storage.from('employee-photos').download(photoPath)
  if (error) throw new Error(error.message)
  return data
}

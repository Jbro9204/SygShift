import { z } from 'zod'
import { Upload } from 'tus-js-client'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

const personSchema = z.object({
  id: z.string().uuid(), name: z.string(), username: z.string().optional(), role: z.string().optional(),
  photoPath: z.string().nullable().default(null), presence: z.string().default('offline'), owner: z.boolean().optional(),
  active: z.boolean().optional(), typing: z.boolean().optional(),
})
const mentionSchema = z.object({ id: z.string().uuid(), name: z.string(), username: z.string() })
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
export function sphereActiveMentions(body: string, mentions: SphereMention[]) {
  const lower = body.toLocaleLowerCase()
  return mentions.filter((mention, index) => mentions.findIndex((item) => item.id === mention.id) === index && lower.includes(`@${mention.username.toLocaleLowerCase()}`))
}
export function sphereMentionIds(body: string, mentions: SphereMention[]) { return sphereActiveMentions(body, mentions).map((mention) => mention.id) }
export type SphereMessagePart = { kind: 'text' | 'link' | 'mention'; text: string; mention?: SphereMention }
export function sphereMessageParts(body: string, mentions: SphereMention[]): SphereMessagePart[] {
  const byUsername = new Map(mentions.map((mention) => [mention.username.toLocaleLowerCase(), mention]))
  const parts: SphereMessagePart[] = []; const matcher = /https?:\/\/[^\s<>]+|@[a-z0-9._-]+/gi; let cursor = 0
  for (const match of body.matchAll(matcher)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push({ kind: 'text', text: body.slice(cursor, index) })
    const token = match[0]; const mention = token.startsWith('@') ? byUsername.get(token.slice(1).toLocaleLowerCase()) : undefined
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
  const headers = appendProtectedSessionHeaders(new Headers({ authorization: `Bearer ${data.session.access_token}` }))
  if (contentType) headers.set('content-type', contentType)
  return headers
}
async function sphereFileResponse(response: Response) {
  if (!response.ok) { const result = z.object({ detail: z.string().optional() }).safeParse(await response.json().catch(() => null)); throw new Error(result.success && result.data.detail ? result.data.detail : 'The protected file request could not be completed.') }
  return response
}
const sphereInlineMaxBytes = 26214400
const sphereResumableMaxBytes = 104857600
const sphereLargeImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const sphereResumableTargetSchema = z.object({
  bucket: z.string().optional(), expiresAt: z.string().optional(), messageId: z.string().nullable().optional(), objectKey: z.string().optional(),
  resumableEndpoint: z.string().url().optional(), signedUploadToken: z.string().min(1).optional(),
  state: z.enum(['prepared', 'uploading', 'uploaded', 'scanning', 'clean', 'rejected', 'error', 'expired']).optional(), uploadId: z.string().uuid(),
})

async function sphereApiError(response: Response, fallback: string) {
  const payload = z.object({ detail: z.string().optional() }).safeParse(await response.json().catch(() => null))
  return new Error(payload.success && payload.data.detail ? payload.data.detail : fallback)
}

async function pollSygSphereUpload(uploadId: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await fetch(`/api/v1/sygsphere/uploads/${uploadId}`, { headers: await sphereFileHeaders(), cache: 'no-store' })
    if (!response.ok) throw await sphereApiError(response, 'The larger-file security check could not be read.')
    const status = sphereResumableTargetSchema.parse(await response.json())
    if (status.state === 'clean') return
    if (status.state && ['rejected', 'error', 'expired'].includes(status.state)) {
      throw new Error(status.state === 'rejected' ? 'This file was blocked by its security check and was not shared.' : 'The larger-file upload expired or could not be checked safely. Retry the upload.')
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2000))
  }
  throw new Error('The file is still being checked. It will appear in the conversation when the security check finishes.')
}

async function sphereResumableUpload(file: File, fileId: string, conversationId: string, parentId: string | null, mimeType: string, onProgress?: (percentage: number) => void) {
  if (!sphereLargeImageTypes.has(mimeType)) throw new Error('Files over 25 MB must be JPEG, PNG, or WebP images. Other supported files remain limited to 25 MB.')
  const authorizationHeaders = await sphereFileHeaders('application/json')
  const authorization = await fetch('/api/v1/sygsphere/uploads', {
    body: JSON.stringify({ clientId: fileId, conversationId, fileId, filename: file.name, mimeType, parentId, sizeBytes: file.size }),
    headers: authorizationHeaders, method: 'POST', cache: 'no-store',
  })
  if (!authorization.ok) throw await sphereApiError(authorization, 'The larger-file upload could not be authorized.')
  const target = sphereResumableTargetSchema.parse(await authorization.json())
  if (target.state === 'clean') { onProgress?.(100); return }
  if (target.state === 'prepared') {
    if (!target.bucket || !target.objectKey || !target.resumableEndpoint || !target.signedUploadToken) throw new Error('The secure larger-file upload target is incomplete.')
    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(file, {
        chunkSize: 6 * 1024 * 1024,
        endpoint: target.resumableEndpoint,
        fingerprint: async () => `sygsphere:${target.uploadId}:${target.objectKey}:${file.size}:${file.lastModified}`,
        headers: { 'x-signature': target.signedUploadToken! },
        metadata: { bucketName: target.bucket!, cacheControl: '3600', contentType: mimeType, filename: file.name, objectName: target.objectKey! },
        onError: (error) => reject(new Error(error.message || 'The resumable upload failed.')),
        onProgress: (uploaded, total) => onProgress?.(total > 0 ? Math.min(99, Math.round((uploaded / total) * 90)) : 0),
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
  if (target.state !== 'scanning') {
    const complete = await fetch(`/api/v1/sygsphere/uploads/${target.uploadId}/complete`, {
      headers: await sphereFileHeaders('application/json'), body: '{}', method: 'POST', cache: 'no-store',
    })
    if (!complete.ok) throw await sphereApiError(complete, 'The larger-file upload could not be finalized.')
  }
  onProgress?.(92)
  await pollSygSphereUpload(target.uploadId)
  onProgress?.(100)
}

export async function sphereUpload(file: File, fileId: string, conversationId: string, parentId: string | null, onProgress?: (percentage: number) => void) {
  if (file.size > sphereResumableMaxBytes || file.size < 1) throw new Error('Choose a file between 1 byte and 100 MB.')
  const fallbackMime: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  const mimeType = file.type || fallbackMime[file.name.split('.').at(-1)?.toLowerCase() || ''] || 'application/octet-stream'
  if (file.size > sphereInlineMaxBytes) return sphereResumableUpload(file, fileId, conversationId, parentId, mimeType, onProgress)
  const params = new URLSearchParams({ conversation: conversationId, filename: file.name })
  if (parentId) params.set('thread', parentId)
  await sphereFileResponse(await fetch(`/api/v1/sygsphere/files/${fileId}?${params}`, { method: 'PUT', headers: await sphereFileHeaders(mimeType), body: file, cache: 'no-store' }))
  onProgress?.(100)
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

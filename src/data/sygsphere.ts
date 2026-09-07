import { z } from 'zod'
import { getSupabaseClient } from '../lib/supabase'
import { appendProtectedSessionHeaders } from '../lib/protectedSessionHeaders'

const personSchema = z.object({ id: z.string().uuid(), name: z.string(), username: z.string().optional(), role: z.string().optional(), presence: z.string().default('offline'), owner: z.boolean().optional(), active: z.boolean().optional(), typing: z.boolean().optional() })
const messageSchema = z.object({
  id: z.string().uuid(), sequence: z.number(), conversationId: z.string().uuid(), authorId: z.string().uuid(), authorName: z.string(),
  body: z.string(), parentId: z.string().nullable(), createdAt: z.string(), editedAt: z.string().nullable(), deleted: z.boolean(), pinned: z.boolean(), saved: z.boolean(), read: z.boolean(),
  readBy: z.array(z.object({ id: z.string(), name: z.string() })), replyCount: z.number(), unreadReplies: z.number(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number(), mine: z.boolean() })),
})
const conversationSchema = z.object({ id: z.string().uuid(), kind: z.enum(['direct', 'group', 'channel']), name: z.string(), description: z.string(), archived: z.boolean(), owner: z.boolean(), muted: z.boolean(), favorite: z.boolean(), updatedAt: z.string(), unread: z.number(), latest: z.object({ id: z.string(), authorId: z.string(), createdAt: z.string(), parentId: z.string().nullable(), body: z.string() }).nullable() })
const inboxSchema = z.object({ employeeId: z.string(), soundEnabled: z.boolean(), conversations: z.array(conversationSchema) })
export type SpherePerson = z.infer<typeof personSchema>
export type SphereMessage = z.infer<typeof messageSchema>
export type SphereConversation = z.infer<typeof conversationSchema>
export type SphereInbox = z.infer<typeof inboxSchema>

export async function sphereRequest(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const { data, error } = await getSupabaseClient().rpc('sygsphere_request', { action, input })
  if (error) throw new Error(error.message || 'SygSphere could not complete this request. Your other SygShift features are unaffected.')
  return data
}
export const sphereInbox = async () => inboxSchema.parse(await sphereRequest('list'))
export const sphereDirectory = async (query: string) => z.array(personSchema).parse(await sphereRequest('directory', { query }))
export const sphereConversation = async (conversationId: string) => z.object({ description: z.string(), members: z.array(personSchema) }).parse(await sphereRequest('conversation', { conversationId }))
export const sphereMessages = async (conversationId: string, parentId: string | null = null, before?: number, pinned = false) => z.array(messageSchema).parse(await sphereRequest('messages', { conversationId, parentId, before, pinned }))
export const sphereMessage = async (conversationId: string, messageId: string) => messageSchema.parse(await sphereRequest('message', { conversationId, messageId }))
export const sphereSearch = async (query: string, saved = false, before?: number) => z.array(messageSchema).parse(await sphereRequest(saved ? 'saved' : 'search', { query, before }))
export const sphereCreate = async (input: { kind: string; name: string; members: string[] }) => z.object({ id: z.string() }).parse(await sphereRequest('create', input))
export const sphereSend = async (input: { conversationId: string; parentId: string | null; clientId: string; body: string }) => messageSchema.parse(await sphereRequest('send', input))

export function spherePath(conversationId?: string, messageId?: string, parentId?: string | null) {
  const params = new URLSearchParams()
  if (conversationId) params.set('conversation', conversationId)
  if (messageId) params.set('message', messageId)
  if (parentId) params.set('thread', parentId)
  return `/sygsphere${params.size ? `?${params}` : ''}`
}
export function sphereUnread(inbox?: SphereInbox) { return inbox?.conversations.filter((item) => item.unread > 0).length ?? 0 }

export type SphereDraft = { body: string; clientId: string }
export function sphereDraftKey(employeeId: string, conversationId: string, parentId: string | null) { return `sygsphere.draft.v1:${employeeId}:${conversationId}:${parentId ?? 'main'}` }
export function readSphereDraft(key: string): SphereDraft {
  try { const data = JSON.parse(localStorage.getItem(key) || 'null'); if (typeof data?.body === 'string' && typeof data?.clientId === 'string') return { body: data.body.slice(0, 12000), clientId: data.clientId } } catch { /* Private browsing may disable storage. */ }
  return { body: '', clientId: crypto.randomUUID() }
}
export function writeSphereDraft(key: string, draft: SphereDraft): boolean {
  try { if (draft.body) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); return true } catch { return false }
}

const sphereFileSchema = z.object({ id: z.string(), filename: z.string(), mimeType: z.string(), sizeBytes: z.number(), messageId: z.string(), parentId: z.string().nullable(), state: z.string(), createdAt: z.string() })
export type SphereFile = z.infer<typeof sphereFileSchema>
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
export async function sphereUpload(file: File, fileId: string, conversationId: string, parentId: string | null) {
  if (file.size > 26214400 || file.size < 1) throw new Error('Choose a file between 1 byte and 25 MB.')
  const params = new URLSearchParams({ conversation: conversationId, filename: file.name })
  if (parentId) params.set('thread', parentId)
  await sphereFileResponse(await fetch(`/api/v1/sygsphere/files/${fileId}?${params}`, { method: 'PUT', headers: await sphereFileHeaders(file.type || 'application/octet-stream'), body: file, cache: 'no-store' }))
}
export async function sphereDownload(file: SphereFile) {
  const response = await sphereFileResponse(await fetch(`/api/v1/sygsphere/files/${file.id}`, { headers: await sphereFileHeaders(), cache: 'no-store' }))
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

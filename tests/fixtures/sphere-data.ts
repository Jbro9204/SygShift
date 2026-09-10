import type { SphereConversation, SphereMessage, SpherePerson } from '../../src/data/sygsphere'
export const isSupabaseConfigured = true
// The fixture client is already isolated; shared-session switching is intentionally a no-op.
export async function activateSharedIdentitySupabaseSession(_accessToken: string, _refreshToken: string) {}
export function deactivateSharedIdentitySupabaseSession() {}
const a = '10000000-0000-4000-8000-000000000001'
const b = '10000000-0000-4000-8000-000000000002'
const c = '10000000-0000-4000-8000-000000000003'
export const conversationId = '20000000-0000-4000-8000-000000000001'
const params = new URLSearchParams(location.search)
export const actor = params.has('second') ? b : a
const key = `sphere-fixture:${params.get('scope') || 'default'}`
const bus = new BroadcastChannel(key)
const people: SpherePerson[] = [{ id: a, name: 'Mara Chen', username: 'mchen', role: 'guard', photoPath: null, presence: 'available', active: true, owner: true }, { id: b, name: 'Devon Ruiz', username: 'druiz', role: 'dispatcher', photoPath: null, presence: 'available', active: true, owner: false }, { id: c, name: 'Casey Morgan', username: 'cmorgan', role: 'supervisor', photoPath: null, presence: 'away', active: true, owner: false }]
type State = { conversations: SphereConversation[]; messages: SphereMessage[]; reads: Record<string, string[]>; soundEnabled: boolean }
function state(): State { return JSON.parse(localStorage.getItem(key) || JSON.stringify({ conversations: [{ id: conversationId, kind: 'channel', name: 'Operations', description: 'Daily handoffs and coordination.', archived: false, owner: actor === a, muted: false, favorite: true, updatedAt: new Date().toISOString(), unread: 0, latest: null, avatar: null }], messages: [], reads: {}, soundEnabled: false })) }
function write(value: State) { localStorage.setItem(key, JSON.stringify(value)); bus.postMessage({ changed: true }); window.dispatchEvent(new Event('sphere-fixture-update')) }
let fail = false
export function failNextSend() { fail = true }
function addMessage(value: State, body: string, authorId: string, cid = conversationId, parentId: string | null = null) {
  const message: SphereMessage = { id: crypto.randomUUID(), sequence: value.messages.length + 1, conversationId: cid, authorId, authorName: people.find((person) => person.id === authorId)!.name, body, parentId, createdAt: new Date().toISOString(), editedAt: null, deleted: false, pinned: false, saved: false, read: false, readBy: [], replyCount: 0, unreadReplies: 0, reactions: [], mentions: [] }; value.messages.push(message); return message
}
export function incoming() { const value = state(); addMessage(value, 'Incoming operational update', actor === a ? b : a); write(value) }
function decorate(value: State, message: SphereMessage): SphereMessage { return { ...message, read: message.authorId === actor || (value.reads[message.id] || []).includes(actor), replyCount: value.messages.filter((item) => item.parentId === message.id).length, unreadReplies: value.messages.filter((item) => item.parentId === message.id && item.authorId !== actor && !(value.reads[item.id] || []).includes(actor)).length, readBy: (value.reads[message.id] || []).filter((id) => id !== message.authorId).map((id) => ({ id, name: people.find((person) => person.id === id)!.name })) } }
function request(action: string, input: Record<string, unknown>) {
  const value = state(); const cid = String(input.conversationId); const message = value.messages.find((item) => item.id === input.messageId); const conversation = value.conversations.find((item) => item.id === cid)
  if (action === 'list') return { employeeId: actor, soundEnabled: value.soundEnabled, conversations: value.conversations.map((item) => ({ ...item, owner: actor === a, unread: value.messages.filter((message) => message.conversationId === item.id && !decorate(value, message).read && !message.deleted).length, latest: value.messages.filter((message) => message.conversationId === item.id).at(-1) || null })) }
  if (action === 'mentions') return value.messages.filter((item) => item.authorId !== actor && item.mentions.some((mention) => mention.id === actor) && !decorate(value, item).read).map((item) => ({ messageId: item.id, conversationId: item.conversationId, conversationName: value.conversations.find((conversation) => conversation.id === item.conversationId)?.name || 'Conversation', authorId: item.authorId, parentId: item.parentId, createdAt: item.createdAt }))
  if (action === 'directory') return people.filter((person) => `${person.name} ${person.username}`.toLowerCase().includes(String(input.query || '').toLowerCase()))
  if (action === 'presence') { if ('soundEnabled' in input) { value.soundEnabled = Boolean(input.soundEnabled); write(value) } return { ok: true } }
  if (action === 'conversation') return { description: conversation?.description || '', members: people }
  if (action === 'messages') return value.messages.filter((message) => message.conversationId === cid && (input.pinned ? message.pinned : message.parentId === (input.parentId || null))).map((message) => decorate(value, message))
  if (action === 'message') return message ? decorate(value, message) : null
  if (action === 'typing') return { ok: true }
  if (action === 'search' || action === 'saved') return value.messages.filter((message) => action === 'saved' ? message.saved : message.body.toLowerCase().includes(String(input.query).toLowerCase())).map((message) => decorate(value, message))
  if (action === 'create') { const id = crypto.randomUUID(); value.conversations.push({ id, name: String(input.name || people.find((person) => (input.members as string[]).includes(person.id))?.name), kind: input.kind as SphereConversation['kind'], description: '', owner: true, favorite: false, muted: false, archived: false, updatedAt: new Date().toISOString(), unread: 0, latest: null, avatar: null }); write(value); return { id } }
  if (action === 'send') { if (fail) { fail = false; throw new Error('Connection interrupted. Please retry.') } const message = addMessage(value, String(input.body), actor, cid, input.parentId ? String(input.parentId) : null); message.mentions = ((input.mentionIds as string[] | undefined) || []).flatMap((id) => { const person = people.find((item) => item.id === id); return person?.username ? [{ id: person.id, name: person.name, username: person.username }] : [] }); write(value); return decorate(value, message) }
  if (action === 'read') for (const id of input.messageIds as string[]) value.reads[id] = [...new Set([...(value.reads[id] || []), actor])]
  if (action === 'settings' && conversation) { if ('muted' in input) conversation.muted = Boolean(input.muted); if ('favorite' in input) conversation.favorite = Boolean(input.favorite) }
  if (action === 'rename' && conversation) { conversation.name = String(input.name); conversation.description = String(input.description) }
  if (action === 'archive' && conversation) conversation.archived = Boolean(input.archived)
  if (message) {
    if (action === 'edit') { message.body = String(input.body); message.editedAt = new Date().toISOString() }
    if (action === 'delete') { message.deleted = true; message.body = '' }
    if (action === 'save') message.saved = Boolean(input.enabled)
    if (action === 'pin') message.pinned = Boolean(input.enabled)
    if (action === 'react') message.reactions = input.enabled ? [{ emoji: String(input.emoji), count: 1, mine: true }] : []
  }
  write(value); return { ok: true }
}
export function getSupabaseClient() {
  return { auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-only', user: { id: actor } } } }) }, realtime: { setAuth: async () => {} }, storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'No fixture photo' } }), uploadToSignedUrl: async (path: string) => { document.documentElement.dataset.sphereSignedUploadPath = path; return { data: { path }, error: null } } }) }, channel: () => {
    let listener = () => {}
    const receive = () => listener()
    const channel = { on: (_type: string, _filter: unknown, callback: () => void) => { listener = callback; return channel }, subscribe: (callback: (status: string) => void) => { bus.addEventListener('message', receive); window.addEventListener('sphere-fixture-update', receive); queueMicrotask(() => callback('SUBSCRIBED')); return channel }, close: () => { bus.removeEventListener('message', receive); window.removeEventListener('sphere-fixture-update', receive) } }; return channel
  }, removeChannel: async (channel: { close: () => void }) => channel.close(), rpc: async (name: string, args: { action?: string; input?: Record<string, unknown>; target_text_size?: string | null }) => { try {
    if (name === 'sygsphere_files') return { data: [], error: null }
    if (name === 'sygsphere_preferences') return { data: { textSize: args.target_text_size || 'comfortable' }, error: null }
    if (name === 'sygsphere_people') {
      if (args.action === 'directory') return { data: request('directory', args.input || {}), error: null }
      if (args.action === 'conversation') return { data: request('conversation', args.input || {}), error: null }
      return { data: [], error: null }
    }
    return { data: request(args.action || '', args.input || {}), error: null }
  } catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : 'Failed' } } } } }
}

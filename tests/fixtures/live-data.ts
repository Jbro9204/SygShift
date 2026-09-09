// Isolated, shared browser state for exercising real components. Never contacts production.
import type { SupportTicketDetail, SupportTicketStatus } from '../../src/data/support'
export const isSupabaseConfigured = true
// The fixture client is already isolated; shared-session switching is intentionally a no-op.
export async function activateSharedIdentitySupabaseSession(_accessToken: string, _refreshToken: string) {}
export function deactivateSharedIdentitySupabaseSession() {}
export const employeeId = '10000000-0000-4000-8000-000000000001'
const adminId = '10000000-0000-4000-8000-000000000002'
const requester = { id: employeeId, name: 'Alex Employee' }
const handler = { id: adminId, name: 'Casey Support' }
const isAdmin = new URLSearchParams(location.search).has('admin')
const actor = isAdmin ? adminId : employeeId
const scope = new URLSearchParams(location.search).get('scope') || 'default'
const key = `live-fixture:${scope}`
const bus = new BroadcastChannel(key)
const readState = (): { status: SupportTicketStatus; messages: SupportTicketDetail['messages']; alerts: Array<Record<string, unknown>> } => JSON.parse(localStorage.getItem(key) || '{"status":"new","messages":[],"alerts":[]}')
function writeState(state: ReturnType<typeof readState>) { localStorage.setItem(key, JSON.stringify(state)); bus.postMessage({ kind: 'support' }) }
export function emitAlert(id = crypto.randomUUID(), createdAt = new Date().toISOString()) {
  const state = readState()
  state.alerts.push({ id, title: 'New fixture update', priority: 'important', createdAt, actionPath: '/notifications', sourceType: 'direct', sourceId: null })
  writeState(state)
  bus.postMessage({ kind: 'notification', isNew: true })
  window.dispatchEvent(new CustomEvent('fixture-live', { detail: { kind: 'notification', isNew: true } }))
}
export async function getSupportTicket(): Promise<SupportTicketDetail> {
  const state = readState()
  return { id: employeeId, ticketNumber: 'TKT-LIVE', subject: 'Live synchronization fixture', category: 'technical', subcategory: 'Display', status: state.status, priority: 'normal', confidential: false, submittedBy: requester, assignedTo: handler, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readThrough: new Date().toISOString(), description: 'A safe browser-only synchronization test.', occurredOn: null, stillHappening: true, impact: {}, relatedContext: {}, sourcePath: '/support', routePermission: 'admin.maintenance.manage', canManage: isAdmin, messages: state.messages.filter((message) => isAdmin || message.visibility === 'public'), events: [] }
}
export async function getSupportWorkspace() {
  return { tickets: [await getSupportTicket()], page: { number: 1, size: 10, total: 1, totalPages: 1 }, permissions: { staffAccess: isAdmin, canManage: isAdmin, isAdmin }, unreadNotifications: 0 }
}
export async function getSupportTicketAssignees() { return [handler] }
export async function markSupportTicketRead() {}
export async function submitSupportTicket() { return { id: employeeId, ticketNumber: 'TKT-LIVE', status: 'new', priority: 'normal' } }
export async function updateSupportTicket(_id: string, changes: { status?: SupportTicketStatus }) {
  const state = readState()
  if (changes.status) state.status = changes.status
  writeState(state)
}
export async function addSupportTicketMessage(_id: string, body: string, internal: boolean) {
  const state = readState()
  state.messages.push({ id: state.messages.length + 1, body, visibility: internal ? 'internal' : 'public', createdAt: new Date().toISOString(), author: isAdmin ? handler : requester })
  if (!internal) state.status = isAdmin ? 'in_progress' : state.status === 'resolved' ? 'reopened' : state.status
  writeState(state)
  return state.messages.length
}
export function getSupabaseClient() {
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 'isolated-fixture', user: { id: actor } } } }) },
    realtime: { setAuth: async () => {} },
    channel: () => {
      let listener: (event: { payload: unknown }) => void = () => {}
      const receive = (event: MessageEvent) => listener({ payload: event.data })
      const custom = (event: Event) => listener({ payload: (event as CustomEvent).detail })
      const channel = {
        on: (_type: string, _filter: unknown, callback: typeof listener) => { listener = callback; return channel },
        subscribe: (callback: (status: string) => void) => { bus.addEventListener('message', receive); window.addEventListener('fixture-live', custom); queueMicrotask(() => callback('SUBSCRIBED')); return channel },
        close: () => { bus.removeEventListener('message', receive); window.removeEventListener('fixture-live', custom) },
      }
      return channel
    },
    removeChannel: async (channel: { close: () => void }) => channel.close(),
    rpc: async (name: string, input: Record<string, unknown> = {}) => {
      if (name === 'get_my_live_notifications') return { data: { serverTime: new Date().toISOString(), notifications: readState().alerts.filter((alert) => input.target_since && Date.parse(String(alert.createdAt)) >= Date.parse(String(input.target_since))) }, error: null }
      if (name === 'get_my_notification_badge') return { data: { unread: readState().alerts.length, requiresAction: 0, urgent: 0 }, error: null }
      if (name === 'get_session_context') return { data: { employee_id: actor, username: isAdmin ? 'csupport' : 'aemployee', display_name: isAdmin ? 'Casey Support' : 'Alex Employee', role: isAdmin ? 'admin' : 'guard', must_change_password: false, password_changed_at: null, mfa_enrolled_at: null, mfa_required: false, has_mfa: false }, error: null }
      if (name === 'get_my_push_subscription') return { data: { enabled: false }, error: null }
      return { data: null, error: null }
    },
  }
}

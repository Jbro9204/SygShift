import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Clock3, Inbox, LifeBuoy, LockKeyhole, MessageSquare, RefreshCw, Search, Send, ShieldCheck, UserRoundCheck } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { DataStatePanel } from '../components/DataStatePanel'
import { SupportProgress } from '../components/SupportProgress'
import { supportLifecycle } from '../lib/supportLifecycle'
import { SupportTicketForm } from '../components/SupportTicketForm'
import { addSupportTicketMessage, getSupportTicket, getSupportTicketAssignees, getSupportWorkspace, updateSupportTicket, type SupportTicketPriority, type SupportTicketStatus } from '../data/support'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'

const categoryLabel = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const statusLabel = (value: string) => value === 'closed' ? 'Resolved' : categoryLabel(value)
const statusClass = (value: string) => value === 'closed' || value === 'resolved' ? 'status-badge status-badge--active' : value === 'waiting_on_employee' ? 'status-badge status-badge--leave' : 'status-badge'

export function SupportTicketsPage() {
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<5 | 10 | 20>(10)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('open')
  const [showForm, setShowForm] = useState(false)
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(false)
  const selectedId = params.get('ticket')
  const queryInput = useMemo(() => ({ page, pageSize, search, status }), [page, pageSize, search, status])
  const workspaceQuery = useQuery({ enabled: isSupabaseConfigured, queryFn: () => getSupportWorkspace(queryInput), queryKey: ['support', 'workspace', queryInput] })
  const detailQuery = useQuery({ enabled: isSupabaseConfigured && Boolean(selectedId), queryFn: () => getSupportTicket(selectedId!), queryKey: ['support', 'ticket', selectedId] })
  const assigneesQuery = useQuery({ enabled: Boolean(detailQuery.data?.canManage && selectedId), queryFn: () => getSupportTicketAssignees(selectedId!), queryKey: ['support', 'assignees', selectedId] })
  const refresh = async () => Promise.all([queryClient.invalidateQueries({ queryKey: ['support', 'workspace'] }), queryClient.invalidateQueries({ queryKey: ['support', 'ticket', selectedId] }), queryClient.invalidateQueries({ queryKey: ['my-notifications'] })])
  const replyMutation = useMutation({ mutationFn: (input: { ticketId: string; body: string; internal: boolean }) => addSupportTicketMessage(input.ticketId, input.body, input.internal), onSuccess: async () => { setReply(''); setInternal(false); await refresh() } })
  const updateMutation = useMutation({ mutationFn: (changes: { status?: SupportTicketStatus; priority?: SupportTicketPriority; assignedTo?: string | null }) => updateSupportTicket(selectedId!, changes), onSuccess: refresh })
  const workspace = workspaceQuery.data
  const ticket = detailQuery.data
  const lifecycle = ticket ? supportLifecycle(ticket.status) : null
  const { reset: resetReply } = replyMutation
  const { reset: resetUpdate } = updateMutation
  useEffect(() => {
    setReply('')
    setInternal(false)
    resetReply()
    resetUpdate()
  }, [selectedId, resetReply, resetUpdate])
  useEffect(() => {
    if (detailQuery.dataUpdatedAt) void queryClient.invalidateQueries({ queryKey: ['my-notifications'] })
  }, [detailQuery.dataUpdatedAt, queryClient])

  useEffect(() => {
    if (!selectedId && workspace?.tickets[0]) setParams({ ticket: workspace.tickets[0].id }, { replace: true })
  }, [selectedId, setParams, workspace?.tickets])

  function submitReply(event: FormEvent) {
    event.preventDefault()
    if (reply.trim() && !replyMutation.isPending) replyMutation.mutate({ ticketId: selectedId!, body: reply.trim(), internal })
  }

  return <div className="page page--support support-workspace">
    <section className="page-intro support-hero"><div><p className="eyebrow">Help &amp; Support</p><h1>{workspace?.permissions.staffAccess ? 'Support Tickets' : 'My Support Tickets'}</h1><p className="page-summary">{workspace?.permissions.staffAccess ? 'Work the requests routed to your authorized roles. Administrators can access every ticket.' : 'Review your requests, responses, and current status in one place.'}</p></div><div className="support-hero__actions"><button className="secondary-button" onClick={() => void refresh()} type="button"><RefreshCw size={18} />Refresh</button><button className="primary-action" onClick={() => setShowForm(true)} type="button"><LifeBuoy size={19} />New support ticket</button></div></section>
    {!isSupabaseConfigured ? <DataStatePanel icon={LifeBuoy} title="Support needs the secure connection" tone="setup"><p>Connect the protected data service before submitting or reviewing tickets.</p></DataStatePanel> : workspaceQuery.isPending ? <DataStatePanel icon={Inbox} title="Loading support tickets"><p>Checking your permitted ticket queues.</p></DataStatePanel> : workspaceQuery.isError ? <DataStatePanel icon={LifeBuoy} title="Support tickets unavailable" tone="error"><p>{workspaceQuery.error.message}</p></DataStatePanel> : workspace ? <>
      {workspace.unreadNotifications > 0 ? <div className="inline-success"><MessageSquare size={18} />You have {workspace.unreadNotifications} unread ticket update{workspace.unreadNotifications === 1 ? '' : 's'}.</div> : null}
      <section className="support-board">
        <div className="support-list-panel"><div className="support-list-toolbar"><label className="support-search"><span>Search tickets</span><div><Search size={18} /><input onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Ticket number or subject" value={search} /></div></label><label><span>Status</span><select onChange={(event) => { setStatus(event.target.value); setPage(1) }} value={status}><option value="open">Open tickets</option><option value="new">New</option><option value="assigned">Assigned</option><option value="reopened">Reopened</option><option value="in_progress">In progress</option><option value="waiting_on_employee">Waiting on employee</option><option value="resolved">Resolved</option><option value="all">All tickets</option></select></label></div>
          {workspace.tickets.length === 0 ? <DataStatePanel icon={Inbox} title="No support tickets match"><p>Change the filters or submit a new request.</p></DataStatePanel> : <div className="support-ticket-list">{workspace.tickets.map((item) => <button className={selectedId === item.id ? 'support-ticket-row selected' : 'support-ticket-row'} key={item.id} disabled={replyMutation.isPending || updateMutation.isPending} onClick={() => setParams({ ticket: item.id })} type="button"><div><span>{item.ticketNumber}</span>{item.confidential ? <LockKeyhole aria-label="Confidential" size={14} /> : null}<span className={`support-priority support-priority--${item.priority}`}>{item.priority}</span></div><strong>{item.subject}</strong><small>{categoryLabel(item.category)} · {item.submittedBy.name}</small><footer><span className={statusClass(item.status)}>{statusLabel(item.status)}</span><time>{formatOperationalDateTime(item.updatedAt)}</time></footer></button>)}</div>}
          <div className="communications-pagination communications-pagination--compact"><span>Page {workspace.page.number} of {workspace.page.totalPages} · {workspace.page.total} tickets</span><label><span>Rows</span><select onChange={(event) => { setPageSize(Number(event.target.value) as 5 | 10 | 20); setPage(1) }} value={pageSize}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label><button className="secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">Previous</button><button className="secondary-button" disabled={page >= workspace.page.totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div>
        </div>
        <div className="support-detail-panel">{!selectedId ? <DataStatePanel icon={MessageSquare} title="Choose a ticket"><p>Select a ticket to review its conversation and linked context.</p></DataStatePanel> : detailQuery.isPending ? <DataStatePanel icon={MessageSquare} title="Loading ticket"><p>Loading the complete conversation.</p></DataStatePanel> : detailQuery.isError ? <DataStatePanel icon={LifeBuoy} title="Ticket unavailable" tone="error"><p>{detailQuery.error.message}</p></DataStatePanel> : ticket ? <>
          <header className="support-detail-heading"><div><span>{ticket.ticketNumber}</span><h2>{ticket.subject}</h2><p>{categoryLabel(ticket.category)} · {ticket.subcategory}</p></div><span className={statusClass(ticket.status)}>{statusLabel(ticket.status)}</span></header>
          {lifecycle ? <section className="support-lifecycle" aria-label="Ticket lifecycle"><SupportProgress label="Ticket lifecycle progress" labels={lifecycle.labels} current={lifecycle.current} /><div className="support-lifecycle__summary" role="status"><strong>{lifecycle.next}</strong><span>{ticket.assignedTo ? `Handler: ${ticket.assignedTo.name}` : `Queue: ${ticket.confidential || ticket.category === 'human_resources' ? 'Authorized Human Resources' : categoryLabel(ticket.category)} support`}</span><span>Last updated {formatOperationalDateTime(ticket.updatedAt)}</span></div></section> : null}
          <dl className="support-ticket-context"><div><dt>Submitted by</dt><dd>{ticket.submittedBy.name}</dd></div><div><dt>Submitted</dt><dd>{formatOperationalDateTime(ticket.createdAt, { includeTimeZoneName: true })}</dd></div><div><dt>Priority</dt><dd>{categoryLabel(ticket.priority)}</dd></div><div><dt>Privacy</dt><dd>{ticket.confidential ? 'Confidential HR routing' : 'Standard role routing'}</dd></div></dl>
          {ticket.canManage ? <section className="support-management" aria-label="Ticket management"><label><span>Status</span><select disabled={updateMutation.isPending} onChange={(event) => updateMutation.mutate({ status: event.target.value as SupportTicketStatus })} value={ticket.status}><option value="new">New</option><option value="assigned">Assigned</option><option value="in_progress">In progress</option><option value="waiting_on_employee">Waiting on employee</option><option value="resolved">Resolved</option><option value="reopened">Reopened</option></select></label><label><span>Priority</span><select disabled={updateMutation.isPending} onChange={(event) => updateMutation.mutate({ priority: event.target.value as SupportTicketPriority })} value={ticket.priority}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label><span>Assigned to</span><select disabled={updateMutation.isPending || assigneesQuery.isPending || assigneesQuery.isError} onChange={(event) => updateMutation.mutate({ assignedTo: event.target.value || null })} value={ticket.assignedTo?.id ?? ''}><option value="">Unassigned</option>{assigneesQuery.data?.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></section> : null}
          {updateMutation.isError ? <div className="inline-alert support-update-result" role="alert">{updateMutation.error.message}</div> : updateMutation.isPending ? <p className="support-update-result" role="status">Saving ticket changes…</p> : updateMutation.isSuccess ? <p className="inline-success support-update-result" role="status">Ticket updated.</p> : null}
          {assigneesQuery.isError && ticket.canManage ? <p className="inline-alert support-update-result" role="alert">Authorized handlers could not be loaded. Refresh to try again.</p> : null}
          <section className="support-original-request"><h3>Original request</h3><p>{ticket.description}</p>{ticket.sourcePath ? <small>Submitted from {ticket.sourcePath}</small> : null}</section>
          <section className="support-conversation" aria-label="Ticket conversation"><h3>Conversation</h3>{ticket.messages.length === 0 ? <p className="support-empty-conversation">No replies yet.</p> : ticket.messages.map((message) => <article className={message.visibility === 'internal' ? 'support-message support-message--internal' : 'support-message'} key={message.id}><header><strong>{message.author.name}</strong><span>{message.visibility === 'internal' ? 'Internal note · ' : ''}{formatOperationalDateTime(message.createdAt)}</span></header><p>{message.body}</p></article>)}</section>
          <form className="support-reply" onSubmit={submitReply}><label><span>{internal ? 'Internal note' : 'Reply to ticket'}</span><textarea maxLength={5000} onChange={(event) => setReply(event.target.value)} disabled={replyMutation.isPending} placeholder={internal ? 'Leave a note for the authorized support team…' : 'Write your reply here. We’ll notify the people who need the update.'} rows={5} value={reply} /></label>{ticket.canManage ? <label className="support-check"><input disabled={replyMutation.isPending} checked={internal} onChange={(event) => setInternal(event.target.checked)} type="checkbox" /><span>Add as an internal note—do not email the requester</span></label> : null}{replyMutation.isError ? <div className="inline-alert" role="alert">{replyMutation.error.message}</div> : null}{replyMutation.isSuccess ? <div className="inline-success" role="status"><CheckCircle2 size={18} />{replyMutation.variables?.internal ? 'Internal note added. No email was queued.' : 'Reply added. Ticket updates were queued.'}</div> : null}<div className="support-reply-actions"><span>{internal ? <><ShieldCheck size={16} />Authorized staff only</> : <><Send size={16} />In-app and email update</>}</span><button className="primary-action" disabled={!reply.trim() || replyMutation.isPending} type="submit">{replyMutation.isPending ? 'Sending…' : internal ? 'Add internal note' : 'Send reply'}</button></div></form>
          {ticket.canManage && ticket.events.length > 0 ? <details className="support-history"><summary><Clock3 size={17} />Ticket history</summary>{ticket.events.map((event) => <div key={event.id}><UserRoundCheck size={15} /><span><strong>{statusLabel(event.type)}</strong> by {event.actorName}</span><time>{formatOperationalDateTime(event.createdAt)}</time></div>)}</details> : null}
        </> : null}</div>
      </section>
    </> : null}
    {showForm ? <SupportTicketForm onClose={() => setShowForm(false)} /> : null}
  </div>
}

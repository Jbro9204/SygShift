import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Link2, MessageSquareText, Search, ShieldCheck, Unlink } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  getClientCommunicationCandidates,
  getClientCommunicationForConversation,
  getClientCommunications,
  linkClientConversation,
  unlinkClientConversation,
  type ClientCommunication,
} from '../data/clientCommunications'
import { spherePath } from '../data/sygsphere'
import { formatOperationalDateTime } from '../lib/time'
import { ModalDialog } from './ModalDialog'

function conversationKindLabel(kind: ClientCommunication['kind']) {
  if (kind === 'direct') return 'Direct conversation'
  if (kind === 'channel') return 'Private team channel'
  return 'Group conversation'
}

function CommunicationsEmpty({ clientScoped, filtered }: { clientScoped: boolean; filtered: boolean }) {
  return <div className="client-empty client-communications-empty"><MessageSquareText aria-hidden="true" size={28} /><strong>{filtered ? 'No conversations match that search' : clientScoped ? 'No conversations linked yet' : 'No linked client conversations'}</strong><span>{filtered ? 'Try a client name, client number, conversation name, or purpose.' : clientScoped ? 'Link an existing SygSphere conversation so client coordination is easy to find without copying messages.' : 'Client-linked SygSphere conversations that you participate in will appear here.'}</span></div>
}

function Pagination({ busy = false, page, pageSize, totalCount, totalPages, onPage, onPageSize }: {
  busy?: boolean
  page: number
  pageSize: 10 | 20 | 50
  totalCount: number
  totalPages: number
  onPage: (page: number) => void
  onPageSize?: (pageSize: 10 | 20 | 50) => void
}) {
  return <footer className="client-pagination"><span>Page {page} · {totalCount} conversations</span>{onPageSize ? <label>Rows <select disabled={busy} onChange={(event) => onPageSize(Number(event.target.value) as 10 | 20 | 50)} value={pageSize}><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label> : null}<button className="secondary-button secondary-button--small" disabled={busy || page <= 1} onClick={() => onPage(page - 1)} type="button">Previous</button><button className="secondary-button secondary-button--small" disabled={busy || totalPages === 0 || page >= totalPages} onClick={() => onPage(page + 1)} type="button">Next</button></footer>
}

export function ClientCommunications({ clientId, employeeId, onBack }: { clientId?: string; employeeId: string; onBack?: () => void }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<10 | 20 | 50>(20)
  const [linkOpen, setLinkOpen] = useState(false)
  const [candidateSearch, setCandidateSearch] = useState('')
  const [candidatePage, setCandidatePage] = useState(1)
  const [unlinkTarget, setUnlinkTarget] = useState<ClientCommunication | null>(null)
  const linkRequest = useRef<{ fingerprint: string; requestId: string } | null>(null)
  const unlinkRequest = useRef<{ fingerprint: string; requestId: string } | null>(null)

  useEffect(() => {
    setSearch('')
    setPage(1)
    setCandidateSearch('')
    setCandidatePage(1)
    setLinkOpen(false)
    setUnlinkTarget(null)
    linkRequest.current = null
    unlinkRequest.current = null
  }, [clientId, employeeId])

  const clientScope = clientId ?? 'all'
  const workspace = useQuery({
    queryKey: ['client-communications', employeeId, 'workspace', clientScope, search, page, pageSize],
    queryFn: () => getClientCommunications({ clientId, search, page, pageSize }),
    placeholderData: (previousData, previousQuery) => (
      previousQuery?.queryKey[1] === employeeId
      && previousQuery.queryKey[2] === 'workspace'
      && previousQuery.queryKey[3] === clientScope
        ? previousData
        : undefined
    ),
  })
  const candidates = useQuery({
    queryKey: ['client-communications', employeeId, 'candidates', clientId, candidateSearch, candidatePage],
    queryFn: () => getClientCommunicationCandidates({ clientId: clientId!, search: candidateSearch, page: candidatePage, pageSize: 20 }),
    enabled: Boolean(clientId && linkOpen),
    placeholderData: (previousData, previousQuery) => (
      previousQuery?.queryKey[1] === employeeId
      && previousQuery.queryKey[2] === 'candidates'
      && previousQuery.queryKey[3] === clientId
        ? previousData
        : undefined
    ),
  })
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['client-communications', employeeId] })
  }
  const linkMutation = useMutation({
    mutationFn: linkClientConversation,
    onSuccess: async () => { linkRequest.current = null; setLinkOpen(false); await refresh() },
  })
  const unlinkMutation = useMutation({
    mutationFn: unlinkClientConversation,
    onSuccess: async () => { unlinkRequest.current = null; setUnlinkTarget(null); await refresh() },
  })
  const openLinkDialog = () => {
    linkMutation.reset()
    linkRequest.current = null
    setCandidateSearch('')
    setCandidatePage(1)
    setLinkOpen(true)
  }
  const closeLinkDialog = () => { linkMutation.reset(); linkRequest.current = null; setLinkOpen(false) }
  const openUnlinkDialog = (row: ClientCommunication) => { unlinkMutation.reset(); unlinkRequest.current = null; setUnlinkTarget(row) }
  const closeUnlinkDialog = () => { unlinkMutation.reset(); unlinkRequest.current = null; setUnlinkTarget(null) }
  const candidatesBusy = candidates.isFetching || linkMutation.isPending
  const submitLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (candidatesBusy || !candidates.data?.rows.length || !clientId) return
    const form = new FormData(event.currentTarget)
    const conversationId = String(form.get('conversationId'))
    const purpose = String(form.get('purpose')).trim()
    const fingerprint = JSON.stringify([clientId, conversationId, purpose])
    const request = linkRequest.current?.fingerprint === fingerprint
      ? linkRequest.current
      : { fingerprint, requestId: globalThis.crypto.randomUUID() }
    linkRequest.current = request
    linkMutation.mutate({ requestId: request.requestId, clientId, conversationId, purpose })
  }
  const submitUnlink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (unlinkMutation.isPending || !unlinkTarget) return
    const form = new FormData(event.currentTarget)
    const reason = String(form.get('reason')).trim()
    const fingerprint = JSON.stringify([
      unlinkTarget.linkId,
      unlinkTarget.clientId,
      unlinkTarget.conversationId,
      reason,
    ])
    const request = unlinkRequest.current?.fingerprint === fingerprint
      ? unlinkRequest.current
      : { fingerprint, requestId: globalThis.crypto.randomUUID() }
    unlinkRequest.current = request
    unlinkMutation.mutate({
      requestId: request.requestId,
      linkId: unlinkTarget.linkId,
      clientId: unlinkTarget.clientId,
      conversationId: unlinkTarget.conversationId,
      reason,
    })
  }

  if (workspace.isPending) return <section className="client-card client-communications-card" aria-busy="true"><div className="client-empty"><MessageSquareText aria-hidden="true" size={28} /><strong>Loading client communications…</strong><span>Checking your current Client File and SygSphere access.</span></div></section>
  if (workspace.isError || !workspace.data) return <section className="client-card client-communications-card"><div className="client-section-heading"><div><p className="eyebrow">Internal staff communication</p><h2>Client communications</h2></div></div><div className="inline-alert" role="alert"><strong>Client communications are unavailable.</strong><span>{workspace.error?.message ?? 'Try again.'}</span><button className="secondary-button secondary-button--small" onClick={() => void workspace.refetch()} type="button">Try again</button></div></section>

  const data = workspace.data
  return <section aria-busy={workspace.isFetching && !workspace.isPending} className="client-card client-communications-card">
    <div className="client-section-heading client-communications-heading"><div>
      {onBack ? <button className="client-communications-back" onClick={onBack} type="button"><ArrowLeft aria-hidden="true" size={17} />Client Directory</button> : null}
      <p className="eyebrow">Internal staff communication</p><h2>{clientId ? 'Client communications' : 'All client communications'}</h2>
      <p>Messages stay in their original protected SygSphere conversation. This view helps authorized participants find the client context; it does not send messages to a client portal.</p>
    </div>{clientId && data.actor.canManage ? <button className="primary-action" onClick={openLinkDialog} type="button"><Link2 aria-hidden="true" size={17} />Link conversation</button> : null}</div>
    <div className="client-communications-assurance"><ShieldCheck aria-hidden="true" size={19} /><div><strong>Membership remains authoritative</strong><span>Only current participants can open or preview a conversation. Linking never adds a participant or changes message history.</span></div></div>
    <label className="search-field client-communications-search"><Search aria-hidden="true" size={18} /><span className="sr-only">Search client communications</span><input aria-label="Search client communications" maxLength={100} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="Search client, conversation, or purpose" value={search} /></label>
    <span aria-live="polite" className="sr-only" role="status">{workspace.isFetching && !workspace.isPending ? 'Updating client communications…' : ''}</span>
    {data.rows.length ? <div className="client-communications-list" role="list">{data.rows.map((row) => <div className="client-communication-row" key={row.linkId} role="listitem">
      <div className="client-communication-row__icon"><MessageSquareText aria-hidden="true" size={20} /></div>
      <div className="client-communication-row__body"><div className="client-communication-row__title"><strong>{row.conversationName}</strong>{row.unread ? <span className="client-communication-unread">{row.unread} unread</span> : null}{row.archived ? <span className="status-badge">Archived</span> : null}</div>
        {!clientId ? <Link className="client-communication-client" to={`/clients/${row.clientId}`}>{row.clientName} · {row.clientNumber}</Link> : null}
        <span>{conversationKindLabel(row.kind)} · {row.purpose || 'General operations'}</span>
        {row.latestBody ? <p><strong>Latest:</strong> {row.latestBody}</p> : <p>No messages have been sent in this conversation yet.</p>}
        <small>{row.latestCreatedAt ? `Last message ${formatOperationalDateTime(row.latestCreatedAt, { includeTimeZoneName: true })}` : `Linked ${formatOperationalDateTime(row.linkedAt, { includeTimeZoneName: true })}`}</small>
      </div>
      <div className="client-communication-row__actions"><Link className="primary-action" to={spherePath(row.conversationId)}><ExternalLink aria-hidden="true" size={16} />Open in SygSphere</Link>{data.actor.canManage ? <button className="secondary-button secondary-button--small" onClick={() => openUnlinkDialog(row)} type="button"><Unlink aria-hidden="true" size={15} />Unlink</button> : null}</div>
    </div>)}</div> : <CommunicationsEmpty clientScoped={Boolean(clientId)} filtered={Boolean(search.trim())} />}
    <Pagination {...data.pagination} busy={workspace.isFetching} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1) }} />
    {linkOpen && clientId ? <ModalDialog busy={linkMutation.isPending} description="Link an existing SygSphere conversation without copying its messages or changing its participants." onClose={closeLinkDialog} title="Link client conversation"><form className="client-form" onSubmit={submitLink}><label><span>Find a SygSphere conversation</span><input disabled={linkMutation.isPending} maxLength={100} onChange={(event) => { setCandidateSearch(event.target.value); setCandidatePage(1) }} placeholder="Search by conversation or participant" value={candidateSearch} /></label>{candidates.isPending ? <div className="client-empty client-communications-candidates"><strong>Loading available conversations…</strong></div> : candidates.isError || !candidates.data ? <div className="inline-alert" role="alert"><strong>Available conversations could not be loaded.</strong><span>{candidates.error?.message ?? 'Try again.'}</span><button className="secondary-button secondary-button--small" onClick={() => void candidates.refetch()} type="button">Try again</button></div> : <>{candidates.data.rows.length ? <label><span>SygSphere conversation</span><select disabled={candidatesBusy} name="conversationId" required><option value="">Choose a conversation you participate in</option>{candidates.data.rows.map((conversation) => <option key={conversation.conversationId} value={conversation.conversationId}>{conversation.conversationName} · {conversationKindLabel(conversation.kind)}</option>)}</select></label> : <div className="client-empty client-communications-candidates"><strong>No available conversations match</strong><span>Try another search, or confirm the conversation is active and not linked to another Client File.</span></div>}<Pagination {...candidates.data.pagination} busy={candidates.isFetching} onPage={setCandidatePage} /></>}<label><span>Client purpose</span><input defaultValue="General operations" disabled={linkMutation.isPending} maxLength={160} minLength={3} name="purpose" required /></label><div className="client-communications-assurance"><ShieldCheck aria-hidden="true" size={18} /><span>Everyone already in the conversation keeps the same access. No client contact receives a message from this action.</span></div>{linkMutation.isError ? <div className="inline-alert" role="alert">{linkMutation.error.message}</div> : null}<div className="modal-actions"><button className="secondary-button" disabled={linkMutation.isPending} onClick={closeLinkDialog} type="button">Cancel</button><button className="primary-action" disabled={candidatesBusy || !candidates.data?.rows.length} type="submit">{linkMutation.isPending ? 'Linking…' : 'Link conversation'}</button></div></form></ModalDialog> : null}
    {unlinkTarget ? <ModalDialog busy={unlinkMutation.isPending} description="The conversation and every message remain in SygSphere. Only its Client File shortcut will be removed." onClose={closeUnlinkDialog} title={`Unlink ${unlinkTarget.conversationName}?`}><form className="client-form" onSubmit={submitUnlink}><label><span>Reason for unlinking</span><input defaultValue="Conversation is no longer associated with this client." disabled={unlinkMutation.isPending} maxLength={500} minLength={5} name="reason" required /></label>{unlinkMutation.isError ? <div className="inline-alert" role="alert">{unlinkMutation.error.message}</div> : null}<div className="modal-actions"><button className="secondary-button" disabled={unlinkMutation.isPending} onClick={closeUnlinkDialog} type="button">Keep link</button><button className="primary-action" disabled={unlinkMutation.isPending} type="submit">{unlinkMutation.isPending ? 'Unlinking…' : 'Unlink conversation'}</button></div></form></ModalDialog> : null}
  </section>
}

export function SygSphereClientAssociation({ conversationId, employeeId }: { conversationId: string; employeeId: string }) {
  const workspace = useQuery({ queryKey: ['client-communications', employeeId, 'association', conversationId], queryFn: () => getClientCommunicationForConversation(conversationId), staleTime: 30_000 })
  const communication = workspace.data?.communication
  if (workspace.isPending) return <p className="sphere-hint" role="status">Checking Client File link…</p>
  if (workspace.isError || !workspace.data?.actor.canView) return null
  if (!communication) return <div className="sphere-client-link sphere-client-link--empty"><MessageSquareText aria-hidden="true" size={18} /><div><strong>No Client File linked</strong><span>An authorized Client Communications manager who participates in this chat can link it from a Client File’s Communications tab.</span></div></div>
  return <div className="sphere-client-link"><ShieldCheck aria-hidden="true" size={18} /><div><strong>{communication.clientName}</strong><span>{communication.clientNumber} · {communication.purpose || 'General operations'}</span></div><Link to={`/clients/${communication.clientId}`}>View Client File</Link></div>
}

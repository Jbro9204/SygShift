import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ALargeSmall, ArrowLeft, Bell, BellOff, Bookmark, Check, ChevronDown, Download, Eye, Hash, Info, MessageCircle, Paperclip, Plus, Search, Send, Smile, Users, X } from 'lucide-react'
import { getSessionContext } from '../data/auth'
import { readSphereDraft, sphereActiveMentions, sphereCanPreview, sphereConversation, sphereCreate, sphereDirectory, sphereDownload, sphereDraftKey, sphereFiles, sphereInbox, sphereMessage, sphereMessageParts, sphereMessages, spherePath, spherePhoto, spherePreferences, spherePreview, sphereRequest, sphereSearch, sphereSend, sphereUpload, writeSphereDraft, type SphereConversation, type SphereFile, type SphereMention, type SphereMessage, type SpherePerson, type SpherePreview, type SphereTextSize } from '../data/sygsphere'
import { ModalDialog } from '../components/ModalDialog'
import { SecurePdfViewer } from '../components/SecurePdfViewer'
import '../styles/sygsphere.css'

const reactions = ['👍', '❤️', '✅', '🎉', '👀', '🙏']
function ErrorNotice({ error }: { error: unknown }) { return error ? <p className="sphere-error" role="alert">{error instanceof Error ? error.message : 'This request could not be completed. Please try again.'}</p> : null }

function MessageActionPopover({ label, trigger, panelClassName, children }: { label: string; trigger: ReactNode; panelClassName: string; children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const summaryRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const close = (restoreFocus = false) => {
    const details = detailsRef.current
    if (!details?.open) return
    details.open = false
    setOpen(false)
    if (restoreFocus) summaryRef.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    const closeFromOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !detailsRef.current?.contains(target)) close()
    }
    document.addEventListener('pointerdown', closeFromOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', closeFromOutsidePointer, true)
  }, [open])
  return <details ref={detailsRef} onToggle={(event) => setOpen(event.currentTarget.open)} onKeyDown={(event) => {
    if (event.key !== 'Escape' || !event.currentTarget.open) return
    event.preventDefault(); event.stopPropagation(); close(true)
  }} onClick={(event) => {
    const target = event.target
    if (target instanceof Element && target.closest('button')?.closest('details') === event.currentTarget) close(true)
  }}>
    <summary ref={summaryRef} aria-expanded={open} aria-label={label}>{trigger}</summary>
    <div className={panelClassName}>{children}</div>
  </details>
}

function Avatar({ name, photoPath }: { name: string; photoPath?: string | null }) {
  const photo = useQuery({ queryKey: ['sygsphere', 'avatar', photoPath], queryFn: () => spherePhoto(photoPath!), enabled: Boolean(photoPath), staleTime: 300000, retry: 1 })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!photo.data) { setUrl(null); return }
    const next = URL.createObjectURL(photo.data); setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [photo.data])
  return <span className="sphere-avatar" aria-hidden="true">{url ? <img src={url} alt="" /> : name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('')}</span>
}
function messageTime(value: string) {
  const date = new Date(value)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: '2-digit', day: '2-digit', year: 'numeric' }).format(date)
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' }).format(date)
  const military = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  return `${day} · ${time}${Number(military.slice(0, 2)) >= 13 ? ` (${military})` : ''} MT`
}
function MessageBody({ text, mentions, employeeId }: { text: string; mentions: SphereMention[]; employeeId: string }) {
  return <div className="sphere-message__body">{sphereMessageParts(text, mentions).map((part, index) => part.kind === 'link'
    ? <a key={index} href={part.text} target="_blank" rel="noopener noreferrer">{part.text}</a>
    : part.kind === 'mention' ? <mark key={index} className={part.mention?.id === employeeId ? 'sphere-mention sphere-mention--self' : 'sphere-mention'} title={part.mention?.name}>{part.text}</mark> : part.text)}</div>
}

export function SygSpherePage() {
  const session = useQuery({ queryKey: ['sygsphere', 'session'], queryFn: getSessionContext, staleTime: 60000 })
  if (session.isError) return <section className="sphere-workspace"><ErrorNotice error={session.error} /></section>
  if (!session.data) return <section className="sphere-workspace"><p role="status">Opening SygSphere…</p></section>
  return <SphereWorkspace employeeId={session.data.employeeId} />
}

export function SphereWorkspace({ employeeId }: { employeeId: string }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [newOpen, setNewOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'chats' | 'search' | 'saved'>('chats')
  const [details, setDetails] = useState(false)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const inbox = useQuery({ queryKey: ['sygsphere', employeeId, 'inbox'], queryFn: sphereInbox, refetchInterval: 30000, retry: 1 })
  const textPreference = useQuery({ queryKey: ['sygsphere', employeeId, 'text-size'], queryFn: () => spherePreferences(), staleTime: 300000 })
  const conversationId = params.get('conversation')
  const threadId = params.get('thread')
  const focusId = params.get('message')
  const conversation = inbox.data?.conversations.find((item) => item.id === conversationId)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] })
  const preferences = useMutation({ mutationFn: (soundEnabled: boolean) => sphereRequest('presence', { soundEnabled }), onSuccess: refresh })
  const updateTextSize = useMutation({ mutationFn: (textSize: SphereTextSize) => spherePreferences(textSize), onSuccess: (value) => queryClient.setQueryData(['sygsphere', employeeId, 'text-size'], value) })
  const openConversation = (id: string) => { setView('chats'); setDetails(false); navigate(spherePath(id)) }
  useEffect(() => {
    if (conversationId) { try { localStorage.setItem(`sygsphere.last:${employeeId}`, conversationId) } catch { /* Optional preference. */ } }
    else if (inbox.data && view === 'chats') {
      try { const last = localStorage.getItem(`sygsphere.last:${employeeId}`); if (last && inbox.data.conversations.some((item) => item.id === last)) navigate(spherePath(last), { replace: true }) } catch { /* Optional preference. */ }
    }
  }, [conversationId, employeeId, inbox.data, navigate, view])
  if (inbox.isError) return <section className="sphere-workspace sphere-unavailable"><img src="/branding/sygsphere-emblem.png" alt="" /><h1>SygSphere is unavailable</h1><ErrorNotice error={inbox.error} /><button type="button" onClick={() => void inbox.refetch()}>Try again</button><p>Your other SygShift tools remain available.</p></section>
  return <section className={`sphere-workspace ${conversation && view === 'chats' ? 'sphere-workspace--conversation' : ''}`} data-text-size={textPreference.data?.textSize ?? 'comfortable'} aria-label="SygSphere messaging">
    <header className="sphere-topbar"><div><img src="/branding/sygsphere-emblem.png" alt="" /><h1>SygSphere<span>Your team, connected.</span></h1></div><div>
      <label className="sphere-text-size"><ALargeSmall size={19} /><span className="sr-only">Message text size</span><select aria-label="Message text size" value={textPreference.data?.textSize ?? 'comfortable'} disabled={textPreference.isPending || updateTextSize.isPending} onChange={(event) => updateTextSize.mutate(event.target.value as SphereTextSize)}><option value="comfortable">Comfortable</option><option value="large">Large</option><option value="extra_large">Extra large</option></select></label>
      <button type="button" aria-label={inbox.data?.soundEnabled ? 'Mute SygSphere sounds' : 'Enable SygSphere sounds'} title="Messaging sounds only" disabled={preferences.isPending} onClick={() => preferences.mutate(!inbox.data?.soundEnabled)}>{inbox.data?.soundEnabled ? <Bell size={19} /> : <BellOff size={19} />}</button>
      <button className="sphere-primary" type="button" onClick={() => setNewOpen(true)}><Plus size={19} /> New message</button></div></header>
    <ErrorNotice error={preferences.error || updateTextSize.error} />
    <div className="sphere-layout">
      <nav className="sphere-conversations" aria-label="SygSphere conversations">
        <div className="sphere-tabs"><button type="button" aria-pressed={view === 'chats'} onClick={() => { setView('chats'); navigate('/sygsphere') }}><MessageCircle size={16} /> Chats</button><button type="button" aria-pressed={view === 'saved'} onClick={() => setView('saved')}><Bookmark size={16} /> Saved</button><button type="button" aria-pressed={view === 'search'} onClick={() => setView('search')}><Search size={16} /> Search</button></div>
        <label className="sphere-search"><Search size={17} /><input aria-label="Find a conversation" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a conversation…" /></label>
        <div className="sphere-conversation-list">{inbox.isPending ? <p role="status">Loading your conversations…</p> : null}
          {(['Favorites', 'Channels', 'Messages'] as const).map((section) => {
            const items = (inbox.data?.conversations ?? []).filter((item) => (section === 'Favorites' ? item.favorite : section === 'Channels' ? !item.favorite && item.kind === 'channel' : !item.favorite && item.kind !== 'channel') && item.name.toLowerCase().includes(filter.toLowerCase()))
            return items.length ? <section key={section}><h2>{section}</h2>{items.map((item) => <button type="button" key={item.id} className={`sphere-conversation ${conversationId === item.id ? 'is-active' : ''}`} onClick={() => openConversation(item.id)} aria-current={conversationId === item.id ? 'page' : undefined}>
              {item.kind === 'channel' ? <span className="sphere-avatar"><Hash size={20} /></span> : <Avatar name={item.name} photoPath={item.avatar?.photoPath} />}<span><strong>{item.name}</strong><small>{item.archived ? 'Archived · ' : ''}{item.latest?.body || 'Start the conversation'}</small></span>{item.unread > 0 ? <b className="sphere-badge">{item.unread > 99 ? '99+' : item.unread}</b> : item.muted ? <BellOff size={14} /> : null}
            </button>)}</section> : null
          })}
          {!inbox.isPending && !inbox.data?.conversations.length ? <div className="sphere-empty-small"><p>A conversation starts with hello.</p><button type="button" onClick={() => setNewOpen(true)}>Find someone to message</button></div> : null}
        </div><p className="sphere-nav-note">Messages stay separate from tickets and system alerts.</p>
      </nav>
      {view !== 'chats' ? <div className="sphere-main"><header className="sphere-chat-header"><button className="sphere-mobile-back" type="button" aria-label="Back to chats" onClick={() => setView('chats')}><ArrowLeft size={19} /></button><h2>{view === 'saved' ? 'Saved messages' : 'Search messages'}</h2></header>{view === 'search' ? <form className="sphere-search-form" onSubmit={(event) => { event.preventDefault(); setSearchQuery(search.trim()) }}><label className="sphere-search"><Search size={18} /><input aria-label="Search message history" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search words or an exact phrase…" /></label><button type="submit" className="sphere-primary" disabled={search.trim().length < 2}>Search</button></form> : null}
        <SphereResults employeeId={employeeId} query={searchQuery} saved={view === 'saved'} onOpen={(message) => { setView('chats'); navigate(spherePath(message.conversationId, message.id, message.parentId)) }} />
      </div> : conversation ? <>
        <div className="sphere-main"><header className="sphere-chat-header"><button className="sphere-mobile-back" aria-label="Back to conversations" type="button" onClick={() => { navigate('/sygsphere'); try { localStorage.removeItem(`sygsphere.last:${employeeId}`) } catch { /* Optional preference. */ } }}><ArrowLeft size={20} /></button><div><h2>{conversation.kind === 'channel' ? '# ' : ''}{conversation.name}</h2><p>{conversation.archived ? 'Archived · Read-only' : conversation.kind === 'direct' ? 'Direct conversation' : conversation.kind === 'channel' ? 'Private team channel' : 'Group conversation'}</p></div><button type="button" aria-label="Conversation details" aria-pressed={details} onClick={() => setDetails(!details)}><Info size={20} /></button></header>
          <ConversationMessages key={conversation.id} employeeId={employeeId} conversation={conversation} allowRead={!threadId} focusId={threadId ? null : focusId} onThread={(message) => navigate(spherePath(conversation.id, undefined, message.id))} />
        </div>
        {threadId ? <aside className="sphere-detail sphere-thread"><header className="sphere-chat-header"><h2>Thread</h2><button type="button" aria-label="Close thread" onClick={() => navigate(spherePath(conversation.id))}><X size={20} /></button></header><ConversationMessages key={`${conversation.id}:${threadId}`} employeeId={employeeId} conversation={conversation} parentId={threadId} focusId={focusId} onThread={() => undefined} /></aside> : details ? <SphereDetails employeeId={employeeId} conversation={conversation} onClose={() => setDetails(false)} /> : null}
      </> : <div className="sphere-welcome"><img src="/branding/sygsphere-emblem.png" alt="" /><span className="sphere-eyebrow">WELCOME TO SYGSPHERE</span><h2>Good work starts with<br />a conversation.</h2><p>Connect with anyone in SygShift. Keep your team’s messages, decisions and shared work together.</p><button className="sphere-primary" type="button" onClick={() => setNewOpen(true)}><Plus size={18} /> Start a conversation</button>{conversationId ? <p role="status">That conversation is no longer available to your account.</p> : null}</div>}
    </div>
    {newOpen ? <NewConversation employeeId={employeeId} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); openConversation(id) }} /> : null}
  </section>
}

function NewConversation({ employeeId, onClose, onCreated }: { employeeId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState('direct')
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SpherePerson[]>([])
  const directory = useQuery({ queryKey: ['sygsphere', employeeId, 'directory', query], queryFn: () => sphereDirectory(query), staleTime: 30000 })
  const create = useMutation({ mutationFn: () => sphereCreate({ kind, name, members: selected.map((item) => item.id) }), onSuccess: async (data) => { await queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] }); onCreated(data.id) } })
  return <ModalDialog title="Start a conversation" description="Find anyone with an active SygShift account." className="sphere-modal" onClose={onClose} busy={create.isPending}>
    <form className="sphere-form" onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
      <label>Conversation type<select value={kind} onChange={(event) => { setKind(event.target.value); if (event.target.value === 'direct') setSelected((current) => current.slice(0, 1)) }}><option value="direct">Direct message</option><option value="group">Group message</option><option value="channel">Team channel</option></select></label>
      {kind !== 'direct' ? <label>{kind === 'channel' ? 'Channel' : 'Group'} name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="For example, Dispatch coordination" /></label> : null}
      <label>Find people<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or username…" /></label>
      <div className="sphere-selected">{selected.map((person) => <button type="button" key={person.id} onClick={() => setSelected(selected.filter((item) => item.id !== person.id))}>{person.name}<X size={14} /></button>)}</div>
      <div className="sphere-people-list">{directory.data?.filter((person) => person.id !== employeeId).map((person) => <label className="sphere-person" key={person.id}><input type="checkbox" checked={selected.some((item) => item.id === person.id)} onChange={(event) => setSelected(event.target.checked ? kind === 'direct' ? [person] : [...selected, person] : selected.filter((item) => item.id !== person.id))} /><Avatar name={person.name} photoPath={person.photoPath} /><span><strong>{person.name}</strong><small>@{person.username} · {person.role?.replaceAll('_', ' ')}</small></span></label>)}{directory.isPending ? <p role="status">Finding people…</p> : directory.data?.length === 0 ? <p>No account holders match. Try another name.</p> : null}</div>
      <ErrorNotice error={directory.error || create.error} /><p className="sphere-hint">Only participants can access this conversation. New participants will be able to read its history.</p>
      <footer><button type="button" onClick={onClose} disabled={create.isPending}>Cancel</button><button className="sphere-primary" type="submit" disabled={create.isPending || !selected.length || (kind !== 'direct' && !name.trim())}>Create {kind === 'channel' ? 'channel' : 'conversation'}</button></footer>
    </form>
  </ModalDialog>
}

function ConversationMessages({ employeeId, conversation, parentId = null, focusId, onThread, allowRead = true }: { employeeId: string; conversation: SphereConversation; parentId?: string | null; focusId: string | null; onThread: (message: SphereMessage) => void; allowRead?: boolean }) {
  const queryClient = useQueryClient()
  const listRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const messages = useInfiniteQuery({ queryKey: ['sygsphere', employeeId, 'messages', conversation.id, parentId], queryFn: ({ pageParam }) => sphereMessages(conversation.id, parentId, pageParam), initialPageParam: undefined as number | undefined, getNextPageParam: (last) => last.length === 50 ? last[0]?.sequence : undefined, refetchInterval: 30000 })
  const context = useQuery({ queryKey: ['sygsphere', employeeId, 'conversation', conversation.id], queryFn: () => sphereConversation(conversation.id), refetchInterval: 5000 })
  const root = useQuery({ queryKey: ['sygsphere', employeeId, 'message', conversation.id, parentId], queryFn: () => sphereMessage(conversation.id, parentId!), enabled: Boolean(parentId) })
  const focus = useQuery({ queryKey: ['sygsphere', employeeId, 'message', conversation.id, focusId], queryFn: () => sphereMessage(conversation.id, focusId!), enabled: Boolean(focusId) })
  const items = messages.data?.pages.slice().reverse().flat() ?? []
  const newestId = items.at(-1)?.id
  const displayed = [...(root.data ? [root.data] : []), ...items, ...(focus.data ? [focus.data] : [])]
  const author = (message: SphereMessage) => context.data?.members.find((person) => person.id === message.authorId)
  const unreadIds = displayed.filter((item) => !item.read).map((item) => item.id).slice(0, 100).sort().join(',')
  useEffect(() => { const change = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change) }, [])
  useEffect(() => {
    if (!visible || !allowRead || !unreadIds || !listRef.current || typeof IntersectionObserver === 'undefined') return
    const unread = new Set(unreadIds.split(',')); const seen = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) { const id = entry.target.id.replace('sphere-message-', ''); if (entry.isIntersecting && unread.has(id)) seen.add(id) }
      if (!timer && seen.size) timer = setTimeout(() => {
        timer = undefined; const messageIds = [...seen]; seen.clear()
        void sphereRequest('read', { conversationId: conversation.id, messageIds }).then(() => queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] })).catch(() => undefined)
      }, 450)
    }, { root: listRef.current, threshold: 0.25 })
    listRef.current.querySelectorAll('article[id^="sphere-message-"]').forEach((node) => observer.observe(node))
    return () => { observer.disconnect(); if (timer) clearTimeout(timer) }
  }, [unreadIds, visible, allowRead, conversation.id, employeeId, queryClient])
  useEffect(() => { if (atBottom && !focusId) tailRef.current?.scrollIntoView({ block: 'nearest' }) }, [newestId, atBottom, focusId])
  const typing = context.data?.members.filter((person) => person.id !== employeeId && person.typing).map((person) => person.name)
  if (messages.isError || context.isError) return <div className="sphere-form"><ErrorNotice error={messages.error || context.error} /><button type="button" onClick={() => { void messages.refetch(); void context.refetch() }}>Try again</button></div>
  return <>
    <div className="sphere-message-list" ref={listRef} onScroll={() => { const node = listRef.current; if (node) setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 100) }}>
      {messages.hasNextPage ? <button className="sphere-load" type="button" disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{messages.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}</button> : null}
      {root.data ? <div className="sphere-thread-root"><MessageCard employeeId={employeeId} message={root.data} author={author(root.data)} onThread={() => undefined} hideReply /></div> : null}
      <ErrorNotice error={root.error || focus.error} />
      {focus.data && !items.some((item) => item.id === focus.data.id) && focus.data.id !== root.data?.id ? <div className="sphere-focused"><p>Linked message</p><MessageCard employeeId={employeeId} message={focus.data} author={author(focus.data)} onThread={onThread} hideReply={Boolean(parentId)} /></div> : null}
      {messages.isPending ? <p role="status">Loading messages…</p> : !items.length ? <div className="sphere-empty-small"><MessageCircle size={28} /><p>{parentId ? 'Be the first to reply in this thread.' : 'You’re all set. Say hello to start things off.'}</p></div> : null}
      {items.map((message) => <MessageCard key={message.id} employeeId={employeeId} message={message} author={author(message)} onThread={onThread} hideReply={Boolean(parentId)} focused={message.id === focusId} />)}<div ref={tailRef} />
    </div>
    {!atBottom ? <button className="sphere-jump" type="button" onClick={() => { setAtBottom(true); tailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }}><ChevronDown size={16} /> Latest messages</button> : null}
    <div className="sphere-typing" aria-live="polite">{typing?.length ? `${typing.join(', ')} ${typing.length === 1 ? 'is' : 'are'} typing…` : ''}</div>
    {conversation.archived || root.data?.deleted ? <p className="sphere-nav-note">{conversation.archived ? 'This conversation is archived. An owner can reopen it.' : 'This message was deleted. Start a new conversation message instead.'}</p> : <SphereComposer key={`${conversation.id}:${parentId}`} employeeId={employeeId} conversationId={conversation.id} parentId={parentId} members={context.data?.members ?? []} />}
  </>
}

function MessageCard({ employeeId, message, author, onThread, hideReply = false, focused = false }: { employeeId: string; message: SphereMessage; author?: SpherePerson; onThread: (message: SphereMessage) => void; hideReply?: boolean; focused?: boolean }) {
  const queryClient = useQueryClient()
  const [edit, setEdit] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [body, setBody] = useState(message.body)
  const [notice, setNotice] = useState('')
  const mutation = useMutation({ mutationFn: ({ action, ...input }: { action: string; [key: string]: unknown }) => sphereRequest(action, { conversationId: message.conversationId, messageId: message.id, ...input }), onSuccess: async () => { setEdit(false); setDeleting(false); await queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] }) } })
  return <article className={`sphere-message ${message.authorId === employeeId ? 'sphere-message--mine' : ''} ${focused ? 'sphere-focused' : ''}`} id={`sphere-message-${message.id}`}>
    <Avatar name={message.authorName} photoPath={author?.photoPath} /><div className="sphere-message__content"><header><strong>{message.authorName}</strong><time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>{message.editedAt && !message.deleted ? <small>Edited</small> : null}{message.pinned && !message.deleted ? <small>📌 Pinned</small> : null}</header>
      {message.deleted ? <p className="sphere-hint">This message was deleted.</p> : <><MessageBody text={message.body} mentions={message.mentions} employeeId={employeeId} />
        {message.body.startsWith('Shared file: ') ? <MessageFiles employeeId={employeeId} message={message} /> : null}
        <div className="sphere-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} aria-pressed={reaction.mine} aria-label={`${reaction.emoji} reaction, ${reaction.count}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'react', emoji: reaction.emoji, enabled: !reaction.mine })}>{reaction.emoji} {reaction.count}</button>)}</div>
        <div className="sphere-message-actions">{!hideReply ? <button type="button" onClick={() => onThread(message)}><MessageCircle size={14} />{message.replyCount ? `${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply'}{message.unreadReplies > 0 ? <span className="sphere-unread-dot" aria-label="Unread replies" /> : null}</button> : null}
          <MessageActionPopover label="Add reaction" trigger={<Smile size={16} />} panelClassName="sphere-reaction-picker">{reactions.map((emoji) => <button type="button" key={emoji} aria-label={`React ${emoji}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'react', emoji, enabled: true })}>{emoji}</button>)}</MessageActionPopover>
          <button type="button" aria-label={message.saved ? 'Unsave message' : 'Save message'} aria-pressed={message.saved} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'save', enabled: !message.saved })}><Bookmark size={15} /></button>
          <MessageActionPopover label="More message actions" trigger="•••" panelClassName="sphere-message-menu"><button type="button" onClick={() => mutation.mutate({ action: 'pin', enabled: !message.pinned })}>{message.pinned ? 'Unpin message' : 'Pin message'}</button><button type="button" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}${spherePath(message.conversationId, message.id, message.parentId)}`).then(() => setNotice('Message link copied.')).catch(() => setNotice('Could not copy. Open the message and copy its page address.')) }}>Copy message link</button>{message.authorId === employeeId ? <><button type="button" onClick={() => { setBody(message.body); setEdit(true) }}>Edit message</button><button type="button" onClick={() => setDeleting(true)}>Delete message</button></> : null}</MessageActionPopover>
          {message.authorId === employeeId ? <span className="sphere-delivery" title={message.readBy.length ? `Read by ${message.readBy.map((person) => person.name).join(', ')}` : 'Saved securely to SygSphere'}><Check size={13} />{message.readBy.length ? `Read by ${message.readBy.length}` : 'Sent'}</span> : null}
        </div></>}
      <ErrorNotice error={mutation.error} />{notice ? <small role="status">{notice}</small> : null}
    </div>
    {edit ? <ModalDialog title="Edit message" onClose={() => setEdit(false)} className="sphere-modal" busy={mutation.isPending}><form className="sphere-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate({ action: 'edit', body, mentionIds: sphereActiveMentions(body, message.mentions).map((mention) => mention.id) }) }}><label>Message<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={12000} autoFocus /></label><p className="sphere-hint">An edited label will appear. Removing a selected @mention also removes its notification. Previous versions remain in the protected history.</p><ErrorNotice error={mutation.error} /><footer><button type="button" onClick={() => setEdit(false)}>Cancel</button><button type="submit" className="sphere-primary" disabled={!body.trim() || mutation.isPending}>Save changes</button></footer></form></ModalDialog> : null}
    {deleting ? <ModalDialog title="Delete this message?" onClose={() => setDeleting(false)} className="sphere-modal" busy={mutation.isPending}><div className="sphere-form"><p>The conversation will show a deletion marker. This does not erase the protected revision history.</p><ErrorNotice error={mutation.error} /><footer><button type="button" onClick={() => setDeleting(false)}>Keep message</button><button className="sphere-primary" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'delete' })}>Delete message</button></footer></div></ModalDialog> : null}
  </article>
}

function SphereComposer({ employeeId, conversationId, parentId, members }: { employeeId: string; conversationId: string; parentId: string | null; members: SpherePerson[] }) {
  const queryClient = useQueryClient()
  const key = sphereDraftKey(employeeId, conversationId, parentId)
  const [draft, setDraft] = useState(() => readSphereDraft(key))
  const [storageAvailable, setStorageAvailable] = useState(true)
  const [mention, setMention] = useState(false)
  const [file, setFile] = useState<{ file: File; id: string } | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastTyping = useRef(0)
  const send = useMutation({ mutationFn: () => sphereSend({ conversationId, parentId, ...draft }), onSuccess: async () => {
    const empty = { body: '', clientId: crypto.randomUUID(), mentions: [] }; setDraft(empty); writeSphereDraft(key, empty)
    await queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] }); inputRef.current?.focus()
  } })
  const upload = useMutation({ mutationFn: async () => { if (file) await sphereUpload(file.file, file.id, conversationId, parentId, setUploadProgress) }, onSuccess: async () => { setFile(null); setUploadProgress(0); await queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] }) } })
  function change(body: string, mentions = draft.mentions) {
    if (send.isPending) return
    const limited = body.slice(0, 12000)
    const next = { body: limited, clientId: send.isError ? crypto.randomUUID() : draft.clientId, mentions: sphereActiveMentions(limited, mentions) }
    setDraft(next); setStorageAvailable(writeSphereDraft(key, next)); if (send.isError) send.reset()
    if (Date.now() - lastTyping.current > 4000) { lastTyping.current = Date.now(); void sphereRequest('typing', { conversationId, typing: Boolean(body.trim()) }).catch(() => undefined) }
  }
  function submit(event?: FormEvent) { event?.preventDefault(); if (!send.isPending && draft.body.trim()) send.mutate() }
  return <form className="sphere-composer" onSubmit={submit}>
    <textarea aria-label={parentId ? 'Write a thread reply' : 'Write a message'} ref={inputRef} value={draft.body} onChange={(event) => change(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} placeholder={parentId ? 'Add your reply…' : 'Write a message…'} maxLength={12000} disabled={send.isPending} />
    <div className="sphere-composer-tools"><div><button type="button" aria-label="Attach a file" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button><button type="button" aria-label="Mention a participant" aria-expanded={mention} onClick={() => setMention(!mention)}>@</button><button type="button" aria-label="Add a smile" onClick={() => { change(`${draft.body} 🙂`); inputRef.current?.focus() }}><Smile size={19} /></button><small>Enter to send · Shift + Enter for a new line</small></div><button type="submit" className="sphere-primary" disabled={!draft.body.trim() || send.isPending}><Send size={17} />{send.isPending ? 'Sending…' : send.isError ? 'Retry send' : 'Send'}</button></div>
    <input ref={fileInput} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.docx,.xlsx" onChange={(event) => { const chosen = event.target.files?.[0]; if (chosen) { setFile({ file: chosen, id: crypto.randomUUID() }); setUploadProgress(0); upload.reset() } event.target.value = '' }} />
    {file ? <ModalDialog title="Share a file" description="Only participants in this conversation can download it." className="sphere-modal" busy={upload.isPending} busyLabel={uploadProgress > 90 ? 'Security-checking the file before sharing…' : `Uploading securely… ${uploadProgress}%`} onClose={() => setFile(null)}><div className="sphere-form"><strong>{file.file.name}</strong><p>{(file.file.size / 1048576).toFixed(2)} MB · Maximum 100 MB</p><p className="sphere-hint">PDF, images, text, DOCX and XLSX are supported through 25 MB. JPEG, PNG and WebP images can be as large as 100 MB. Every file is checked before anyone can download it; larger files remain download-only to protect mobile devices. Your message draft stays in place.</p>{upload.isPending ? <progress aria-label="File upload and security check progress" max="100" value={uploadProgress}>{uploadProgress}%</progress> : null}<ErrorNotice error={upload.error} /><footer><button type="button" disabled={upload.isPending} onClick={() => setFile(null)}>Cancel</button><button type="button" className="sphere-primary" disabled={upload.isPending || file.file.size > 104857600 || file.file.size < 1} onClick={() => upload.mutate()}>{upload.isError ? 'Retry sharing' : 'Share file'}</button></footer></div></ModalDialog> : null}
    {mention ? <div className="sphere-mention-list" aria-label="Conversation participants">{members.filter((person) => person.id !== employeeId && person.active && person.username).map((person) => <button key={person.id} type="button" onClick={() => { const token = `@${person.username}`; change(`${draft.body}${draft.body.endsWith(' ') || !draft.body ? '' : ' '}${token} `, [...draft.mentions, { id: person.id, name: person.name, username: person.username! }]); setMention(false); inputRef.current?.focus() }}><Avatar name={person.name} photoPath={person.photoPath} /><span><strong>{person.name}</strong><small>@{person.username}</small></span></button>)}</div> : null}
    <ErrorNotice error={send.error} />{send.isError ? <p className="sphere-hint">Your draft is safe here. Retry uses the same send identifier to prevent duplicates.</p> : null}
    {!storageAvailable ? <p className="sphere-error">Device storage is unavailable. Keep this page open until you send your draft.</p> : null}
  </form>
}

function SphereResults({ employeeId, query, saved, onOpen }: { employeeId: string; query: string; saved: boolean; onOpen: (message: SphereMessage) => void }) {
  const results = useInfiniteQuery({ queryKey: ['sygsphere', employeeId, saved ? 'saved' : 'search', query], queryFn: ({ pageParam }) => sphereSearch(query, saved, pageParam), initialPageParam: undefined as number | undefined, getNextPageParam: (last) => last.length === 50 ? last.at(-1)?.sequence : undefined, enabled: saved || query.length >= 2 })
  const items = results.data?.pages.flat() ?? []
  return <div className="sphere-results"><ErrorNotice error={results.error} />{results.isFetching ? <p role="status">Loading…</p> : null}{items.map((message) => <button type="button" className="sphere-result" key={message.id} onClick={() => onOpen(message)}><strong>{message.authorName}</strong><small>{messageTime(message.createdAt)}{message.parentId ? ' · Thread reply' : ''}</small><span>{message.body}</span><b>Open message →</b></button>)}{!results.isFetching && !items.length ? <p>{saved ? 'Save a message using its bookmark button to find it here.' : query ? 'No messages match your search.' : 'Search the conversations you belong to.'}</p> : null}{results.hasNextPage ? <button type="button" onClick={() => void results.fetchNextPage()} disabled={results.isFetchingNextPage}>Load more results</button> : null}</div>
}

function SphereDetails({ employeeId, conversation, onClose }: { employeeId: string; conversation: SphereConversation; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'about' | 'members' | 'pins' | 'files'>('about')
  const [add, setAdd] = useState(false)
  const [name, setName] = useState(conversation.name)
  const [description, setDescription] = useState(conversation.description)
  const [query, setQuery] = useState('')
  const [confirmPerson, setConfirmPerson] = useState<{ person: SpherePerson; operation: string } | null>(null)
  const navigate = useNavigate()
  const context = useQuery({ queryKey: ['sygsphere', employeeId, 'conversation', conversation.id], queryFn: () => sphereConversation(conversation.id), refetchInterval: 30000 })
  const directory = useQuery({ queryKey: ['sygsphere', employeeId, 'directory', query], queryFn: () => sphereDirectory(query), enabled: add })
  const pins = useQuery({ queryKey: ['sygsphere', employeeId, 'pins', conversation.id], queryFn: () => sphereMessages(conversation.id, null, undefined, true), enabled: tab === 'pins' })
  const mutation = useMutation({ mutationFn: ({ action, ...input }: { action: string; [key: string]: unknown }) => sphereRequest(action, { conversationId: conversation.id, ...input }), onSuccess: async () => { setConfirmPerson(null); await queryClient.invalidateQueries({ queryKey: ['sygsphere', employeeId] }) } })
  return <aside className="sphere-detail"><header className="sphere-chat-header"><h2>Conversation details</h2><button type="button" aria-label="Close details" onClick={onClose}><X size={19} /></button></header><div className="sphere-tabs">{(['about', 'members', 'pins', 'files'] as const).map((item) => <button type="button" key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div><div className="sphere-detail-body">
    <ErrorNotice error={context.error || mutation.error || pins.error} />
    {tab === 'about' ? <div className="sphere-form"><h3>{conversation.name}</h3><p>{conversation.description || 'A shared space to keep the conversation moving.'}</p><label className="sphere-check"><input type="checkbox" checked={conversation.favorite} disabled={mutation.isPending} onChange={(event) => mutation.mutate({ action: 'settings', favorite: event.target.checked })} /> Keep in Favorites</label><label className="sphere-check"><input type="checkbox" checked={conversation.muted} disabled={mutation.isPending} onChange={(event) => mutation.mutate({ action: 'settings', muted: event.target.checked })} /> Mute conversation alerts</label><p className="sphere-hint">Muted conversations still show unread messages. Only participants can read this conversation, including its shared history.</p>
      {conversation.owner && conversation.kind !== 'direct' ? <><label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></label><button type="button" disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate({ action: 'rename', name, description })}>Save details</button><button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'archive', archived: !conversation.archived })}>{conversation.archived ? 'Reopen conversation' : 'Archive (keep history)'}</button></> : null}
    </div> : tab === 'members' ? <><h3><Users size={18} /> {context.data?.members.length ?? 0} participants</h3>{context.data?.members.map((person) => <div className="sphere-member" key={person.id}><Avatar name={person.name} photoPath={person.photoPath} /><div><strong>{person.name}</strong><small><span className={`sphere-presence sphere-presence--${person.presence}`} />{person.active ? person.presence : 'Account inactive'}{person.owner ? ' · Owner' : ''}</small>{conversation.kind !== 'direct' && (conversation.owner || person.id === employeeId) ? <div className="sphere-member-actions">{conversation.owner && !person.owner ? <button type="button" onClick={() => setConfirmPerson({ person, operation: 'owner' })}>Make owner</button> : null}<button type="button" onClick={() => setConfirmPerson({ person, operation: 'remove' })}>{person.id === employeeId ? 'Leave' : 'Remove'}</button></div> : null}</div></div>)}
      {conversation.owner && conversation.kind !== 'direct' ? <><button type="button" onClick={() => setAdd(!add)}><Plus size={17} /> Add people</button>{add ? <div className="sphere-form"><label>Find account holder<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people…" /></label><ErrorNotice error={directory.error} /><div className="sphere-people-list">{directory.data?.filter((person) => !context.data?.members.some((member) => member.id === person.id)).map((person) => <button type="button" key={person.id} onClick={() => setConfirmPerson({ person, operation: 'add' })}>{person.name}</button>)}</div></div> : null}</> : null}
    </> : tab === 'files' ? <SharedFiles employeeId={employeeId} conversationId={conversation.id} /> : <>{pins.data?.map((message) => <button className="sphere-result" key={message.id} type="button" onClick={() => navigate(spherePath(conversation.id, message.id, message.parentId))}><strong>{message.authorName}</strong><span>{message.body}</span><b>Open message →</b></button>)}{!pins.data?.length ? <p>No pinned messages yet. Use a message’s More menu to pin it.</p> : null}</>}
  </div>{confirmPerson ? <ModalDialog title={`${confirmPerson.operation === 'add' ? 'Add' : confirmPerson.operation === 'owner' ? 'Make owner:' : 'Remove'} ${confirmPerson.person.name}?`} className="sphere-modal" onClose={() => setConfirmPerson(null)} busy={mutation.isPending}><div className="sphere-form"><p>{confirmPerson.operation === 'add' ? 'This person will be able to read all conversation history and shared files. Only add them if that access is appropriate.' : confirmPerson.operation === 'owner' ? 'Owners can add and remove participants, change details and archive this conversation.' : 'Their access to this conversation and its files will end. Their previous messages will remain.'}</p><ErrorNotice error={mutation.error} /><footer><button type="button" onClick={() => setConfirmPerson(null)}>Cancel</button><button type="button" className="sphere-primary" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: 'members', employeeId: confirmPerson.person.id, operation: confirmPerson.operation })}>Confirm</button></footer></div></ModalDialog> : null}</aside>
}

function FileButton({ file }: { file: SphereFile }) {
  const download = useMutation({ mutationFn: () => sphereDownload(file) })
  const preview = useMutation<SpherePreview, Error>({ mutationFn: () => spherePreview(file) })
  useEffect(() => () => { if (preview.data && preview.data.kind !== 'text') URL.revokeObjectURL(preview.data.url) }, [preview.data])
  return <div className="sphere-file-row"><div className="sphere-file"><Paperclip size={19} /><span><strong>{file.filename}</strong><small>{(file.sizeBytes / 1048576).toFixed(2)} MB</small></span><div>
    {sphereCanPreview(file) ? <button type="button" disabled={preview.isPending} onClick={() => preview.mutate()}><Eye size={17} />{preview.isPending ? 'Opening…' : 'Preview'}</button> : null}
    <button type="button" disabled={download.isPending} onClick={() => download.mutate()}><Download size={17} />{download.isPending ? 'Downloading…' : 'Download'}</button>
  </div></div><ErrorNotice error={download.error || preview.error} />
  {preview.data ? <ModalDialog title={file.filename} description="Protected SygSphere preview" className="sphere-modal sphere-preview-modal" onClose={() => preview.reset()}><div className="sphere-preview">
    {preview.data.kind === 'text' ? <pre>{preview.data.text}</pre> : preview.data.kind === 'image' ? <img src={preview.data.url} alt={`Preview of ${file.filename}`} /> : <SecurePdfViewer title={file.filename} url={preview.data.url} />}
    <footer><button type="button" onClick={() => preview.reset()}>Close</button><button type="button" onClick={() => download.mutate()} disabled={download.isPending}><Download size={17} />Download</button></footer>
  </div></ModalDialog> : null}</div>
}
function MessageFiles({ employeeId, message }: { employeeId: string; message: SphereMessage }) {
  const files = useQuery({ queryKey: ['sygsphere', employeeId, 'message-files', message.id], queryFn: () => sphereFiles(message.conversationId, undefined, message.id) })
  return <><ErrorNotice error={files.error} />{files.data?.map((file) => <FileButton key={file.id} file={file} />)}</>
}
function SharedFiles({ employeeId, conversationId }: { employeeId: string; conversationId: string }) {
  const files = useInfiniteQuery({ queryKey: ['sygsphere', employeeId, 'files', conversationId], queryFn: ({ pageParam }) => sphereFiles(conversationId, pageParam), initialPageParam: undefined as string | undefined, getNextPageParam: (last) => last.length === 50 ? last.at(-1)?.createdAt : undefined })
  return <><h3>Shared files</h3><ErrorNotice error={files.error} />{files.data?.pages.flat().map((file) => <FileButton key={file.id} file={file} />)}{files.data?.pages[0]?.length === 0 ? <p>Files shared in this conversation appear here after their security scan.</p> : null}{files.hasNextPage ? <button type="button" disabled={files.isFetchingNextPage} onClick={() => void files.fetchNextPage()}>Load more files</button> : null}</>
}

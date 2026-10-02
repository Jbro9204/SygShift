import { type FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookOpenCheck,
  BriefcaseBusiness,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileCheck2,
  FilePenLine,
  Files,
  FilterX,
  HeartPulse,
  LogOut,
  ShieldAlert,
  Search,
  ShieldCheck,
  ShieldOff,
  UserPlus,
} from 'lucide-react'
import { DataStatePanel } from './DataStatePanel'
import { ModalDialog } from './ModalDialog'
import { SecurePdfViewer } from './SecurePdfViewer'
import {
  adoptHrDocumentLibrarySource,
  getHrDocumentLibrary,
  retireHrDocumentLibrarySource,
  type HrDocumentLibraryAudience,
  type HrDocumentLibraryFilters,
  type HrDocumentLibraryItem,
  type HrDocumentLibraryKind,
} from '../data/hrDocumentLibrary'
import { getHrDocumentBlob } from '../data/hrDocuments'
import {
  libraryAllowsWorkingCopy,
  libraryKindLabel,
  libraryPrimaryActionLabel,
} from '../lib/documentPresentation'

type PageSize = 5 | 10 | 20
type LibraryCollection = 'all' | 'forms' | 'learning'

const workIntents = [
  { icon: UserPlus, label: 'Hire or onboard', search: 'onboarding' },
  { icon: BriefcaseBusiness, label: 'Coach or correct', search: 'coaching' },
  { icon: HeartPulse, label: 'Leave or medical', search: 'medical' },
  { icon: BriefcaseBusiness, label: 'Pay or job change', search: 'payroll' },
  { icon: ShieldAlert, label: 'Incident or safety', search: 'incident' },
  { icon: LogOut, label: 'Separate employee', search: 'termination' },
] as const

const audienceLabels: Record<HrDocumentLibraryAudience, string> = {
  all_employees: 'Employee access',
  supervisors_and_hr: 'Supervisors & HR',
  hr_only: 'HR only',
}

const sensitivityLabels = {
  standard: 'Standard record',
  restricted: 'Restricted record',
  highly_restricted: 'Highly restricted',
} as const

const kindLabels: Record<HrDocumentLibraryKind, string> = {
  hr_source: 'HR source catalog', training_admin: 'Training administration', training_module: 'Training modules',
  document_guide: 'Use guides & policies', training_form: 'Training forms',
}

const lifecycleLabels = {
  adopted: 'Reviewed source',
  draft_for_adoption: 'Available source',
  retired: 'Retired source',
} as const

const learningKinds: HrDocumentLibraryKind[] = ['training_module', 'training_form', 'training_admin', 'document_guide']

function readableDocumentTitle(value: string): string {
  const cleaned = value.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || /[a-z].*[A-Z]|[A-Z].*[a-z]/.test(cleaned)) return cleaned || value
  return cleaned.toLocaleLowerCase().replace(/\b(?:hr|pdf|osha|fmla|i-9|w-4)\b|\b\w/g, (part) => {
    const acronym = part.toLocaleLowerCase()
    if (['hr', 'pdf', 'osha', 'fmla', 'i-9', 'w-4'].includes(acronym)) return acronym.toLocaleUpperCase()
    return part.toLocaleUpperCase()
  })
}

function sourceAccessNote(
  item: Pick<HrDocumentLibraryItem, 'availability' | 'lifecycleStatus'>,
  workingCopyAllowed: boolean,
): string {
  if (item.availability !== 'available') {
    return 'This catalog item is searchable, but its source file still needs to be connected before it can be reviewed.'
  }
  if (item.lifecycleStatus === 'draft_for_adoption') {
    return workingCopyAllowed
      ? 'Ready to use now. Answer the guided questions to create a completed copy; the original source stays unchanged.'
      : 'Ready to preview or download now. A separate approval is not required for reference use.'
  }
  if (item.lifecycleStatus === 'retired') {
    return 'This retired source remains available for historical reference. It cannot start new work.'
  }
  return workingCopyAllowed
    ? 'Ready to start as a new working copy. The adopted company source stays unchanged.'
    : 'Ready to preview or download as reference material. The adopted company source stays unchanged.'
}

export function HrDocumentLibrary({ collection, mode = 'employee', onUseDocument }: { collection?: LibraryCollection; mode?: 'employee' | 'studio' | 'training'; onUseDocument?: (file: File, title: string) => void }) {
  const queryClient = useQueryClient()
  const activeCollection: LibraryCollection = collection ?? (mode === 'training' ? 'learning' : mode === 'studio' ? 'forms' : 'all')
  const defaultKind: HrDocumentLibraryKind | undefined = activeCollection === 'forms'
    ? 'hr_source'
    : activeCollection === 'learning'
      ? mode === 'training' ? 'training_module' : 'document_guide'
      : undefined
  const [searchInput, setSearchInput] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<HrDocumentLibraryFilters>({ page: 1, pageSize: 10, kind: defaultKind })
  const [accessTarget, setAccessTarget] = useState<{ id: string; title: string } | null>(null)
  const [adoptionTarget, setAdoptionTarget] = useState<HrDocumentLibraryItem | null>(null)
  const [retirementTarget, setRetirementTarget] = useState<HrDocumentLibraryItem | null>(null)
  const [lifecycleNotice, setLifecycleNotice] = useState<string | null>(null)
  const query = useQuery({
    queryFn: () => getHrDocumentLibrary(filters),
    queryKey: ['hr-document-library', filters],
  })
  const workspace = query.data
  const useDocument = useMutation({
    mutationFn: async ({ documentId, title }: { documentId: string; title: string }) => {
      const result = await getHrDocumentBlob(documentId, 'download', 'Create an editable working copy from the company document library.')
      return { file: new File([result.blob], result.filename || `${title}.pdf`, { type: result.blob.type || 'application/pdf' }), title }
    },
    onSuccess: ({ file, title }) => onUseDocument?.(file, title),
  })
  const adoptSource = useMutation({
    mutationFn: (input: { libraryItemId: string; reason: string; sourceSha256: string; updatedAt: string }) => adoptHrDocumentLibrarySource(input),
    onSuccess: async () => {
      setLifecycleNotice('The exact source is now marked reviewed. It was already available for routine use.')
      setAdoptionTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['hr-document-library'] })
    },
  })
  const retireSource = useMutation({
    mutationFn: (input: { libraryItemId: string; reason: string; sourceSha256: string; updatedAt: string }) => retireHrDocumentLibrarySource(input),
    onSuccess: async () => {
      setLifecycleNotice('The source is retired. Existing records and assignments remain preserved.')
      setRetirementTarget(null)
      await queryClient.invalidateQueries({ queryKey: ['hr-document-library'] })
    },
  })

  useEffect(() => {
    if (workspace && (filters.page ?? 1) > Math.max(workspace.pagination.totalPages, 1)) {
      setFilters((current) => ({ ...current, page: Math.max(workspace.pagination.totalPages, 1) }))
    }
  }, [filters.page, workspace])

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setExpandedId(null)
    setFilters((current) => ({ ...current, page: 1, search: searchInput.trim() || undefined }))
  }

  function updateFilter<Key extends keyof HrDocumentLibraryFilters>(
    key: Key,
    value: HrDocumentLibraryFilters[Key],
  ) {
    setExpandedId(null)
    setFilters((current) => ({ ...current, [key]: value, page: 1 }))
  }

  function clearFilters() {
    setSearchInput('')
    setExpandedId(null)
    setFilters({ page: 1, pageSize: filters.pageSize ?? 10, kind: defaultKind })
  }

  function chooseIntent(search: string) {
    setSearchInput(search)
    setExpandedId(null)
    setFilters((current) => ({ ...current, category: undefined, page: 1, search }))
  }

  const hasFilters = Boolean(filters.search || filters.category || filters.audience || filters.kind !== defaultKind)
  const heading = activeCollection === 'forms' ? 'HR forms & source templates' : activeCollection === 'learning' ? 'Guides, policies & training' : 'Find a company document'
  const introduction = activeCollection === 'forms'
    ? 'Choose what you need, answer the form questions, and review the completed PDF. Available forms do not need one-by-one approval before use.'
    : activeCollection === 'learning'
      ? 'Use guides, policies, training modules, and training forms stay together here—separate from completed employee and company records.'
      : 'Search the company source catalog by name, code, purpose, or everyday wording. Each item shows its current approval status.'
  const itemLabel = activeCollection === 'forms' ? 'HR source items' : activeCollection === 'learning' ? 'Guides & learning' : 'Library sources'
  const resultLabel = activeCollection === 'forms' ? 'HR source items' : activeCollection === 'learning' ? 'guides, policies, and training items' : 'library sources'

  return (
    <section className={`hr-template-library hr-template-library--${mode}`}>
      <header className="hr-template-library__header">
        <div>
          <p className="eyebrow">Document Center</p>
          <h2>{heading}</h2>
          <p>{introduction}</p>
        </div>
        <div className="hr-template-library__version"><BookOpenCheck aria-hidden="true" size={22}/><span><strong>Guardianship index</strong><small>Version {workspace?.libraryVersion ?? '1.0'}</small></span></div>
      </header>

      {query.isPending ? <DataStatePanel icon={Files} title="Loading the document library"><p>Finding the forms available for your role.</p></DataStatePanel> : null}
      {query.isError ? <DataStatePanel icon={Search} tone="error" title="Document library unavailable"><p>{query.error instanceof Error ? query.error.message : 'The document library could not be loaded.'}</p></DataStatePanel> : null}

      {workspace ? <>
        <div className="hr-template-library__metrics">
          <article><Files aria-hidden="true"/><span>{itemLabel}</span><strong>{workspace.summary.visibleCount}</strong></article>
          <article><BookOpenCheck aria-hidden="true"/><span>Categories</span><strong>{workspace.summary.categoryCount}</strong></article>
          <article><FileCheck2 aria-hidden="true"/><span>Files available</span><strong>{workspace.summary.availableCount}</strong></article>
        </div>

        {activeCollection === 'forms' ? <div className="hr-template-library__intent-grid" aria-label="Common HR tasks">
          {workIntents.map(({ icon: Icon, label, search }) => <button className={filters.search === search ? 'active' : ''} key={search} onClick={() => chooseIntent(search)} type="button"><Icon aria-hidden="true" size={20}/><span>{label}</span></button>)}
        </div> : null}

        <div className="hr-template-library__notice">
          <ShieldCheck aria-hidden="true" size={20}/>
          <div><strong>{activeCollection === 'forms' ? 'Ready-to-use form catalog' : activeCollection === 'learning' ? 'Guides and learning stay separate' : 'Company source library'}</strong><span>{activeCollection === 'forms' ? 'Every available form can start a guided working copy. References open for preview or download; retired sources remain blocked.' : activeCollection === 'learning' ? 'Use these items for guidance, policy reference, or training—not as completed employee records.' : 'Every result is permission-checked and clearly identifies its type and review status.'}</span></div>
        </div>

        <div className="hr-template-library__filters">
          <form onSubmit={submitSearch}>
            <label htmlFor={`hr-template-search-${mode}`}>Search library</label>
            <div><Search aria-hidden="true" size={18}/><input id={`hr-template-search-${mode}`} maxLength={120} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search title, code, category, or purpose" value={searchInput}/></div>
            <button className="secondary-button" type="submit">Search</button>
          </form>
          <label>Category<select onChange={(event) => updateFilter('category', event.target.value || undefined)} value={filters.category ?? ''}><option value="">All categories</option>{workspace.categories.map((category) => <option key={category.name} value={category.name}>{category.name} ({category.count})</option>)}</select></label>
          {activeCollection === 'learning' ? <label>Material type<select onChange={(event) => updateFilter('kind', event.target.value as HrDocumentLibraryKind)} value={filters.kind ?? defaultKind}>{learningKinds.map((value)=><option key={value} value={value}>{kindLabels[value]}</option>)}</select></label> : activeCollection === 'all' ? <label>Type<select onChange={(event) => updateFilter('kind', (event.target.value || undefined) as HrDocumentLibraryKind | undefined)} value={filters.kind ?? ''}><option value="">All document types</option>{Object.entries(kindLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label> : null}
          {(workspace.permissions.canSeeSupervisor || workspace.permissions.canSeeHr) ? <label>Audience<select onChange={(event) => updateFilter('audience', (event.target.value || undefined) as HrDocumentLibraryAudience | undefined)} value={filters.audience ?? ''}><option value="">Everything I can access</option><option value="all_employees">Employee access</option>{workspace.permissions.canSeeSupervisor ? <option value="supervisors_and_hr">Supervisors &amp; HR</option> : null}{workspace.permissions.canSeeHr ? <option value="hr_only">HR only</option> : null}</select></label> : null}
          <label>Rows<select onChange={(event) => updateFilter('pageSize', Number(event.target.value) as PageSize)} value={filters.pageSize ?? 10}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label>
          {hasFilters ? <button className="secondary-button hr-template-library__clear" onClick={clearFilters} type="button"><FilterX aria-hidden="true" size={17}/>Clear</button> : null}
        </div>

        <div className="hr-template-library__result-summary" aria-live="polite"><span><strong>{workspace.summary.matchingCount}</strong> matching {resultLabel}</span><span>{workspace.pagination.totalCount ? `Page ${workspace.pagination.page} of ${workspace.pagination.totalPages}` : 'No pages'}</span></div>

        {workspace.items.length ? <div className="hr-template-library__list">
          {workspace.items.map((item) => {
            const expanded = expandedId === item.id
            const detailsId = `hr-template-library-details-${item.id}`
            const workingCopyAllowed = libraryAllowsWorkingCopy(item)
            const adoptionAllowed = workspace.permissions.canManage === true
              && item.availability === 'available'
              && item.lifecycleStatus === 'draft_for_adoption'
              && Boolean(item.sourceType && item.sourceType !== 'unclassified')
              && Boolean(item.sourceSha256 && item.updatedAt)
            const retirementAllowed = workspace.permissions.canManage === true
              && item.availability === 'available'
              && item.lifecycleStatus === 'adopted'
              && Boolean(item.sourceSha256 && item.updatedAt)
            const accessNote = sourceAccessNote(item, workingCopyAllowed)
            return <article className="hr-template-library__item" key={item.id}>
              <button aria-controls={detailsId} aria-expanded={expanded} className="hr-template-library__summary" onClick={() => setExpandedId(expanded ? null : item.id)} type="button">
                <span className="hr-template-library__code">{item.code}</span>
                <span className="hr-template-library__identity"><strong>{readableDocumentTitle(item.title)}</strong><small>{item.category}</small></span>
                <span className="hr-template-library__badges"><span className={`hr-template-library__kind is-${item.documentKind}`}>{libraryKindLabel(item)}</span><span className={`hr-template-library__availability is-${item.availability}`}>{item.availability === 'available' ? 'Source file ready' : 'Source file needed'}</span><span className={`hr-template-library__availability is-${item.lifecycleStatus}`}>{lifecycleLabels[item.lifecycleStatus]}</span></span>
                <ChevronDown aria-hidden="true" className={expanded ? 'rotated' : ''} size={20}/>
              </button>
              <div className="hr-template-library__details" hidden={!expanded} id={detailsId}>
                <div><small>What this document is for</small><p>{item.purpose}</p></div>
                <dl className="hr-template-library__essential-details">
                  <div><dt>Record class</dt><dd>{item.recordClass}</dd></div>
                  <div><dt>Document type</dt><dd>{kindLabels[item.documentKind]}</dd></div>
                  <div><dt>Source status</dt><dd>{lifecycleLabels[item.lifecycleStatus]}</dd></div>
                  <div><dt>Length</dt><dd>{item.pageCount ? `${item.pageCount} pages` : 'Not recorded'}</dd></div>
                </dl>
                <details className="hr-template-library__technical-details"><summary>Retrieval and source details</summary><dl><div><dt>Library code</dt><dd>{item.code}</dd></div><div><dt>Package section</dt><dd>{item.section}</dd></div><div><dt>Intended audience</dt><dd>{audienceLabels[item.audience]}</dd></div><div><dt>Handling</dt><dd>{sensitivityLabels[item.sensitivity]}</dd></div><div><dt>Controlled filename</dt><dd>{item.sourceFilename}</dd></div>{item.guideCode ? <div><dt>Related guide</dt><dd>{item.guideCode}</dd></div> : null}{item.relatedModules.length ? <div><dt>Related modules</dt><dd>{item.relatedModules.join(', ')}</dd></div> : null}</dl></details>
                <p className="hr-template-library__access-note">{accessNote}</p>
                {item.availability === 'available' && item.sourceDocumentId ? <div className="hr-template-library__actions">{onUseDocument && workingCopyAllowed?<button className="primary-action" disabled={useDocument.isPending} onClick={()=>useDocument.mutate({documentId:item.sourceDocumentId!,title:item.title})} type="button"><FilePenLine size={17}/>{libraryPrimaryActionLabel(item)}</button>:null}<button className={workingCopyAllowed ? 'secondary-button' : 'primary-action'} onClick={()=>setAccessTarget({id:item.sourceDocumentId!,title:item.title})} type="button"><Eye size={17}/>{workingCopyAllowed ? 'Preview source PDF' : libraryPrimaryActionLabel(item)}</button><button className="secondary-button" onClick={()=>void downloadLibraryItem(item.sourceDocumentId!,item.title)} type="button"><Download size={17}/>Download source file</button>{adoptionAllowed?<button className="secondary-button" onClick={()=>{setLifecycleNotice(null);adoptSource.reset();setAdoptionTarget(item)}} type="button"><FileCheck2 aria-hidden="true" size={17}/>Mark reviewed</button>:null}{retirementAllowed?<button className="quiet-danger-button" onClick={()=>{setLifecycleNotice(null);retireSource.reset();setRetirementTarget(item)}} type="button"><ShieldOff aria-hidden="true" size={17}/>Retire source</button>:null}</div> : null}
              </div>
            </article>
          })}
        </div> : <DataStatePanel icon={Search} title={`No ${resultLabel} match these filters`}><p>Try a broader term, another category, or clear the filters.</p></DataStatePanel>}

        <div className="hr-template-library__pagination">
          <button className="secondary-button" disabled={workspace.pagination.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: Math.max(1, (current.page ?? 1) - 1) }))} type="button"><ChevronLeft aria-hidden="true" size={17}/>Previous</button>
          <span>{workspace.pagination.totalCount ? `${workspace.pagination.page} of ${workspace.pagination.totalPages}` : 'No pages'}</span>
          <button className="secondary-button" disabled={workspace.pagination.page >= workspace.pagination.totalPages} onClick={() => setFilters((current) => ({ ...current, page: (current.page ?? 1) + 1 }))} type="button">Next<ChevronRight aria-hidden="true" size={17}/></button>
        </div>
      </> : null}
      {accessTarget ? <LibraryPreview documentId={accessTarget.id} onClose={()=>setAccessTarget(null)} title={accessTarget.title}/> : null}
      {adoptionTarget && adoptionTarget.sourceSha256 && adoptionTarget.updatedAt ? <SourceAdoptionDialog busy={adoptSource.isPending} error={adoptSource.error instanceof Error ? adoptSource.error.message : null} item={adoptionTarget} onAdopt={(reason)=>adoptSource.mutate({libraryItemId:adoptionTarget.id,reason,sourceSha256:adoptionTarget.sourceSha256!,updatedAt:adoptionTarget.updatedAt!})} onClose={()=>setAdoptionTarget(null)}/> : null}
      {retirementTarget && retirementTarget.sourceSha256 && retirementTarget.updatedAt ? <SourceRetirementDialog busy={retireSource.isPending} error={retireSource.error instanceof Error ? retireSource.error.message : null} item={retirementTarget} onClose={()=>setRetirementTarget(null)} onRetire={(reason)=>retireSource.mutate({libraryItemId:retirementTarget.id,reason,sourceSha256:retirementTarget.sourceSha256!,updatedAt:retirementTarget.updatedAt!})}/> : null}
      {lifecycleNotice ? <div className="toast toast--success" role="status">{lifecycleNotice}</div> : null}
      {useDocument.isError ? <div className="toast toast--error" role="alert">{useDocument.error instanceof Error ? useDocument.error.message : 'The working copy could not be opened.'}</div> : null}
    </section>
  )
}

function SourceRetirementDialog({ busy, error, item, onClose, onRetire }: { busy: boolean; error: string | null; item: HrDocumentLibraryItem; onClose: () => void; onRetire: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onRetire(reason.trim())
  }
  return <ModalDialog busy={busy} busyLabel="Retiring protected source…" className="hr-document-modal" description="Retirement stops new working copies and new training assignments while preserving completed work, prior assignments, and the protected audit history." onClose={onClose} title={`Retire ${item.code}`}>
    <form className="hr-document-adoption" onSubmit={submit}>
      <div className="hr-template-library__notice"><ShieldOff aria-hidden="true" size={20}/><div><strong>Stop future use of this source</strong><span>{item.title} · {libraryKindLabel(item)}. Existing records and assignments remain preserved.</span></div></div>
      <label>Retirement reason<textarea maxLength={1000} minLength={5} onChange={(event)=>setReason(event.target.value)} placeholder="Explain why this source must no longer be used for new work." required rows={4} value={reason}/></label>
      {error ? <div className="inline-alert" role="alert">{error}</div> : null}
      <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="danger-button" disabled={busy || reason.trim().length < 5} type="submit"><ShieldOff aria-hidden="true" size={17}/>Retire source</button></div>
    </form>
  </ModalDialog>
}

function SourceAdoptionDialog({ busy, error, item, onAdopt, onClose }: { busy: boolean; error: string | null; item: HrDocumentLibraryItem; onAdopt: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState('')
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onAdopt(reason.trim())
  }
  return <ModalDialog busy={busy} busyLabel="Recording source review…" className="hr-document-modal" description="This optional review mark records that an authorized manager formally reviewed the exact source. Available forms can already be completed without this step." onClose={onClose} title={`Mark ${item.code} reviewed`}>
    <form className="hr-document-adoption" onSubmit={submit}>
      <div className="hr-template-library__notice"><ShieldCheck aria-hidden="true" size={20}/><div><strong>Record an optional formal review</strong><span>{item.title} · {libraryKindLabel(item)}. Routine forms remain usable either way; training modules still require review before assignment.</span></div></div>
      <label>Review note<textarea maxLength={1000} minLength={5} onChange={(event)=>setReason(event.target.value)} placeholder="Record who reviewed this source and any relevant notes." required rows={4} value={reason}/></label>
      {error ? <div className="inline-alert" role="alert">{error}</div> : null}
      <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="primary-action" disabled={busy || reason.trim().length < 5} type="submit"><FileCheck2 aria-hidden="true" size={17}/>Mark reviewed</button></div>
    </form>
  </ModalDialog>
}

async function downloadLibraryItem(documentId:string,title:string){
  const file=await getHrDocumentBlob(documentId,'download','Authorized use of the controlled HR document library.')
  const url=URL.createObjectURL(file.blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename||`${title}.pdf`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}

function LibraryPreview({documentId,onClose,title}:{documentId:string;onClose:()=>void;title:string}){
  const [bytes,setBytes]=useState<Uint8Array|null>(null)
  const mutation=useMutation({mutationFn:async()=>{const file=await getHrDocumentBlob(documentId,'preview','Authorized review of the controlled HR document library.');return new Uint8Array(await file.blob.arrayBuffer())},onSuccess:setBytes})
  useEffect(()=>{mutation.mutate()},[documentId]) // eslint-disable-line react-hooks/exhaustive-deps
  return <ModalDialog busy={mutation.isPending} busyLabel="Opening protected PDF…" className="hr-document-modal" description="Access is permission-checked and recorded in the HR document audit history." onClose={onClose} title={title}>{mutation.isError?<DataStatePanel icon={ShieldCheck} tone="error" title="PDF unavailable"><p>{mutation.error instanceof Error?mutation.error.message:'The protected PDF could not be opened.'}</p></DataStatePanel>:null}{bytes?<><div className="hr-document-preview"><SecurePdfViewer bytes={bytes} title={title}/></div><div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close preview</button></div></>:null}</ModalDialog>
}

import { type FormEvent, useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
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
  UserPlus,
} from 'lucide-react'
import { DataStatePanel } from './DataStatePanel'
import { ModalDialog } from './ModalDialog'
import { SecurePdfViewer } from './SecurePdfViewer'
import {
  getHrDocumentLibrary,
  type HrDocumentLibraryAudience,
  type HrDocumentLibraryFilters,
  type HrDocumentLibraryKind,
} from '../data/hrDocumentLibrary'
import { getHrDocumentBlob } from '../data/hrDocuments'

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
  hr_source: 'HR document', training_admin: 'Training administration', training_module: 'Training module',
  document_guide: 'Document guide', training_form: 'Training form',
}

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

export function HrDocumentLibrary({ collection, mode = 'employee', onUseDocument }: { collection?: LibraryCollection; mode?: 'employee' | 'studio' | 'training'; onUseDocument?: (file: File, title: string) => void }) {
  const activeCollection: LibraryCollection = collection ?? (mode === 'training' ? 'learning' : mode === 'studio' ? 'forms' : 'all')
  const defaultKind: HrDocumentLibraryKind | undefined = activeCollection === 'forms' ? 'hr_source' : activeCollection === 'learning' ? 'training_module' : undefined
  const [searchInput, setSearchInput] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<HrDocumentLibraryFilters>({ page: 1, pageSize: 10, kind: defaultKind })
  const [accessTarget, setAccessTarget] = useState<{ id: string; title: string } | null>(null)
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
  const heading = activeCollection === 'forms' ? 'Choose what HR needs to do' : activeCollection === 'learning' ? 'Training and reference library' : 'Find a company document'
  const introduction = activeCollection === 'forms'
    ? 'Start with the task or search in plain language. Open a working copy, fill the detected fields, review it, then download, send, or file it.'
    : activeCollection === 'learning'
      ? 'Training courses, training forms, and reference guides stay together here—separate from forms used for employee actions.'
      : 'Search approved company documents by name, code, purpose, or everyday wording.'
  const itemLabel = activeCollection === 'forms' ? 'Working forms' : activeCollection === 'learning' ? 'Learning items' : 'Documents'
  const resultLabel = activeCollection === 'forms' ? 'working forms' : activeCollection === 'learning' ? 'learning items' : 'documents'

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
          <article><FileCheck2 aria-hidden="true"/><span>Files released</span><strong>{workspace.summary.availableCount}</strong></article>
        </div>

        {activeCollection === 'forms' ? <div className="hr-template-library__intent-grid" aria-label="Common HR tasks">
          {workIntents.map(({ icon: Icon, label, search }) => <button className={filters.search === search ? 'active' : ''} key={search} onClick={() => chooseIntent(search)} type="button"><Icon aria-hidden="true" size={20}/><span>{label}</span></button>)}
        </div> : null}

        <div className="hr-template-library__notice">
          <ShieldCheck aria-hidden="true" size={20}/>
          <div><strong>{activeCollection === 'forms' ? 'Working HR forms only' : activeCollection === 'learning' ? 'Learning material stays separate' : 'Approved company library'}</strong><span>{activeCollection === 'forms' ? 'Training handouts and completed employee records are not mixed into these results.' : activeCollection === 'learning' ? 'Use these items for learning and reference, not for filing a new employee action.' : 'Every result is permission-checked before it opens.'}</span></div>
        </div>

        <div className="hr-template-library__filters">
          <form onSubmit={submitSearch}>
            <label htmlFor={`hr-template-search-${mode}`}>Search library</label>
            <div><Search aria-hidden="true" size={18}/><input id={`hr-template-search-${mode}`} maxLength={120} onChange={(event) => setSearchInput(event.target.value)} placeholder="What do you need help with?" value={searchInput}/></div>
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
            return <article className="hr-template-library__item" key={item.id}>
              <button aria-expanded={expanded} className="hr-template-library__summary" onClick={() => setExpandedId(expanded ? null : item.id)} type="button">
                <span className="hr-template-library__code">{item.code}</span>
                <span className="hr-template-library__identity"><strong>{readableDocumentTitle(item.title)}</strong><small>{item.category}</small></span>
                <span className={`hr-template-library__availability is-${item.availability}`}>{item.availability === 'available' ? 'Ready to use' : 'Needs file'}</span>
                <ChevronDown aria-hidden="true" className={expanded ? 'rotated' : ''} size={20}/>
              </button>
              {expanded ? <div className="hr-template-library__details">
                <div><small>What this document is for</small><p>{item.purpose}</p></div>
                <dl className="hr-template-library__essential-details">
                  <div><dt>Record class</dt><dd>{item.recordClass}</dd></div>
                  <div><dt>Document type</dt><dd>{kindLabels[item.documentKind]}</dd></div>
                  <div><dt>Length</dt><dd>{item.pageCount ? `${item.pageCount} pages` : 'Not recorded'}</dd></div>
                </dl>
                <details className="hr-template-library__technical-details"><summary>Document details</summary><dl><div><dt>Package section</dt><dd>{item.section}</dd></div><div><dt>Intended audience</dt><dd>{audienceLabels[item.audience]}</dd></div><div><dt>Handling</dt><dd>{sensitivityLabels[item.sensitivity]}</dd></div><div><dt>Controlled source</dt><dd>{item.sourceFilename}</dd></div></dl></details>
                <p className="hr-template-library__access-note">{item.availability === 'available' ? 'Ready to open as a new working copy. The company source stays unchanged.' : 'This item is searchable, but its PDF still needs to be connected before anyone can use it.'}</p>
                {item.availability === 'available' && item.sourceDocumentId ? <div className="hr-template-library__actions">{onUseDocument?<button className="primary-action" disabled={useDocument.isPending} onClick={()=>useDocument.mutate({documentId:item.sourceDocumentId!,title:item.title})} type="button"><FilePenLine size={17}/>Use this document</button>:null}<button className="secondary-button" onClick={()=>setAccessTarget({id:item.sourceDocumentId!,title:item.title})} type="button"><Eye size={17}/>Preview PDF</button><button className="secondary-button" onClick={()=>void downloadLibraryItem(item.sourceDocumentId!,item.title)} type="button"><Download size={17}/>Download</button></div> : null}
              </div> : null}
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
      {useDocument.isError ? <div className="toast toast--error" role="alert">{useDocument.error instanceof Error ? useDocument.error.message : 'The working copy could not be opened.'}</div> : null}
    </section>
  )
}

async function downloadLibraryItem(documentId:string,title:string){
  const file=await getHrDocumentBlob(documentId,'download','Authorized use of the controlled HR document library.')
  const url=URL.createObjectURL(file.blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename||`${title}.pdf`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}

function LibraryPreview({documentId,onClose,title}:{documentId:string;onClose:()=>void;title:string}){
  const [url,setUrl]=useState<string|null>(null)
  const mutation=useMutation({mutationFn:()=>getHrDocumentBlob(documentId,'preview','Authorized review of the controlled HR document library.'),onSuccess:(file)=>setUrl(URL.createObjectURL(file.blob))})
  useEffect(()=>{mutation.mutate()},[documentId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>()=>{if(url)URL.revokeObjectURL(url)},[url])
  return <ModalDialog busy={mutation.isPending} busyLabel="Opening protected PDF…" className="hr-document-modal" description="Access is permission-checked and recorded in the HR document audit history." onClose={onClose} title={title}>{mutation.isError?<DataStatePanel icon={ShieldCheck} tone="error" title="PDF unavailable"><p>{mutation.error instanceof Error?mutation.error.message:'The protected PDF could not be opened.'}</p></DataStatePanel>:null}{url?<><div className="hr-document-preview"><SecurePdfViewer title={title} url={url}/></div><div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">Close preview</button></div></>:null}</ModalDialog>
}

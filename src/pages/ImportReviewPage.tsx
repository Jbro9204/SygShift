import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Database,
  FileCheck2,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import {
  getImportCandidatesPage,
  getImportIssuesPage,
  getImportReviewSummary,
  resolveImportIssue,
  reviewImportCandidate,
  verifiedWorkbookBaseline,
  type CandidateDecision,
  type CandidateKind,
  type CandidateStatus,
  type ImportCandidate,
  type ImportIssue,
  type IssueSeverity,
  type SourceReference,
} from '../data/importReview'
import { isSupabaseConfigured } from '../lib/supabase'

const PAGE_SIZE = 25

const kindLabels: Record<CandidateKind, string> = {
  weekly_schedule: 'Weekly schedule',
  employee: 'Employee',
  site: 'Site or post',
  shift: 'Shift',
}

const decisionLabels: Record<CandidateDecision, string> = {
  accepted: 'Accept candidate',
  rejected: 'Reject candidate',
  superseded: 'Mark as duplicate',
}

type ReviewDialog =
  | { type: 'candidate'; candidate: ImportCandidate; decision: CandidateDecision }
  | { type: 'issue'; issue: ImportIssue }

type ReviewAction =
  | { type: 'candidate'; candidateId: string; decision: CandidateDecision; note: string }
  | { type: 'issue'; issueId: string; resolution: string }

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function sourceLabel(source: SourceReference): string {
  const location = [source.sheetName, source.address].filter(Boolean).join(' · ')
  if (location) return location
  return source.sheetIndex === undefined ? 'Source location recorded' : `Worksheet ${source.sheetIndex + 1}`
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function candidateTitle(candidate: ImportCandidate): string {
  const payload = candidate.payload
  if (candidate.kind === 'employee') return textValue(payload.name) ?? 'Employee record'
  if (candidate.kind === 'site') {
    const labels = Array.isArray(payload.labelVariants) ? payload.labelVariants : []
    return textValue(labels[0]) ?? textValue(payload.siteKeyCandidate) ?? 'Site or post record'
  }
  if (candidate.kind === 'shift') {
    const context = textValue(payload.contextLabel) ?? 'Shift'
    const date = textValue(payload.localDate)
    const startTime = textValue(payload.startTime)
    const endTime = textValue(payload.endTime)
    const time = startTime && endTime ? `${startTime}–${endTime}` : null
    return [context, date, time].filter(Boolean).join(' · ')
  }
  return textValue(payload.sourceSheetName) ?? textValue(payload.weekStartsOn) ?? 'Weekly schedule'
}

function SourceReferences({ references }: { references: SourceReference[] }) {
  if (references.length === 0) return <span>Source location unavailable</span>
  return (
    <span>
      {references.slice(0, 3).map(sourceLabel).join(' · ')}
      {references.length > 3 ? ` · ${references.length - 3} more` : ''}
    </span>
  )
}

function VerifiedStagingSummary() {
  const baseline = verifiedWorkbookBaseline
  return (
    <>
      <section className="import-status-card" aria-labelledby="verified-import-title">
        <div className="import-status-card__icon"><FileCheck2 aria-hidden="true" size={29} /></div>
        <div>
          <p className="eyebrow">Protected staging complete</p>
          <h2 id="verified-import-title">Every workbook cell is preserved and traceable.</h2>
          <p>
            The source workbook was loaded into protected staging, reviewed, and promoted into SygShift.
            The workbook remains available as audit evidence, but SygShift is now the operational source of truth.
          </p>
        </div>
        <span className="import-state-pill"><CheckCircle2 aria-hidden="true" size={17} /> Verified</span>
      </section>

      <section className="import-metrics" aria-label="Verified workbook totals">
        <article><span>Worksheets</span><strong>{formatNumber(baseline.sheetCount)}</strong><small>All source tabs</small></article>
        <article><span>Protected cells</span><strong>{formatNumber(baseline.sourceCellCount)}</strong><small>Values and formatting evidence</small></article>
        <article><span>Records found</span><strong>{formatNumber(baseline.candidateCount)}</strong><small>Schedules, people, sites, and shifts</small></article>
        <article><span>Historical questions</span><strong>{formatNumber(baseline.blockingIssueCount + baseline.warningCount)}</strong><small>Resolved during import</small></article>
      </section>

      <section className="import-breakdown" aria-labelledby="record-breakdown-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">What was found</p>
            <h2 id="record-breakdown-title">Records are already sorted into the right review lanes</h2>
          </div>
        </div>
        <div className="import-breakdown__grid">
          <div><strong>140</strong><span>Weekly schedules</span></div>
          <div><strong>56</strong><span>Employee records</span></div>
          <div><strong>82</strong><span>Site and post candidates</span></div>
          <div><strong>9,130</strong><span>Shift candidates</span></div>
        </div>
      </section>

      <DataStatePanel icon={Database} title="Ready for the secure Supabase connection" tone="setup">
        <p>
          This preview shows verified totals only. Private names, phone numbers, email addresses, license
          details, and schedules remain hidden until Supabase authentication is connected.
        </p>
        <ul>
          <li>Resolved source questions remain available as audit history.</li>
          <li>Each decision keeps the original cell location and an append-only audit entry.</li>
          <li>Operational work now happens in SygShift schedules, people, requests, and timekeeping.</li>
        </ul>
      </DataStatePanel>
    </>
  )
}

function ReviewMetrics({
  sourceCellCount,
  candidateCount,
  blockingIssueCount,
  warningCount,
}: {
  sourceCellCount: number
  candidateCount: number
  blockingIssueCount: number
  warningCount: number
}) {
  return (
    <section className="import-metrics" aria-label="Current import totals">
      <article><span>Protected cells</span><strong>{formatNumber(sourceCellCount)}</strong><small>Source evidence retained</small></article>
      <article><span>Candidate records</span><strong>{formatNumber(candidateCount)}</strong><small>Awaiting or reviewed</small></article>
      <article className={blockingIssueCount ? 'import-metric--attention' : ''}><span>Blocking questions</span><strong>{formatNumber(blockingIssueCount)}</strong><small>{blockingIssueCount ? 'Must reach zero' : 'Clear'}</small></article>
      <article><span>Warnings</span><strong>{formatNumber(warningCount)}</strong><small>Require a recorded decision</small></article>
    </section>
  )
}

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1
  const end = Math.min(total, (page + 1) * PAGE_SIZE)
  return (
    <div className="import-pagination" aria-label="Review results pages">
      <span>Showing {formatNumber(start)}–{formatNumber(end)} of {formatNumber(total)}</span>
      <div>
        <button className="secondary-button" disabled={page === 0} onClick={() => onPage(page - 1)} type="button">
          <ArrowLeft aria-hidden="true" size={17} /> Previous
        </button>
        <button className="secondary-button" disabled={end >= total} onClick={() => onPage(page + 1)} type="button">
          Next <ArrowRight aria-hidden="true" size={17} />
        </button>
      </div>
    </div>
  )
}

function IssueList({ issues, onReview }: { issues: ImportIssue[]; onReview: (dialog: ReviewDialog) => void }) {
  if (issues.length === 0) {
    return <DataStatePanel icon={CheckCircle2} title="No issues match these filters"><p>Change the filters or continue with candidate review.</p></DataStatePanel>
  }
  return (
    <div className="import-review-list">
      {issues.map((issue) => {
        const sources = [issue.source_reference, ...issue.related_sources].filter((source): source is SourceReference => Boolean(source))
        return (
          <article className={`import-review-card import-review-card--${issue.severity}`} key={issue.id}>
            <div className="import-review-card__heading">
              <div>
                <span className={`review-severity review-severity--${issue.severity}`}>{issue.severity}</span>
                <h3>{issue.message}</h3>
              </div>
              <code>{issue.code}</code>
            </div>
            <p className="source-reference"><SourceReferences references={sources} /></p>
            {issue.resolution ? <p className="review-resolution"><strong>Recorded resolution:</strong> {issue.resolution}</p> : null}
            {!issue.resolved_at ? (
              <button className="primary-action" onClick={() => onReview({ type: 'issue', issue })} type="button">Record resolution</button>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

function CandidateList({ candidates, onReview }: { candidates: ImportCandidate[]; onReview: (dialog: ReviewDialog) => void }) {
  if (candidates.length === 0) {
    return <DataStatePanel icon={CheckCircle2} title="No candidates match these filters"><p>Change the filters or continue with unresolved source questions.</p></DataStatePanel>
  }
  return (
    <div className="import-review-list">
      {candidates.map((candidate) => (
        <article className="import-review-card" key={candidate.id}>
          <div className="import-review-card__heading">
            <div>
              <span className="review-kind">{kindLabels[candidate.kind]}</span>
              <h3>{candidateTitle(candidate)}</h3>
            </div>
            <span className={`review-confidence review-confidence--${candidate.confidence}`}>
              {candidate.confidence === 'blocking_review' ? 'Needs mapping' : 'Review'}
            </span>
          </div>
          <p className="source-reference"><SourceReferences references={candidate.source_references} /></p>
          <details className="candidate-evidence">
            <summary>View extracted source details</summary>
            <pre>{JSON.stringify(candidate.payload, null, 2)}</pre>
          </details>
          {candidate.review_status === 'pending' ? (
            <div className="candidate-actions">
              <button className="secondary-button" onClick={() => onReview({ type: 'candidate', candidate, decision: 'rejected' })} type="button">Reject</button>
              <button className="secondary-button" onClick={() => onReview({ type: 'candidate', candidate, decision: 'superseded' })} type="button">Mark duplicate</button>
              <button className="primary-action" onClick={() => onReview({ type: 'candidate', candidate, decision: 'accepted' })} type="button">Accept</button>
            </div>
          ) : <p className="review-resolution"><strong>Status:</strong> {candidate.review_status}</p>}
        </article>
      ))}
    </div>
  )
}

function ReviewDecisionDialog({
  dialog,
  pending,
  onClose,
  onSubmit,
}: {
  dialog: ReviewDialog
  pending: boolean
  onClose: () => void
  onSubmit: (action: ReviewAction) => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const note = String(new FormData(event.currentTarget).get('note')).trim()
    if (dialog.type === 'issue') onSubmit({ type: 'issue', issueId: dialog.issue.id, resolution: note })
    else onSubmit({ type: 'candidate', candidateId: dialog.candidate.id, decision: dialog.decision, note })
  }

  const title = dialog.type === 'issue' ? 'Record source resolution' : decisionLabels[dialog.decision]
  const description = dialog.type === 'issue'
    ? dialog.issue.message
    : `${kindLabels[dialog.candidate.kind]} · ${candidateTitle(dialog.candidate)}`

  return (
    <ModalDialog description={description} onClose={onClose} title={title}>
      <form className="request-form" onSubmit={submit}>
        <label className="field-stack">
          <span>{dialog.type === 'issue' ? 'What the source means and how it maps' : 'Reason for this decision'}</span>
          <textarea autoFocus maxLength={4000} name="note" required rows={6} />
        </label>
        <p className="form-note">This note becomes part of the permanent import audit history.</p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" disabled={pending} type="submit">{pending ? 'Saving…' : 'Save decision'}</button>
        </div>
      </form>
    </ModalDialog>
  )
}

function LiveImportReview() {
  const queryClient = useQueryClient()
  const [view, setView] = useState<'issues' | 'candidates'>('issues')
  const [issueSeverity, setIssueSeverity] = useState<IssueSeverity | 'all'>('all')
  const [showResolved, setShowResolved] = useState(false)
  const [candidateKind, setCandidateKind] = useState<CandidateKind | 'all'>('all')
  const [candidateStatus, setCandidateStatus] = useState<CandidateStatus | 'all'>('pending')
  const [page, setPage] = useState(0)
  const [dialog, setDialog] = useState<ReviewDialog | null>(null)
  const summaryQuery = useQuery({ queryKey: ['import-review-summary'], queryFn: getImportReviewSummary })
  const importRunId = summaryQuery.data?.importRunId
  const issuesQuery = useQuery({
    queryKey: ['import-review-issues', importRunId, issueSeverity, showResolved, page],
    queryFn: () => getImportIssuesPage({
      importRunId: importRunId!,
      severity: issueSeverity === 'all' ? null : issueSeverity,
      resolved: showResolved,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    enabled: Boolean(importRunId && view === 'issues'),
  })
  const candidatesQuery = useQuery({
    queryKey: ['import-review-candidates', importRunId, candidateKind, candidateStatus, page],
    queryFn: () => getImportCandidatesPage({
      importRunId: importRunId!,
      kind: candidateKind === 'all' ? null : candidateKind,
      status: candidateStatus === 'all' ? null : candidateStatus,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    enabled: Boolean(importRunId && view === 'candidates'),
  })
  const reviewMutation = useMutation({
    mutationFn: async (action: ReviewAction) => {
      if (action.type === 'issue') return resolveImportIssue({ issueId: action.issueId, resolution: action.resolution })
      return reviewImportCandidate({ candidateId: action.candidateId, decision: action.decision, note: action.note })
    },
    onSuccess: async () => {
      setDialog(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['import-review-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['import-review-issues'] }),
        queryClient.invalidateQueries({ queryKey: ['import-review-candidates'] }),
      ])
    },
  })

  if (summaryQuery.isPending) return <DataStatePanel icon={Database} title="Loading protected import"><p>Verifying Admin access and retrieving the latest import summary.</p></DataStatePanel>
  if (summaryQuery.isError) return <DataStatePanel icon={ShieldAlert} title="Import review unavailable" tone="error"><p>{summaryQuery.error.message}</p><p>Sign in as an Admin and complete MFA before trying again.</p></DataStatePanel>
  if (!summaryQuery.data) return <DataStatePanel icon={Database} title="No workbook import is staged"><p>Run the verified import loader before beginning review.</p></DataStatePanel>

  const summary = summaryQuery.data
  const activeQuery = view === 'issues' ? issuesQuery : candidatesQuery
  const activeRows = activeQuery.data ?? []
  const total = activeRows[0]?.total_count ?? 0
  const resolvedIssueCount = (summary.issueCounts['blocking:resolved'] ?? 0)
    + (summary.issueCounts['warning:resolved'] ?? 0)
    + (summary.issueCounts['information:resolved'] ?? 0)
  const activeIssueCount = summary.blockingIssueCount + summary.warningCount

  function changeView(nextView: typeof view) {
    setView(nextView)
    setPage(0)
  }

  return (
    <>
      <section className="import-status-card" aria-labelledby="live-import-title">
        <div className="import-status-card__icon"><ShieldCheck aria-hidden="true" size={29} /></div>
        <div>
          <p className="eyebrow">Operational import complete</p>
          <h2 id="live-import-title">{summary.sourceFilename}</h2>
          <p>
            Active source blockers: <strong>{activeIssueCount}</strong>
            {' '}· Historical questions resolved: <strong>{formatNumber(resolvedIssueCount)}</strong>
            {' '}· Source identity {summary.sourceSha256.slice(0, 12)}…
          </p>
        </div>
        <span className={summary.blockingIssueCount ? 'import-state-pill import-state-pill--attention' : 'import-state-pill'}>
          {summary.blockingIssueCount ? <CircleAlert aria-hidden="true" size={17} /> : <CheckCircle2 aria-hidden="true" size={17} />}
          {summary.blockingIssueCount ? 'Review required' : 'Active blockers clear'}
        </span>
      </section>

      <ReviewMetrics
        blockingIssueCount={summary.blockingIssueCount}
        candidateCount={summary.candidateCount}
        sourceCellCount={summary.sourceCellCount}
        warningCount={summary.warningCount}
      />

      {reviewMutation.isError ? <div className="inline-alert" role="alert">{reviewMutation.error.message}</div> : null}

      <section className="import-workbench" aria-labelledby="review-workbench-title">
        <div className="import-workbench__heading">
          <div>
            <p className="eyebrow">Controlled review</p>
            <h2 id="review-workbench-title">Audit historical source decisions</h2>
          </div>
          <div className="review-tabs" role="tablist" aria-label="Import review areas">
            <button aria-selected={view === 'issues'} className={view === 'issues' ? 'review-tab review-tab--active' : 'review-tab'} onClick={() => changeView('issues')} role="tab" type="button"><CircleAlert aria-hidden="true" size={18} /> Source questions</button>
            <button aria-selected={view === 'candidates'} className={view === 'candidates' ? 'review-tab review-tab--active' : 'review-tab'} onClick={() => changeView('candidates')} role="tab" type="button"><ListChecks aria-hidden="true" size={18} /> Candidate records</button>
          </div>
        </div>

        {view === 'issues' ? (
          <div className="import-filters" aria-label="Issue filters">
            <label className="select-field"><span>Severity</span><select value={issueSeverity} onChange={(event) => { setIssueSeverity(event.target.value as typeof issueSeverity); setPage(0) }}><option value="all">All severities</option><option value="blocking">Blocking</option><option value="warning">Warning</option><option value="information">Information</option></select></label>
            <label className="select-field"><span>Status</span><select value={showResolved ? 'resolved' : 'open'} onChange={(event) => { setShowResolved(event.target.value === 'resolved'); setPage(0) }}><option value="open">Open</option><option value="resolved">Resolved</option></select></label>
          </div>
        ) : (
          <div className="import-filters" aria-label="Candidate filters">
            <label className="select-field"><span>Record type</span><select value={candidateKind} onChange={(event) => { setCandidateKind(event.target.value as typeof candidateKind); setPage(0) }}><option value="all">All record types</option><option value="weekly_schedule">Weekly schedules</option><option value="employee">Employees</option><option value="site">Sites and posts</option><option value="shift">Shifts</option></select></label>
            <label className="select-field"><span>Status</span><select value={candidateStatus} onChange={(event) => { setCandidateStatus(event.target.value as typeof candidateStatus); setPage(0) }}><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="superseded">Duplicates</option><option value="all">All statuses</option></select></label>
          </div>
        )}

        {activeQuery.isPending ? (
          <DataStatePanel icon={Database} title="Loading review records"><p>Retrieving the selected page from protected staging.</p></DataStatePanel>
        ) : activeQuery.isError ? (
          <DataStatePanel icon={ShieldAlert} title="Review records unavailable" tone="error"><p>{activeQuery.error.message}</p></DataStatePanel>
        ) : view === 'issues' ? (
          <IssueList issues={issuesQuery.data ?? []} onReview={setDialog} />
        ) : (
          <CandidateList candidates={candidatesQuery.data ?? []} onReview={setDialog} />
        )}
        {!activeQuery.isPending && !activeQuery.isError ? <Pagination onPage={setPage} page={page} total={total} /> : null}
      </section>

      {dialog ? <ReviewDecisionDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={(action) => reviewMutation.mutate(action)} pending={reviewMutation.isPending} /> : null}
    </>
  )
}

export function ImportReviewPage() {
  return (
    <div className="page page--import-review">
      <section className="page-intro workforce-intro">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Workbook import review</h1>
          <p className="page-summary">
            Move the legacy workbook into SygShift with exact source evidence, clear human decisions,
            and no silent assumptions.
          </p>
        </div>
        <div className="access-note"><ShieldAlert aria-hidden="true" size={19} /> Admin access and MFA required</div>
      </section>
      {isSupabaseConfigured ? <LiveImportReview /> : <VerifiedStagingSummary />}
    </div>
  )
}

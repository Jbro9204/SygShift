import { type FormEvent, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleOff,
  Clock3,
  Database,
  History,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Wrench,
} from 'lucide-react'
import { DataStatePanel } from '../components/DataStatePanel'
import { ModalDialog } from '../components/ModalDialog'
import { SystemStatusIndicator } from '../components/SystemStatusIndicator'
import {
  closeMaintenanceWindow,
  getMaintenanceAdminWorkspace,
  MAINTENANCE_FEATURES,
  maintenanceFeatureLabel,
  saveMaintenanceWindow,
  type MaintenanceAccessMode,
  type MaintenanceFeatureCode,
  type MaintenanceReleaseKind,
  type MaintenanceWindow,
} from '../data/maintenance'
import { deriveSystemServiceStatus, getSystemReadiness } from '../data/systemStatus'
import { defaultMaintenanceWindow, fromOperationalDateTimeInput, toOperationalDateTimeInput } from '../lib/operationalDateTime'
import { isSupabaseConfigured } from '../lib/supabase'
import { formatOperationalDateTime } from '../lib/time'

type WindowFormState = {
  id: string | null
  releaseKind: MaintenanceReleaseKind
  accessMode: MaintenanceAccessMode
  title: string
  message: string
  completionMessage: string
  releaseVersion: string
  featureCodes: MaintenanceFeatureCode[]
  startsAt: string
  endsAt: string
}

const releaseKindLabels: Record<MaintenanceReleaseKind, string> = {
  routine: 'Routine update',
  planned: 'Planned maintenance',
  major: 'Major release',
  emergency: 'Emergency repair',
}

const accessModeLabels: Record<MaintenanceAccessMode, string> = {
  notice: 'Notice only — no access change',
  read_only: 'Read-only — viewing remains available',
  unavailable: 'Temporarily unavailable',
}

function emptyWindowForm(): WindowFormState {
  const dates = defaultMaintenanceWindow()
  return {
    accessMode: 'notice',
    completionMessage: 'Maintenance is complete. Refresh SygShift when convenient to load the latest update.',
    endsAt: dates.endsAt,
    featureCodes: [],
    id: null,
    message: 'SygShift maintenance is scheduled for the time shown. Save your work before the window begins.',
    releaseKind: 'planned',
    releaseVersion: '',
    startsAt: dates.startsAt,
    title: 'Scheduled SygShift maintenance',
  }
}

function formFromWindow(window: MaintenanceWindow): WindowFormState {
  return {
    accessMode: window.accessMode,
    completionMessage: window.completionMessage ?? '',
    endsAt: toOperationalDateTimeInput(window.endsAt),
    featureCodes: [...window.featureCodes],
    id: window.id,
    message: window.message,
    releaseKind: window.releaseKind,
    releaseVersion: window.releaseVersion ?? '',
    startsAt: toOperationalDateTimeInput(window.startsAt),
    title: window.title,
  }
}

function statusLabel(status: MaintenanceWindow['status']): string {
  if (status === 'active') return 'Active now'
  if (status === 'scheduled') return 'Scheduled'
  if (status === 'completed') return 'Completed'
  if (status === 'canceled') return 'Canceled'
  return 'Expired automatically'
}

function WindowCard({
  window,
  onClose,
  onEdit,
}: {
  window: MaintenanceWindow
  onClose: (window: MaintenanceWindow) => void
  onEdit: (window: MaintenanceWindow) => void
}) {
  const canChange = window.status === 'active' || window.status === 'scheduled'

  return (
    <article className={`maintenance-window-card maintenance-window-card--${window.status}`}>
      <div className="maintenance-window-card__heading">
        <div>
          <span className="maintenance-status-pill">{statusLabel(window.status)}</span>
          <h3>{window.title}</h3>
        </div>
        <strong>{releaseKindLabels[window.releaseKind]}</strong>
      </div>
      <p>{window.message}</p>
      <dl className="maintenance-window-card__facts">
        <div><dt>Starts</dt><dd>{formatOperationalDateTime(window.startsAt, { includeTimeZoneName: true })}</dd></div>
        <div><dt>Ends automatically</dt><dd>{formatOperationalDateTime(window.endsAt, { includeTimeZoneName: true })}</dd></div>
        <div><dt>Access</dt><dd>{accessModeLabels[window.accessMode]}</dd></div>
        <div><dt>Release</dt><dd>{window.releaseVersion || 'Not specified'}</dd></div>
      </dl>
      <div className="maintenance-feature-chips" aria-label="Affected features">
        {window.featureCodes.map((code) => <span key={code}>{maintenanceFeatureLabel(code)}</span>)}
      </div>
      {canChange ? (
        <div className="maintenance-window-card__actions">
          <button className="secondary-button" onClick={() => onEdit(window)} type="button">Edit window</button>
          <button className="primary-action" onClick={() => onClose(window)} type="button">
            {window.status === 'active' ? 'Complete maintenance' : 'Cancel window'}
          </button>
        </div>
      ) : null}
    </article>
  )
}

export function SystemOperationsPage() {
  const queryClient = useQueryClient()
  const [formState, setFormState] = useState<WindowFormState | null>(null)
  const [closingWindow, setClosingWindow] = useState<MaintenanceWindow | null>(null)
  const [completionMessage, setCompletionMessage] = useState('')
  const [resultMessage, setResultMessage] = useState<string | null>(null)

  const workspaceQuery = useQuery({
    queryFn: getMaintenanceAdminWorkspace,
    queryKey: ['maintenance-admin-workspace'],
    refetchInterval: 30_000,
  })
  const readinessQuery = useQuery({
    queryFn: getSystemReadiness,
    queryKey: ['system-readiness'],
    refetchInterval: 30_000,
  })
  const saveMutation = useMutation({
    mutationFn: saveMaintenanceWindow,
    onSuccess: (workspace) => {
      queryClient.setQueryData(['maintenance-admin-workspace'], workspace)
      void queryClient.invalidateQueries({ queryKey: ['maintenance-status'] })
      setFormState(null)
      setResultMessage('The maintenance window was saved. Employees will see it at the correct time.')
    },
  })
  const closeMutation = useMutation({
    mutationFn: ({ action, id, message }: { action: 'complete' | 'cancel'; id: string; message: string }) =>
      closeMaintenanceWindow(id, action, message),
    onSuccess: (workspace) => {
      queryClient.setQueryData(['maintenance-admin-workspace'], workspace)
      void queryClient.invalidateQueries({ queryKey: ['maintenance-status'] })
      setClosingWindow(null)
      setCompletionMessage('')
      setResultMessage('The maintenance window was closed and the protected features are available again.')
    },
  })

  const windows = workspaceQuery.data?.windows ?? []
  const currentWindows = windows.filter((window) => window.status === 'active' || window.status === 'scheduled')
  const history = windows.filter((window) => window.status !== 'active' && window.status !== 'scheduled')
  const activeWindows = currentWindows.filter((window) => window.status === 'active')
  const scheduledWindows = currentWindows.filter((window) => window.status === 'scheduled')
  const serviceStatus = deriveSystemServiceStatus({
    configured: isSupabaseConfigured,
    maintenanceAccessModes: activeWindows.map((window) => window.accessMode),
    maintenanceError: workspaceQuery.isError,
    maintenancePending: workspaceQuery.isPending,
    readiness: readinessQuery.data,
    readinessError: readinessQuery.isError,
    readinessPending: readinessQuery.isPending,
  })
  const lastCheckedAt = Math.max(readinessQuery.dataUpdatedAt, workspaceQuery.dataUpdatedAt)
  const refreshingHealth = readinessQuery.isFetching || workspaceQuery.isFetching
  const groupedFeatures = useMemo(() => Object.entries(
    MAINTENANCE_FEATURES.reduce<Record<string, typeof MAINTENANCE_FEATURES[number][]>>((groups, feature) => {
      groups[feature.group] ??= []
      groups[feature.group].push(feature)
      return groups
    }, {}),
  ), [])

  function updateForm<K extends keyof WindowFormState>(key: K, value: WindowFormState[K]) {
    setFormState((current) => current ? { ...current, [key]: value } : current)
  }

  function toggleFeature(code: MaintenanceFeatureCode) {
    if (!formState) return
    updateForm(
      'featureCodes',
      formState.featureCodes.includes(code)
        ? formState.featureCodes.filter((item) => item !== code)
        : [...formState.featureCodes, code],
    )
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!formState) return
    setResultMessage(null)
    saveMutation.mutate({
      accessMode: formState.accessMode,
      completionMessage: formState.completionMessage,
      endsAt: fromOperationalDateTimeInput(formState.endsAt),
      featureCodes: formState.featureCodes,
      id: formState.id,
      message: formState.message,
      releaseKind: formState.releaseKind,
      releaseVersion: formState.releaseVersion,
      startsAt: fromOperationalDateTimeInput(formState.startsAt),
      title: formState.title,
    })
  }

  return (
    <div className="page-shell system-operations-page">
      <header className="system-operations-hero">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>System Operations</h1>
          <p>Communicate maintenance, protect affected workflows, and keep an audited release history.</p>
        </div>
        <button className="primary-action" onClick={() => setFormState(emptyWindowForm())} type="button">
          <Plus aria-hidden="true" size={19} /> Schedule maintenance
        </button>
      </header>

      <section className="system-health-section" aria-labelledby="system-health-heading">
        <div className="system-health-section__heading">
          <div>
            <p className="eyebrow">Protected system status</p>
            <h2 id="system-health-heading">Service health</h2>
            <p>Sanitized operational checks are shown here for authorized administrators. No keys, credentials, or private connection values are displayed.</p>
          </div>
          <div className="system-health-section__actions">
            <SystemStatusIndicator canOpenOperations={false} status={serviceStatus} />
            <button
              className="secondary-button"
              disabled={refreshingHealth}
              onClick={() => {
                void readinessQuery.refetch()
                void workspaceQuery.refetch()
              }}
              type="button"
            >
              <RefreshCw aria-hidden="true" className={refreshingHealth ? 'system-health-refresh-icon system-health-refresh-icon--active' : 'system-health-refresh-icon'} size={17} />
              {refreshingHealth ? 'Checking...' : 'Refresh checks'}
            </button>
          </div>
        </div>
        <div className="system-health-grid">
          <article>
            <Server aria-hidden="true" size={21} />
            <div><span>Application delivery</span><strong>{readinessQuery.data?.checks.assetsBinding ? 'Operational' : 'Attention needed'}</strong><small>Application assets and the production runtime</small></div>
          </article>
          <article>
            <Database aria-hidden="true" size={21} />
            <div><span>Data & authentication</span><strong>{readinessQuery.data?.checks.supabaseUrl && readinessQuery.data?.checks.supabasePublishableKey && workspaceQuery.data ? 'Connected' : 'Attention needed'}</strong><small>Employee authentication and operational records</small></div>
          </article>
          <article>
            <ShieldCheck aria-hidden="true" size={21} />
            <div><span>Protected integrations</span><strong>{readinessQuery.data?.checks.supabaseServiceRoleKey ? 'Configured' : 'Attention needed'}</strong><small>Server-only administrative operations</small></div>
          </article>
          <article>
            <Wrench aria-hidden="true" size={21} />
            <div><span>Safe release controls</span><strong>{activeWindows.length > 0 ? `${activeWindows.length} active` : scheduledWindows.length > 0 ? `${scheduledWindows.length} scheduled` : 'No restrictions'}</strong><small>Feature-specific maintenance access controls</small></div>
          </article>
        </div>
        {serviceStatus.issues.length > 0 ? (
          <section
            aria-labelledby="system-health-diagnostics-heading"
            className={`system-health-diagnostics system-health-diagnostics--${serviceStatus.state}`}
          >
            <div className="system-health-diagnostics__heading">
              <AlertTriangle aria-hidden="true" size={22} />
              <div>
                <h3 id="system-health-diagnostics-heading">What needs attention</h3>
                <p>The affected service, operational impact, and next action are listed below.</p>
              </div>
            </div>
            <div className="system-health-diagnostics__list">
              {serviceStatus.issues.map((issue) => (
                <article key={`${issue.service}-${issue.summary}`}>
                  <div><span>Service</span><strong>{issue.service}</strong></div>
                  <div><span>Problem</span><p>{issue.summary}</p></div>
                  <div><span>Impact</span><p>{issue.impact}</p></div>
                  <div><span>Next action</span><p>{issue.action}</p></div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        <p className="system-health-section__checked">{lastCheckedAt > 0 ? `Last checked ${formatOperationalDateTime(new Date(lastCheckedAt), { includeTimeZoneName: true })}.` : 'Running the first protected system check.'}</p>
      </section>

      <section className="maintenance-principles" aria-label="Safe release controls">
        <article><ShieldCheck aria-hidden="true" /><div><strong>Inactive by default</strong><span>A deployment cannot turn maintenance on by itself.</span></div></article>
        <article><Clock3 aria-hidden="true" /><div><strong>Automatic recovery</strong><span>Every window has a required end time and expires automatically.</span></div></article>
        <article><Wrench aria-hidden="true" /><div><strong>Feature-specific</strong><span>Only selected workflows are protected; the time clock stays open unless selected.</span></div></article>
      </section>

      {resultMessage ? <div className="success-banner" role="status"><CheckCircle2 aria-hidden="true" size={20} />{resultMessage}</div> : null}

      {workspaceQuery.isLoading ? <DataStatePanel icon={Wrench} title="Loading System Operations"><p>Checking maintenance and release controls.</p></DataStatePanel> : null}
      {workspaceQuery.isError ? <DataStatePanel icon={AlertTriangle} title="System Operations unavailable" tone="error"><p>{workspaceQuery.error instanceof Error ? workspaceQuery.error.message : 'The workspace could not be loaded.'}</p></DataStatePanel> : null}

      {workspaceQuery.data ? (
        <>
          <section className="maintenance-section">
            <div className="maintenance-section__heading">
              <div><p className="eyebrow">Live controls</p><h2>Active and scheduled</h2></div>
              <span>{currentWindows.length} window{currentWindows.length === 1 ? '' : 's'}</span>
            </div>
            {currentWindows.length === 0 ? (
              <div className="maintenance-empty-state">
                <CheckCircle2 aria-hidden="true" size={30} />
                <div><strong>All SygShift features are available</strong><p>No maintenance access controls are active or scheduled.</p></div>
              </div>
            ) : (
              <div className="maintenance-window-grid">
                {currentWindows.map((window) => (
                  <WindowCard key={window.id} window={window} onClose={(item) => {
                    setClosingWindow(item)
                    setCompletionMessage(item.completionMessage ?? '')
                  }} onEdit={(item) => setFormState(formFromWindow(item))} />
                ))}
              </div>
            )}
          </section>

          <section className="maintenance-section">
            <div className="maintenance-section__heading">
              <div><p className="eyebrow">Audit history</p><h2>Recent maintenance</h2></div>
              <History aria-hidden="true" size={24} />
            </div>
            {history.length === 0 ? <p className="maintenance-history-empty">No completed maintenance windows have been recorded yet.</p> : (
              <div className="maintenance-history-list">
                {history.map((window) => (
                  <article key={window.id}>
                    <div><strong>{window.title}</strong><span>{statusLabel(window.status)}</span></div>
                    <p>{formatOperationalDateTime(window.startsAt)} through {formatOperationalDateTime(window.endsAt)}</p>
                    <small>{window.featureCodes.map(maintenanceFeatureLabel).join(' · ')}</small>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}

      {formState ? (
        <ModalDialog
          busy={saveMutation.isPending}
          busyLabel="Saving maintenance controls..."
          className="modal-dialog--maintenance"
          description="Times are entered in Mountain Time. Maintenance is never activated until this form is saved."
          onClose={() => setFormState(null)}
          title={formState.id ? 'Edit maintenance window' : 'Schedule maintenance'}
        >
          <form className="maintenance-form" onSubmit={handleSave}>
            <section className="maintenance-form__section">
              <div className="maintenance-form__section-heading"><span>1</span><div><h3>Release and access</h3><p>Choose the least disruptive control that safely supports the work.</p></div></div>
              <div className="maintenance-form-grid maintenance-form-grid--two">
                <label><span>Release type</span><select value={formState.releaseKind} onChange={(event) => updateForm('releaseKind', event.target.value as MaintenanceReleaseKind)}>{Object.entries(releaseKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Access during maintenance</span><select value={formState.accessMode} onChange={(event) => updateForm('accessMode', event.target.value as MaintenanceAccessMode)}>{Object.entries(accessModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="maintenance-form-grid maintenance-form-grid--two">
                <label><span>Start / Mountain Time</span><input required type="datetime-local" value={formState.startsAt} onChange={(event) => updateForm('startsAt', event.target.value)} /></label>
                <label><span>End / Mountain Time</span><input required type="datetime-local" value={formState.endsAt} onChange={(event) => updateForm('endsAt', event.target.value)} /></label>
              </div>
            </section>

            <section className="maintenance-form__section">
              <div className="maintenance-form__section-heading"><span>2</span><div><h3>Employee communication</h3><p>Use direct, plain language. Employees will see the time and affected features automatically.</p></div></div>
              <label><span>Notice title</span><input required maxLength={100} value={formState.title} onChange={(event) => updateForm('title', event.target.value)} /></label>
              <label><span>Notice message</span><textarea required rows={3} value={formState.message} onChange={(event) => updateForm('message', event.target.value)} /></label>
              <div className="maintenance-form-grid maintenance-form-grid--two">
                <label><span>Completion message</span><input value={formState.completionMessage} onChange={(event) => updateForm('completionMessage', event.target.value)} /></label>
                <label><span>Release version <small>Optional</small></span><input placeholder="Example: 2026.08.25.1" value={formState.releaseVersion} onChange={(event) => updateForm('releaseVersion', event.target.value)} /></label>
              </div>
            </section>

            <section className="maintenance-form__section">
              <div className="maintenance-form__section-heading"><span>3</span><div><h3>Affected features</h3><p>Select only what the release actually touches. The employee time clock is intentionally separate.</p></div></div>
              <div className="maintenance-feature-groups">
                {groupedFeatures.map(([group, features]) => (
                  <fieldset key={group}>
                    <legend>{group}</legend>
                    {features.map((feature) => (
                      <label className={formState.featureCodes.includes(feature.code) ? 'maintenance-feature-option maintenance-feature-option--selected' : 'maintenance-feature-option'} key={feature.code}>
                        <input checked={formState.featureCodes.includes(feature.code)} onChange={() => toggleFeature(feature.code)} type="checkbox" />
                        <span><strong>{feature.label}</strong><small>{feature.description}</small></span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </section>

            {saveMutation.isError ? <div className="form-error" role="alert">{saveMutation.error instanceof Error ? saveMutation.error.message : 'Maintenance could not be saved.'}</div> : null}
            <div className="modal-actions">
              <button className="secondary-button" disabled={saveMutation.isPending} onClick={() => setFormState(null)} type="button">Cancel</button>
              <button className="primary-action" disabled={saveMutation.isPending || formState.featureCodes.length === 0} type="submit"><CalendarClock aria-hidden="true" size={18} />{formState.id ? 'Save changes' : 'Schedule maintenance'}</button>
            </div>
          </form>
        </ModalDialog>
      ) : null}

      {closingWindow ? (
        <ModalDialog
          busy={closeMutation.isPending}
          busyLabel="Closing maintenance window..."
          className="modal-dialog--maintenance-close"
          description={closingWindow.status === 'active' ? 'Completing maintenance immediately restores employee write access.' : 'Canceling removes this scheduled notice before it begins.'}
          onClose={() => setClosingWindow(null)}
          title={closingWindow.status === 'active' ? 'Complete maintenance?' : 'Cancel scheduled maintenance?'}
        >
          <section className="maintenance-close-summary">
            {closingWindow.status === 'active' ? <CheckCircle2 aria-hidden="true" size={26} /> : <CircleOff aria-hidden="true" size={26} />}
            <div><strong>{closingWindow.title}</strong><p>{closingWindow.featureCodes.map(maintenanceFeatureLabel).join(' · ')}</p></div>
          </section>
          {closingWindow.status === 'active' ? <label className="maintenance-close-message"><span>Completion message</span><textarea rows={3} value={completionMessage} onChange={(event) => setCompletionMessage(event.target.value)} /></label> : (
            <div className="maintenance-cancel-warning"><AlertTriangle aria-hidden="true" size={22} /><span>Employees will no longer see this upcoming maintenance notice.</span></div>
          )}
          {closeMutation.isError ? <div className="form-error" role="alert">{closeMutation.error instanceof Error ? closeMutation.error.message : 'The window could not be closed.'}</div> : null}
          <div className="modal-actions">
            <button className="secondary-button" disabled={closeMutation.isPending} onClick={() => setClosingWindow(null)} type="button">Keep window</button>
            <button className="primary-action" disabled={closeMutation.isPending} onClick={() => closeMutation.mutate({ action: closingWindow.status === 'active' ? 'complete' : 'cancel', id: closingWindow.id, message: completionMessage })} type="button">{closingWindow.status === 'active' ? 'Complete now' : 'Cancel window'}</button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  )
}

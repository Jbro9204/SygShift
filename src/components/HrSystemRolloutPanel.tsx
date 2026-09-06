import { type ChangeEvent, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Library, LoaderCircle, ShieldAlert } from 'lucide-react'
import { importHrSystemItem, normalizedPackagePath, parseHrSystemCatalog, type HrSystemCatalog, type HrSystemCatalogItem } from '../data/hrSystemImport'

type State = 'idle' | 'ready' | 'running' | 'complete' | 'error'
const stageOrder: Array<{ kind: HrSystemCatalogItem['kind']; label: string }> = [
  { kind: 'hr_source', label: 'HR forms and references' },
  { kind: 'training_admin', label: 'Training administration' },
  { kind: 'training_module', label: 'Training modules' },
  { kind: 'document_guide', label: 'Document guides' },
  { kind: 'training_form', label: 'Training forms' },
]

function packageFilePath(file: File): string {
  const raw = file.webkitRelativePath || file.name
  const normalized = raw.replaceAll('\\', '/')
  const pdfIndex = normalized.toLowerCase().indexOf('/pdf/')
  return normalizedPackagePath(pdfIndex >= 0 ? normalized.slice(pdfIndex + 5) : normalized)
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function HrSystemRolloutPanel({ onComplete }: { onComplete: () => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<State>('idle')
  const [catalog, setCatalog] = useState<HrSystemCatalog | null>(null)
  const [files, setFiles] = useState<Map<string, File>>(new Map())
  const [message, setMessage] = useState('Choose the validated v2.1 rollout folder to begin.')
  const [completed, setCompleted] = useState(0)
  const [itemProgress, setItemProgress] = useState(0)
  const [stage, setStage] = useState('Not started')
  const summary = useMemo(() => catalog ? stageOrder.map((entry) => ({ ...entry, count: catalog.items.filter((item) => item.kind === entry.kind).length })) : [], [catalog])

  async function selectPackage(event: ChangeEvent<HTMLInputElement>) {
    try {
      const selected = [...(event.target.files ?? [])]
      const catalogFile = selected.find((file) => file.name.toLowerCase() === 'catalog.json')
      if (!catalogFile) throw new Error('catalog.json was not found. Choose the complete validated rollout folder.')
      const parsed = parseHrSystemCatalog(JSON.parse(await catalogFile.text()))
      const indexed = new Map(selected.filter((file) => file.name.toLowerCase().endsWith('.pdf')).map((file) => [packageFilePath(file), file]))
      const missing = parsed.items.filter((item) => !indexed.has(normalizedPackagePath(item.pdfRelativePath))).slice(0, 3)
      if (missing.length) throw new Error(`The rollout folder is incomplete. Missing ${missing.map((item) => item.pdfRelativePath).join(', ')}.`)
      setCatalog(parsed)
      setFiles(indexed)
      setCompleted(0)
      setState('ready')
      setMessage('All 537 canonical PDFs and the controlled catalog are present. Ready for the back-to-back rollout.')
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'The rollout package could not be read.')
    }
  }

  async function run() {
    if (!catalog || state === 'running') return
    setState('running')
    setCompleted(0)
    try {
      let finished = 0
      for (const stageEntry of stageOrder) {
        setStage(stageEntry.label)
        const items = catalog.items.filter((item) => item.kind === stageEntry.kind)
        for (const item of items) {
          setMessage(`Validating and importing ${item.code} · ${item.title}`)
          const file = files.get(normalizedPackagePath(item.pdfRelativePath))
          if (!file) throw new Error(`${item.code} is missing from the selected folder.`)
          if (file.size !== item.sizeBytes || await sha256(file) !== item.sha256) throw new Error(`${item.code} failed its PDF integrity check. The rollout stopped before that file was uploaded.`)
          await importHrSystemItem(item, file, setItemProgress)
          finished += 1
          setCompleted(finished)
          setItemProgress(0)
        }
      }
      setStage('Complete')
      setState('complete')
      setMessage('The full HR and Training PDF package is registered. Security scanning continues in the protected processing queue.')
      await onComplete()
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'The rollout stopped. Re-select the same folder and retry safely.')
    }
  }

  return <section className="hr-system-rollout">
    <header><div><p className="eyebrow">Controlled release</p><h2>HR System v2.1 rollout</h2><p>Imports the validated PDF library through the existing private vault, malware scanner, immutable version, and audit controls.</p></div><Library aria-hidden="true" size={26}/></header>
    <input accept="application/json,application/pdf" aria-label="Choose HR System rollout folder" multiple onChange={(event) => void selectPackage(event)} ref={(element) => { input.current = element; element?.setAttribute('webkitdirectory', '') }} style={{ display: 'none' }} type="file" />
    <div className={`hr-system-rollout__status is-${state}`}>
      {state === 'complete' ? <CheckCircle2 aria-hidden="true"/> : state === 'running' ? <LoaderCircle aria-hidden="true" className="spin"/> : state === 'error' ? <ShieldAlert aria-hidden="true"/> : <FolderOpen aria-hidden="true"/>}
      <div><strong>{stage}</strong><span>{message}</span></div>
      <strong>{completed}/{catalog?.canonicalPdfCount ?? 537}</strong>
    </div>
    {state === 'running' ? <div className="hr-system-rollout__progress"><progress max={537} value={completed + itemProgress / 100}/><span>{Math.round(((completed + itemProgress / 100) / 537) * 100)}%</span></div> : null}
    {summary.length ? <div className="hr-system-rollout__stages">{summary.map((entry) => <span key={entry.kind}><strong>{entry.count}</strong>{entry.label}</span>)}</div> : null}
    <div className="hr-system-rollout__actions"><button className="secondary-button" disabled={state === 'running'} onClick={() => input.current?.click()} type="button"><FolderOpen size={17}/>Choose rollout folder</button><button className="primary-action" disabled={!catalog || state === 'running' || state === 'complete'} onClick={() => void run()} type="button">{state === 'error' ? 'Retry rollout' : 'Run all stages'}</button></div>
  </section>
}

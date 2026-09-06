import { type ChangeEvent, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Library, LoaderCircle, ShieldAlert } from 'lucide-react'
import { unzipSync } from 'fflate'
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
  const folderInput = useRef<HTMLInputElement>(null)
  const archiveInput = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<State>('idle')
  const [catalog, setCatalog] = useState<HrSystemCatalog | null>(null)
  const [files, setFiles] = useState<Map<string, File>>(new Map())
  const [message, setMessage] = useState('Choose the validated v2.1 rollout folder or ZIP to begin.')
  const [completed, setCompleted] = useState(0)
  const [itemProgress, setItemProgress] = useState(0)
  const [stage, setStage] = useState('Not started')
  const summary = useMemo(() => catalog ? stageOrder.map((entry) => ({ ...entry, count: catalog.items.filter((item) => item.kind === entry.kind).length })) : [], [catalog])

  async function prepareSelection(selected: File[]) {
    try {
      const catalogFile = selected.find((file) => file.name.toLowerCase() === 'catalog.json')
      if (!catalogFile) throw new Error('catalog.json was not found. Choose the complete validated rollout folder.')
      const parsed = parseHrSystemCatalog(JSON.parse(await catalogFile.text()))
      const pdfFiles = selected.filter((file) => file.name.toLowerCase().endsWith('.pdf'))
      const indexed = new Map(pdfFiles.map((file) => [packageFilePath(file), file]))
      const byFilename = new Map(pdfFiles.map((file) => [file.name.toLowerCase(), file]))
      for (const item of parsed.items) {
        const expectedPath = normalizedPackagePath(item.pdfRelativePath)
        if (!indexed.has(expectedPath)) {
          const filename = expectedPath.split('/').at(-1)
          const match = filename ? byFilename.get(filename) : undefined
          if (match) indexed.set(expectedPath, match)
        }
      }
      const missing = parsed.items.filter((item) => !indexed.has(normalizedPackagePath(item.pdfRelativePath))).slice(0, 3)
      if (missing.length) throw new Error(`The rollout package is incomplete. Missing ${missing.map((item) => item.pdfRelativePath).join(', ')}.`)
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

  async function selectFolder(event: ChangeEvent<HTMLInputElement>) {
    await prepareSelection([...(event.target.files ?? [])])
  }

  async function selectArchive(event: ChangeEvent<HTMLInputElement>) {
    try {
      const archive = event.target.files?.[0]
      if (!archive) return
      if (archive.size > 160 * 1024 * 1024) throw new Error('The rollout ZIP exceeds the 160 MB safety limit.')
      setMessage('Opening and validating the rollout ZIP…')
      const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()))
      const selected = Object.entries(entries)
        .filter(([path]) => path.toLowerCase().endsWith('.pdf') || path.toLowerCase().endsWith('catalog.json'))
        .map(([path, bytes]) => {
          const filename = path.replaceAll('\\', '/').split('/').at(-1) ?? path
          const file = new File([bytes], filename, { type: filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/json' })
          Object.defineProperty(file, 'webkitRelativePath', { configurable: true, value: path })
          return file
        })
      if (selected.length > 600) throw new Error('The rollout ZIP contains more files than the controlled package permits.')
      await prepareSelection(selected)
    } catch (error) {
      setState('error')
      setMessage(error instanceof Error ? error.message : 'The rollout ZIP could not be opened.')
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
    <input accept="application/json,application/pdf" aria-label="Choose HR System rollout folder" multiple onChange={(event) => void selectFolder(event)} ref={(element) => { folderInput.current = element; element?.setAttribute('webkitdirectory', '') }} style={{ display: 'none' }} type="file" />
    <input accept="application/zip,.zip" aria-label="Choose HR System rollout ZIP" onChange={(event) => void selectArchive(event)} ref={archiveInput} style={{ display: 'none' }} type="file" />
    <div className={`hr-system-rollout__status is-${state}`}>
      {state === 'complete' ? <CheckCircle2 aria-hidden="true"/> : state === 'running' ? <LoaderCircle aria-hidden="true" className="spin"/> : state === 'error' ? <ShieldAlert aria-hidden="true"/> : <FolderOpen aria-hidden="true"/>}
      <div><strong>{stage}</strong><span>{message}</span></div>
      <strong>{completed}/{catalog?.canonicalPdfCount ?? 537}</strong>
    </div>
    {state === 'running' ? <div className="hr-system-rollout__progress"><progress max={537} value={completed + itemProgress / 100}/><span>{Math.round(((completed + itemProgress / 100) / 537) * 100)}%</span></div> : null}
    {summary.length ? <div className="hr-system-rollout__stages">{summary.map((entry) => <span key={entry.kind}><strong>{entry.count}</strong>{entry.label}</span>)}</div> : null}
    <div className="hr-system-rollout__actions"><button className="secondary-button" disabled={state === 'running'} onClick={() => folderInput.current?.click()} type="button"><FolderOpen size={17}/>Choose folder</button><button className="secondary-button" disabled={state === 'running'} onClick={() => archiveInput.current?.click()} type="button"><FolderOpen size={17}/>Choose ZIP</button><button className="primary-action" disabled={!catalog || state === 'running' || state === 'complete'} onClick={() => void run()} type="button">{state === 'error' ? 'Retry rollout' : 'Run all stages'}</button></div>
  </section>
}

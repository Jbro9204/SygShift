import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createClient } from '@supabase/supabase-js'

const [evidenceDirectoryArgument, normalizedDirectoryArgument, storagePathArgument, modeArgument] =
  process.argv.slice(2)

if (process.argv.slice(2).length > 4 || (modeArgument && modeArgument !== '--dry-run')) {
  throw new Error('The only supported optional argument is --dry-run.')
}

if (!evidenceDirectoryArgument || !normalizedDirectoryArgument || !storagePathArgument) {
  throw new Error(
    'Usage: load-evidence.mjs <private-evidence-directory> <private-normalized-directory> <private-storage-path> [--dry-run]',
  )
}

const dryRun = modeArgument === '--dry-run'
const evidenceDirectory = path.resolve(evidenceDirectoryArgument)
const normalizedDirectory = path.resolve(normalizedDirectoryArgument)

async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function* readRecords(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (line) yield JSON.parse(line)
  }
}

async function* batches(records, batchSize) {
  let batch = []
  for await (const record of records) {
    batch.push(record)
    if (batch.length >= batchSize) {
      yield batch
      batch = []
    }
  }
  if (batch.length > 0) yield batch
}

async function verifyManifestFiles(directory, manifest) {
  for (const item of Object.values(manifest.evidence)) {
    const filePath = path.join(directory, item.filename)
    if (await sha256(filePath) !== item.sha256) {
      throw new Error(`Evidence fingerprint failed: ${item.filename}`)
    }
  }
}

const artifactManifest = JSON.parse(
  await fs.readFile(path.join(evidenceDirectory, 'manifest.json'), 'utf8'),
)
const ooxmlManifest = JSON.parse(
  await fs.readFile(path.join(evidenceDirectory, 'ooxml-manifest.json'), 'utf8'),
)
const normalizationManifest = JSON.parse(
  await fs.readFile(path.join(normalizedDirectory, 'normalization-manifest.json'), 'utf8'),
)

if (
  artifactManifest.source.sha256 !== ooxmlManifest.source.sha256
  || artifactManifest.source.sha256 !== normalizationManifest.source.sha256
) {
  throw new Error('Evidence and normalization manifests do not share one source fingerprint.')
}

await verifyManifestFiles(evidenceDirectory, artifactManifest)
await verifyManifestFiles(evidenceDirectory, ooxmlManifest)
await verifyManifestFiles(normalizedDirectory, normalizationManifest)

const evidenceRecords = []
const addEvidence = (prefix, manifest, countLookup) => {
  for (const [key, item] of Object.entries(manifest.evidence)) {
    evidenceRecords.push({
      kind: `${prefix}_${key}`,
      filename: item.filename,
      sha256: item.sha256,
      recordCount: countLookup[key] ?? null,
    })
  }
}

addEvidence('artifact', artifactManifest, {
  sheets: artifactManifest.counts.sheets,
  cells: artifactManifest.counts.cells,
})
addEvidence('ooxml', ooxmlManifest, {
  sheets: ooxmlManifest.counts.sheets,
  cells: ooxmlManifest.counts.cells,
  annotations: ooxmlManifest.counts.annotations,
  relationships: ooxmlManifest.counts.relationships,
})
addEvidence('normalized', normalizationManifest, {
  sheets: artifactManifest.counts.sheets,
  schedules: normalizationManifest.counts.weeklySchedules,
  directory: normalizationManifest.counts.directoryCandidates,
  sites: normalizationManifest.counts.siteCandidates,
  shifts: normalizationManifest.counts.shiftCandidates,
  issues: normalizationManifest.counts.blockingIssues + normalizationManifest.counts.warnings,
})

const sourceRecord = {
  filename: artifactManifest.source.filename,
  sha256: artifactManifest.source.sha256,
  byteSize: artifactManifest.source.byteSize,
  storagePath: storagePathArgument,
}

function candidateRecord(kind, candidateKey, confidence, payload, sourceReferences) {
  return {
    kind,
    candidateKey,
    confidence,
    payload,
    sourceReferences,
    fingerprint: fingerprint(payload),
  }
}

async function* scheduleCandidates() {
  for await (const schedule of readRecords(
    path.join(normalizedDirectory, 'weekly-schedules.ndjson'),
  )) {
    yield candidateRecord(
      'weekly_schedule',
      `sheet:${schedule.sourceSheetIndex}`,
      'review',
      schedule,
      [{
        sheetIndex: schedule.sourceSheetIndex,
        sheetName: schedule.sourceSheetName,
        address: schedule.sourceRange,
      }],
    )
  }
}

async function* employeeCandidates() {
  for await (const employee of readRecords(
    path.join(normalizedDirectory, 'directory-candidates.ndjson'),
  )) {
    yield candidateRecord(
      'employee',
      `cell:${employee.source.sheetIndex}:${employee.source.address}`,
      'review',
      employee,
      [employee.source],
    )
  }
}

async function* siteCandidates() {
  for await (const site of readRecords(path.join(normalizedDirectory, 'site-candidates.ndjson'))) {
    const confidence = site.qualificationEvidence.length === 1 ? 'review' : 'blocking_review'
    yield candidateRecord(
      'site',
      site.siteKeyCandidate,
      confidence,
      site,
      site.sourceContexts,
    )
  }
}

async function* shiftCandidates() {
  for await (const shift of readRecords(path.join(normalizedDirectory, 'shift-candidates.ndjson'))) {
    yield candidateRecord(
      'shift',
      `cell:${shift.sourceTime.sheetIndex}:${shift.sourceTime.address}`,
      shift.confidence,
      shift,
      [shift.sourceContext, shift.sourceTime, shift.sourceAssignment].filter(Boolean),
    )
  }
}

async function countRecords(records) {
  let count = 0
  for await (const _record of records) count += 1
  return count
}

const candidateFactories = [
  scheduleCandidates,
  employeeCandidates,
  siteCandidates,
  shiftCandidates,
]

const expectedCandidateCount =
  normalizationManifest.counts.weeklySchedules
  + normalizationManifest.counts.directoryCandidates
  + normalizationManifest.counts.siteCandidates
  + normalizationManifest.counts.shiftCandidates

const dryRunCandidateCount = (
  await Promise.all(candidateFactories.map((factory) => countRecords(factory())))
).reduce((total, count) => total + count, 0)

if (dryRunCandidateCount !== expectedCandidateCount) {
  throw new Error('Candidate preparation count does not match the normalization manifest.')
}

const reconciliationSha256 = createHash('sha256')
  .update(
    [sourceRecord.sha256, ...evidenceRecords
      .sort((left, right) => left.kind.localeCompare(right.kind))
      .map((item) => `${item.kind}:${item.sha256}`)]
      .join('|'),
  )
  .digest('hex')

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    mode: 'dry-run',
    sourceSha256: sourceRecord.sha256,
    evidenceFileCount: evidenceRecords.length,
    sourceSheetCount: artifactManifest.counts.sheets,
    sourceCellCount: artifactManifest.counts.cells,
    ooxmlCellMetadataCount: ooxmlManifest.counts.cells,
    candidateCount: expectedCandidateCount,
    issueCount: normalizationManifest.counts.blockingIssues + normalizationManifest.counts.warnings,
    promotionEligible: normalizationManifest.promotionEligible,
    reconciliationSha256,
    verified: true,
  })}\n`)
  process.exit(0)
}

const supabaseUrl = process.env.SUPABASE_URL?.trim()
const supabaseSecretKey = (
  process.env.SUPABASE_SECRET_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
)?.trim()

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error('SUPABASE_URL and a server secret key are required outside dry-run mode.')
}

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function rpc(name, parameters) {
  const { data, error } = await supabase.rpc(name, parameters)
  if (error) throw new Error(`${name} failed: ${error.message}`)
  return data
}

const importRunId = await rpc('register_source_import', {
  source_record: sourceRecord,
  evidence_records: evidenceRecords,
  extractor_version: `${artifactManifest.extractorVersion}+${ooxmlManifest.extractorVersion}+${normalizationManifest.normalizerVersion}`,
})

async function ingestFile(functionName, filePath, batchSize) {
  let count = 0
  for await (const batch of batches(readRecords(filePath), batchSize)) {
    count += await rpc(functionName, {
      target_import_run_id: importRunId,
      records: batch,
    })
  }
  return count
}

await ingestFile('ingest_source_sheets', path.join(evidenceDirectory, 'sheets.ndjson'), 200)
await ingestFile('ingest_source_cells', path.join(evidenceDirectory, 'cells.ndjson'), 400)
await ingestFile(
  'ingest_ooxml_sheet_metadata',
  path.join(evidenceDirectory, 'ooxml-sheets.ndjson'),
  200,
)
await ingestFile(
  'ingest_ooxml_cell_metadata',
  path.join(evidenceDirectory, 'ooxml-cells.ndjson'),
  300,
)
await ingestFile(
  'ingest_source_annotations',
  path.join(evidenceDirectory, 'ooxml-annotations.ndjson'),
  200,
)
await ingestFile(
  'ingest_source_relationships',
  path.join(evidenceDirectory, 'ooxml-relationships.ndjson'),
  200,
)

for (const factory of candidateFactories) {
  for await (const batch of batches(factory(), 300)) {
    await rpc('ingest_import_candidates', {
      target_import_run_id: importRunId,
      records: batch,
    })
  }
}

await ingestFile(
  'ingest_import_issues',
  path.join(normalizedDirectory, 'normalization-issues.ndjson'),
  300,
)

await rpc('finalize_source_import', {
  target_import_run_id: importRunId,
  expected_sheet_count: artifactManifest.counts.sheets,
  expected_cell_count: artifactManifest.counts.cells,
  expected_candidate_count: expectedCandidateCount,
  reconciliation_sha256: reconciliationSha256,
})

process.stdout.write(`${JSON.stringify({
  importRunId,
  sourceSha256: sourceRecord.sha256,
  candidateCount: expectedCandidateCount,
  reconciliationSha256,
  status: 'review',
})}\n`)

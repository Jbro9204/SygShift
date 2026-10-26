import { pathToFileURL } from 'node:url'

const ENRICHMENT_KEYS = [
  'workType',
  'workTypeLabel',
  'payCode',
  'workTypePaid',
  'workTypeOvertimeEligible',
  'workTypeRateSource',
  'mixedWorkTypes',
]

export function validateDateRange(fromDate, throughDate) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  if (!validDate(fromDate) || !validDate(throughDate) || throughDate < fromDate
    || Date.parse(throughDate) - Date.parse(fromDate) > 45 * 86_400_000) {
    throw new Error('Supply a valid --from/--through range of at most 46 days.')
  }
}

export function normalizeCandidatePayload(payload) {
  const normalized = structuredClone(payload)
  delete normalized.serverTimestamp
  delete normalized.reviewContractVersion
  normalized.rows = (normalized.rows ?? []).map((row) => {
    const item = { ...row }
    for (const key of ENRICHMENT_KEYS) delete item[key]
    return item
  })
  return normalized
}

export function normalizeBaselinePayload(payload) {
  const normalized = structuredClone(payload)
  delete normalized.serverTimestamp
  return normalized
}

function parseArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  return {
    concurrency: Number(value('--concurrency') ?? 3),
    fromDate: value('--from'),
    repeat: Number(value('--repeat') ?? 2),
    throughDate: value('--through'),
  }
}

function assertPositiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`)
  }
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function validatePreviewPerformance({
  accessToken,
  anonKey,
  concurrency = 3,
  fetchImpl = fetch,
  fromDate,
  previewUrl,
  repeat = 2,
  throughDate,
}) {
  validateDateRange(fromDate, throughDate)
  assertPositiveInteger(concurrency, 'Concurrency', 6)
  assertPositiveInteger(repeat, 'Repeat count', 5)
  if (!/^https:\/\//.test(previewUrl ?? '')) throw new Error('A HTTPS preview URL is required.')
  if (!anonKey || !accessToken) throw new Error('Preview anon key and AAL2 access token are required.')

  const call = async (functionName) => {
    const startedAt = performance.now()
    const response = await fetchImpl(`${previewUrl.replace(/\/$/, '')}/rest/v1/rpc/${functionName}`, {
      body: JSON.stringify({ target_from_date: fromDate, target_through_date: throughDate }),
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
    const elapsedMs = performance.now() - startedAt
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`${functionName} failed with HTTP ${response.status}: ${payload?.code ?? 'unknown'}`)
    }
    if (elapsedMs >= 8_000) throw new Error(`${functionName} exceeded the eight-second application budget.`)
    return { elapsedMs, payload }
  }

  // Candidate-first and baseline-first orders prevent every candidate timing
  // from inheriting a cache warmed by the baseline implementation.
  const candidateFirst = await call('get_timekeeping_review_v2')
  const baselineAfter = await call('get_timekeeping_review')
  const baselineFirst = await call('get_timekeeping_review')
  const candidateAfter = await call('get_timekeeping_review_v2')

  const baselineNormalized = normalizeBaselinePayload(baselineAfter.payload)
  for (const candidate of [candidateFirst, candidateAfter]) {
    if (!jsonEqual(normalizeCandidatePayload(candidate.payload), baselineNormalized)) {
      throw new Error('Candidate review payload does not preserve the baseline payroll calculation.')
    }
  }
  if (!jsonEqual(normalizeBaselinePayload(baselineFirst.payload), baselineNormalized)) {
    throw new Error('Baseline review changed between order-varied requests.')
  }

  const repeated = []
  for (let index = 0; index < repeat; index += 1) repeated.push(await call('get_timekeeping_review_v2'))
  const concurrent = await Promise.all(
    Array.from({ length: concurrency }, () => call('get_timekeeping_review_v2')),
  )
  for (const result of [...repeated, ...concurrent]) {
    if (!jsonEqual(normalizeCandidatePayload(result.payload), baselineNormalized)) {
      throw new Error('Repeated or concurrent candidate review returned a different payroll calculation.')
    }
  }

  const durations = {
    baseline: [baselineAfter.elapsedMs, baselineFirst.elapsedMs],
    candidate: [candidateFirst.elapsedMs, candidateAfter.elapsedMs, ...repeated.map((item) => item.elapsedMs)],
    concurrentCandidate: concurrent.map((item) => item.elapsedMs),
  }
  return {
    concurrency,
    durations,
    fromDate,
    payloadRows: candidateFirst.payload?.rows?.length ?? 0,
    repeat,
    throughDate,
  }
}

async function main() {
  const input = parseArguments(process.argv.slice(2))
  const result = await validatePreviewPerformance({
    ...input,
    accessToken: process.env.SYGSHIFT_PREVIEW_ACCESS_TOKEN,
    anonKey: process.env.SYGSHIFT_PREVIEW_ANON_KEY,
    previewUrl: process.env.SYGSHIFT_PREVIEW_URL,
  })
  // Aggregate timings only. Never print tokens, keys, names, rows or payroll data.
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

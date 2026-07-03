import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

const FORMAT_VERSION = 'sygshift-normalized-candidates/v1'
const NORMALIZER_VERSION = '0.1.0'
const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
const REFERENCE_SHEETS = new Set(['KS Pink scheudule', 'Patrol', 'Contacts', 'Dispatch Phone Schedule'])
const DIRECTORY_SECTIONS = new Map([
  ['FULL TIME', 'full_time'],
  ['PART TIME', 'part_time'],
  ['SUBSTITUTES', 'substitute'],
  ['Operations/Leadership', 'operations_leadership'],
  ['Terminated', 'terminated'],
])

const [evidenceDirectoryArgument, outputDirectoryArgument] = process.argv.slice(2)

if (!evidenceDirectoryArgument || !outputDirectoryArgument) {
  throw new Error(
    'Usage: normalize-evidence.mjs <private-evidence-directory> <private-output-directory>',
  )
}

const evidenceDirectory = path.resolve(evidenceDirectoryArgument)
const outputDirectory = path.resolve(outputDirectoryArgument)

async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function* readLines(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (line) yield line
  }
}

async function writeNdjson(filePath, records) {
  const handle = await fs.open(filePath, 'w')
  try {
    for (const record of records) {
      await handle.write(`${JSON.stringify(record)}\n`)
    }
  } finally {
    await handle.close()
  }
}

function cellKey(sheetIndex, address) {
  return `${sheetIndex}:${address}`
}

function columnNumber(name) {
  return [...name].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizedName(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizedSiteKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/\b(?:unarmed|armed)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function excelSerialToIsoDate(serial) {
  const milliseconds = Math.round((serial - 25_569) * 86_400_000)
  return new Date(milliseconds).toISOString().slice(0, 10)
}

function cellDate(cell) {
  if (!cell) return null
  if (cell.valueType === 'number' && Number.isInteger(cell.value) && cell.value > 20_000 && cell.value < 80_000) {
    return excelSerialToIsoDate(cell.value)
  }
  if (cell.valueType === 'date' && typeof cell.value === 'string') {
    return cell.value.slice(0, 10)
  }
  return null
}

function parseTimePart(value, allowTwentyFour = false) {
  const digits = value.replace(':', '').padStart(4, '0')
  if (!/^\d{4}$/.test(digits)) return null
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2))
  if (minutes > 59 || hours > 24 || (hours === 24 && (!allowTwentyFour || minutes !== 0))) return null
  return {
    hours: hours === 24 ? 0 : hours,
    minutes,
    value: `${String(hours === 24 ? 0 : hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    nextDay: hours === 24,
  }
}

function parseTimeRange(value) {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d{1,2}:?\d{2}|\d{3,4})\s*[-–—]\s*(\d{1,2}:?\d{2}|\d{3,4})\s*$/.exec(value)
  if (!match) return null
  const start = parseTimePart(match[1], false)
  const end = parseTimePart(match[2], true)
  if (!start || !end) return null
  const startMinutes = start.hours * 60 + start.minutes
  const endMinutes = end.hours * 60 + end.minutes
  return {
    startTime: start.value,
    endTime: end.value,
    crossesMidnight: end.nextDay || endMinutes <= startMinutes,
  }
}

function sourceReference(sheet, cell) {
  return {
    sheetIndex: sheet.index,
    sheetName: sheet.name,
    address: cell.address,
  }
}

function isPatrolOrNoteText(value) {
  return /\b(hit|hits|patrol route|lock up|lunch break|off|coverage note|notes?)\b/i.test(value)
}

function rowValues(rowMap) {
  return [...rowMap.values()]
    .filter((cell) => cell.valueType !== 'blank')
    .sort((left, right) => left.column - right.column)
}

function rowLabel(rowMap) {
  const strings = rowValues(rowMap)
    .map((cell) => text(cell.value))
    .filter(Boolean)
    .filter((value) => !parseTimeRange(value))
  return strings.sort((left, right) => right.length - left.length)[0] ?? null
}

function classifyQualification(label) {
  if (!label) return { requirement: 'unknown', complex: false }
  const armedMatches = label.match(/\barmed\b/gi) ?? []
  const unarmedMatches = label.match(/\bunarmed\b/gi) ?? []

  if (armedMatches.length > 0 && unarmedMatches.length > 0) {
    return { requirement: 'mixed', complex: true }
  }
  if (unarmedMatches.length > 0) {
    return { requirement: 'unarmed', complex: unarmedMatches.length > 1 }
  }
  if (armedMatches.length > 0) {
    return { requirement: 'armed', complex: armedMatches.length > 1 }
  }
  return { requirement: 'unknown', complex: false }
}

function detectWeekHeader(rows) {
  for (const [rowNumber, rowMap] of [...rows.entries()].sort((left, right) => left[0] - right[0])) {
    const sortedCells = rowValues(rowMap)
    for (let offset = 0; offset <= sortedCells.length - 7; offset += 1) {
      const candidate = sortedCells.slice(offset, offset + 7)
      const dates = candidate.map(cellDate)
      if (dates.some((date) => date === null)) continue
      if (!candidate.every((cell, index) => index === 0 || cell.column === candidate[index - 1].column + 1)) continue
      const epochDays = dates.map((date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000))
      if (!epochDays.every((day, index) => index === 0 || day === epochDays[index - 1] + 1)) continue

      const dayRow = rows.get(rowNumber + 1)
      if (!dayRow) continue
      const dayLabels = candidate.map((cell) => text(dayRow.get(cell.column)?.value).toUpperCase())
      if (!dayLabels.every((label, index) => label === DAY_NAMES[index])) continue

      return {
        dateRow: rowNumber,
        dayRow: rowNumber + 1,
        columns: candidate.map((cell) => cell.column),
        dates,
      }
    }
  }
  return null
}

function classifyRow(rowNumber, rowMap, weekHeader) {
  const cells = rowValues(rowMap)
  if (cells.length === 0) return 'blank'
  if (rowNumber === weekHeader?.dateRow) return 'calendar_dates'
  if (rowNumber === weekHeader?.dayRow) return 'day_names'

  const strings = cells.map((cell) => text(cell.value)).filter(Boolean)
  const timeRanges = strings.map(parseTimeRange).filter(Boolean)
  if (timeRanges.length > 0 && timeRanges.length === strings.length) return 'time_ranges'
  if (strings.some((value) => /\b(?:hrs?|hours?)\b/i.test(value))) return 'hours'
  if (strings.some((value) => /^notes?\b/i.test(value))) return 'notes'
  if (strings.some((value) => /dispatch phone coverage/i.test(value))) return 'dispatch_header'
  if (strings.some((value) => /\b(?:armed|unarmed)\b/i.test(value))) return 'qualification_header'
  if (strings.some(isPatrolOrNoteText)) return 'patrol_or_note'
  return 'text'
}

const artifactManifestPath = path.join(evidenceDirectory, 'manifest.json')
const ooxmlManifestPath = path.join(evidenceDirectory, 'ooxml-manifest.json')
const artifactManifest = JSON.parse(await fs.readFile(artifactManifestPath, 'utf8'))
const ooxmlManifest = JSON.parse(await fs.readFile(ooxmlManifestPath, 'utf8'))

if (artifactManifest.source.sha256 !== ooxmlManifest.source.sha256) {
  throw new Error('Artifact and OOXML evidence refer to different source files.')
}

for (const item of Object.values(artifactManifest.evidence)) {
  const filePath = path.join(evidenceDirectory, item.filename)
  if (await sha256(filePath) !== item.sha256) throw new Error(`Evidence fingerprint failed: ${item.filename}`)
}
for (const item of Object.values(ooxmlManifest.evidence)) {
  const filePath = path.join(evidenceDirectory, item.filename)
  if (await sha256(filePath) !== item.sha256) throw new Error(`OOXML fingerprint failed: ${item.filename}`)
}

const sheets = []
for await (const line of readLines(path.join(evidenceDirectory, 'sheets.ndjson'))) {
  sheets.push(JSON.parse(line))
}

const mergedHeaderRowsBySheet = new Map()
for await (const line of readLines(path.join(evidenceDirectory, 'ooxml-sheets.ndjson'))) {
  const sheet = JSON.parse(line)
  const mergedRows = new Set()
  for (const range of sheet.mergedRanges) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)
    if (!match) continue
    const [, startColumn, startRow, endColumn, endRow] = match
    if (startRow === endRow && columnNumber(endColumn) > columnNumber(startColumn)) {
      mergedRows.add(Number(startRow))
    }
  }
  mergedHeaderRowsBySheet.set(sheet.index, mergedRows)
}

const rowsBySheet = new Map()
for await (const line of readLines(path.join(evidenceDirectory, 'cells.ndjson'))) {
  const cell = JSON.parse(line)
  if (cell.valueType === 'blank' && cell.formula === null) continue
  if (!rowsBySheet.has(cell.sheetIndex)) rowsBySheet.set(cell.sheetIndex, new Map())
  const rows = rowsBySheet.get(cell.sheetIndex)
  if (!rows.has(cell.row)) rows.set(cell.row, new Map())
  rows.get(cell.row).set(cell.column, cell)
}

const boldCells = new Set()
for await (const line of readLines(path.join(evidenceDirectory, 'ooxml-cells.ndjson'))) {
  const cell = JSON.parse(line)
  if (cell.bold) boldCells.add(cellKey(cell.sheetIndex, cell.address))
}

const weeklySchedules = []
const issues = []
const sheetClassifications = []

for (const sheet of sheets) {
  const rows = rowsBySheet.get(sheet.index) ?? new Map()
  if (sheet.rowCount === 0 || sheet.columnCount === 0) {
    sheetClassifications.push({ ...sheet, classification: 'blank' })
    continue
  }
  if (REFERENCE_SHEETS.has(sheet.name)) {
    sheetClassifications.push({ ...sheet, classification: 'reference' })
    continue
  }

  const weekHeader = detectWeekHeader(rows)
  if (!weekHeader) {
    sheetClassifications.push({ ...sheet, classification: 'unknown' })
    issues.push({
      severity: 'blocking',
      code: 'UNCLASSIFIED_SHEET',
      sheetIndex: sheet.index,
      source: { sheetIndex: sheet.index, sheetName: sheet.name, address: sheet.address },
      message: 'The worksheet could not be classified as a weekly schedule or known reference tab.',
    })
    continue
  }

  sheetClassifications.push({ ...sheet, classification: 'weekly_schedule' })
  weeklySchedules.push({
    sourceSheetIndex: sheet.index,
    sourceSheetName: sheet.name,
    sourceRange: sheet.address,
    weekStartsOn: weekHeader.dates[0],
    weekEndsOn: weekHeader.dates[6],
    dateHeaderRow: weekHeader.dateRow,
    dayHeaderRow: weekHeader.dayRow,
    dayColumns: weekHeader.columns,
    rowTypes: [...rows.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([rowNumber, rowMap]) => ({
        row: rowNumber,
        type: classifyRow(rowNumber, rowMap, weekHeader),
      })),
  })
}

if (weeklySchedules.length !== 140) {
  issues.push({
    severity: 'blocking',
    code: 'WEEKLY_SHEET_COUNT_MISMATCH',
    source: null,
    message: `Expected 140 weekly schedule sheets but classified ${weeklySchedules.length}.`,
  })
}

const contactsSheet = sheets.find((sheet) => sheet.name === 'Contacts')
if (!contactsSheet) throw new Error('The Contacts worksheet is missing.')
const contactRows = rowsBySheet.get(contactsSheet.index) ?? new Map()
const expectedContactHeaders = [
  'NAME',
  'PHONE',
  'EMAIL',
  'LOCATION',
  'Schedule availabilities',
  'EmployeeDG',
  'HOURS',
  'Guard Card',
  'NOTES',
  'Supervisor',
]

const actualContactHeaders = expectedContactHeaders.map((_, index) =>
  text(contactRows.get(1)?.get(index + 1)?.value),
)
if (!actualContactHeaders.every((header, index) => header === expectedContactHeaders[index])) {
  issues.push({
    severity: 'blocking',
    code: 'CONTACT_HEADER_MISMATCH',
    source: { sheetIndex: contactsSheet.index, sheetName: contactsSheet.name, address: 'A1:J1' },
    message: 'The Contacts worksheet headers do not match the reviewed source structure.',
  })
}

const directoryCandidates = []
let currentSection = null
for (let row = 2; row <= contactsSheet.rowCount; row += 1) {
  const rowMap = contactRows.get(row) ?? new Map()
  const nameCell = rowMap.get(1)
  const name = text(nameCell?.value)
  if (!name || name === 'BOLD=ARMED') continue

  if (DIRECTORY_SECTIONS.has(name)) {
    currentSection = DIRECTORY_SECTIONS.get(name)
    continue
  }

  if (!currentSection) {
    issues.push({
      severity: 'blocking',
      code: 'DIRECTORY_SECTION_MISSING',
      source: sourceReference(contactsSheet, nameCell),
      message: 'A directory row appears before a recognized employment section.',
    })
    continue
  }

  const values = Array.from({ length: 10 }, (_, index) => rowMap.get(index + 1)?.value ?? null)
  const candidate = {
    source: sourceReference(contactsSheet, nameCell),
    sourceRow: row,
    section: currentSection,
    name: values[0],
    phone: values[1],
    email: values[2],
    location: values[3],
    scheduleAvailability: values[4],
    employeeDg: values[5],
    hours: values[6],
    guardCard: values[7],
    notes: values[8],
    supervisor: values[9],
    armed: boldCells.has(cellKey(contactsSheet.index, nameCell.address)),
    roleCandidate: currentSection === 'operations_leadership' ? 'supervisor' : 'guard',
    statusCandidate: currentSection === 'terminated' ? 'separated' : 'active',
  }
  directoryCandidates.push(candidate)

  if (currentSection !== 'terminated' && !text(candidate.phone) && !text(candidate.email)) {
    issues.push({
      severity: 'warning',
      code: 'ACTIVE_DIRECTORY_CONTACT_MISSING',
      source: candidate.source,
      message: 'An active directory candidate has neither a phone number nor an email address.',
    })
  }
}

const candidatesByName = new Map()
for (const candidate of directoryCandidates) {
  const key = normalizedName(candidate.name)
  if (!candidatesByName.has(key)) candidatesByName.set(key, [])
  candidatesByName.get(key).push(candidate)
}
for (const candidates of candidatesByName.values()) {
  if (candidates.length > 1) {
    issues.push({
      severity: 'blocking',
      code: 'DIRECTORY_DUPLICATE_NAME_REVIEW',
      source: candidates[0].source,
      relatedSources: candidates.map((candidate) => candidate.source),
      message: 'Multiple directory rows normalize to the same name and must not be merged automatically.',
    })
  }
}

const shiftCandidates = []
const shiftIssueKeys = new Set()

function addShiftIssueOnce(key, issue) {
  if (shiftIssueKeys.has(key)) return
  shiftIssueKeys.add(key)
  issues.push(issue)
}

for (const schedule of weeklySchedules) {
  const sheet = sheets.find((item) => item.index === schedule.sourceSheetIndex)
  const rows = rowsBySheet.get(sheet.index) ?? new Map()
  let activeContext = null

  for (let row = schedule.dayHeaderRow + 1; row <= sheet.startRow + sheet.rowCount - 1; row += 1) {
    const rowMap = rows.get(row) ?? new Map()
    const rowType = classifyRow(row, rowMap, {
      dateRow: schedule.dateHeaderRow,
      dayRow: schedule.dayHeaderRow,
    })

    if (rowType === 'qualification_header' || rowType === 'dispatch_header') {
      const label = rowLabel(rowMap)
      activeContext = {
        row,
        label,
        ...classifyQualification(label),
      }
      continue
    }

    const nextRowMap = rows.get(row + 1) ?? new Map()
    const currentRowContainsTime = schedule.dayColumns.some((column) =>
      parseTimeRange(rowMap.get(column)?.value),
    )
    const nextRowContainsTime = schedule.dayColumns.some((column) =>
      parseTimeRange(nextRowMap.get(column)?.value),
    )
    if (
      rowType === 'text'
      && !currentRowContainsTime
      && nextRowContainsTime
      && mergedHeaderRowsBySheet.get(sheet.index)?.has(row)
    ) {
      const label = rowLabel(rowMap)
      if (label) {
        activeContext = {
          row,
          label,
          ...classifyQualification(label),
        }
        continue
      }
    }

    for (let dayIndex = 0; dayIndex < schedule.dayColumns.length; dayIndex += 1) {
      const column = schedule.dayColumns[dayIndex]
      const timeCell = rowMap.get(column)
      const parsedTime = parseTimeRange(timeCell?.value)
      if (!parsedTime) continue

      let assignmentCell = null
      for (let followingRow = row + 1; followingRow <= Math.min(row + 2, sheet.startRow + sheet.rowCount - 1); followingRow += 1) {
        const possibleCell = rows.get(followingRow)?.get(column)
        const possibleText = text(possibleCell?.value)
        if (!possibleText) continue
        if (parseTimeRange(possibleText) || isPatrolOrNoteText(possibleText)) break
        assignmentCell = possibleCell
        break
      }

      const assigneeLabel = assignmentCell ? text(assignmentCell.value) : null
      const candidate = {
        sourceSchedule: {
          sheetIndex: sheet.index,
          sheetName: sheet.name,
          weekStartsOn: schedule.weekStartsOn,
        },
        sourceTime: sourceReference(sheet, timeCell),
        sourceContext: activeContext
          ? { sheetIndex: sheet.index, sheetName: sheet.name, address: `A${activeContext.row}:${sheet.address.split(':')[1].replace(/\d+$/, activeContext.row)}` }
          : null,
        sourceAssignment: assignmentCell ? sourceReference(sheet, assignmentCell) : null,
        localDate: schedule.dayColumns[dayIndex] ? schedule.weekStartsOn : null,
        dayOffset: dayIndex,
        ...parsedTime,
        contextLabel: activeContext?.label ?? null,
        siteKeyCandidate: activeContext?.label ? normalizedSiteKey(activeContext.label) : null,
        qualificationCandidate: activeContext?.requirement ?? 'unknown',
        assigneeLabel,
        openCandidate: !assigneeLabel,
        confidence: activeContext
          && !activeContext.complex
          && activeContext.requirement !== 'unknown'
          ? 'review'
          : 'blocking_review',
      }
      candidate.localDate = new Date(
        Date.parse(`${schedule.weekStartsOn}T00:00:00Z`) + dayIndex * 86_400_000,
      ).toISOString().slice(0, 10)
      shiftCandidates.push(candidate)

      if (!activeContext) {
        addShiftIssueOnce(`${sheet.index}:missing:${row}`, {
          severity: 'blocking',
          code: 'SHIFT_CONTEXT_MISSING',
          source: candidate.sourceTime,
          message: 'A shift time has no preceding recognized site or coverage context.',
        })
      } else if (activeContext.complex || activeContext.requirement === 'mixed') {
        addShiftIssueOnce(`${sheet.index}:complex:${activeContext.row}`, {
          severity: 'blocking',
          code: 'SHIFT_CONTEXT_COMPLEX',
          source: candidate.sourceTime,
          relatedSources: [candidate.sourceContext],
          message: 'A shift belongs to a combined or mixed-qualification source section and requires manual mapping.',
        })
      }

      if (assigneeLabel && /[/&,]|\band\b/i.test(assigneeLabel)) {
        issues.push({
          severity: 'warning',
          code: 'SHIFT_ASSIGNEE_MULTIPLE_OR_AMBIGUOUS',
          source: candidate.sourceAssignment,
          message: 'The assignment cell may refer to more than one person and will not be split automatically.',
        })
      }
    }
  }
}

const siteGroups = new Map()
for (const shift of shiftCandidates) {
  if (!shift.siteKeyCandidate || !shift.contextLabel || !shift.sourceContext) continue
  if (!siteGroups.has(shift.siteKeyCandidate)) {
    siteGroups.set(shift.siteKeyCandidate, {
      siteKeyCandidate: shift.siteKeyCandidate,
      labels: new Set(),
      requirements: new Set(),
      sourceContexts: new Map(),
      shiftCandidateCount: 0,
    })
  }
  const group = siteGroups.get(shift.siteKeyCandidate)
  group.labels.add(shift.contextLabel)
  if (shift.qualificationCandidate !== 'unknown' && shift.qualificationCandidate !== 'mixed') {
    group.requirements.add(shift.qualificationCandidate)
  }
  const sourceKey = `${shift.sourceContext.sheetIndex}:${shift.sourceContext.address}`
  group.sourceContexts.set(sourceKey, shift.sourceContext)
  group.shiftCandidateCount += 1
}

const siteCandidates = [...siteGroups.values()]
  .map((group) => {
    const requirements = [...group.requirements].sort()
    const sources = [...group.sourceContexts.values()].sort((left, right) =>
      left.sheetIndex - right.sheetIndex || left.address.localeCompare(right.address),
    )
    return {
      siteKeyCandidate: group.siteKeyCandidate,
      labelVariants: [...group.labels].sort(),
      qualificationCandidate: requirements.length === 1 ? requirements[0] : 'unknown',
      qualificationEvidence: requirements,
      sourceContexts: sources,
      shiftCandidateCount: group.shiftCandidateCount,
    }
  })
  .sort((left, right) => left.siteKeyCandidate.localeCompare(right.siteKeyCandidate))

for (const site of siteCandidates) {
  if (site.qualificationEvidence.length === 0) {
    issues.push({
      severity: 'blocking',
      code: 'SITE_QUALIFICATION_UNKNOWN',
      source: site.sourceContexts[0],
      relatedSources: site.sourceContexts.slice(1),
      message: 'No source occurrence identifies whether this site or coverage section is armed or unarmed.',
    })
  } else if (site.qualificationEvidence.length > 1) {
    issues.push({
      severity: 'blocking',
      code: 'SITE_QUALIFICATION_CONFLICT',
      source: site.sourceContexts[0],
      relatedSources: site.sourceContexts.slice(1),
      message: 'Source occurrences disagree about whether this site or coverage section is armed or unarmed.',
    })
  }
}

await fs.mkdir(outputDirectory, { recursive: true })
const outputFiles = {
  sheets: path.join(outputDirectory, 'sheet-classifications.ndjson'),
  schedules: path.join(outputDirectory, 'weekly-schedules.ndjson'),
  directory: path.join(outputDirectory, 'directory-candidates.ndjson'),
  sites: path.join(outputDirectory, 'site-candidates.ndjson'),
  shifts: path.join(outputDirectory, 'shift-candidates.ndjson'),
  issues: path.join(outputDirectory, 'normalization-issues.ndjson'),
}

await writeNdjson(outputFiles.sheets, sheetClassifications)
await writeNdjson(outputFiles.schedules, weeklySchedules)
await writeNdjson(outputFiles.directory, directoryCandidates)
await writeNdjson(outputFiles.sites, siteCandidates)
await writeNdjson(outputFiles.shifts, shiftCandidates)
await writeNdjson(outputFiles.issues, issues)

const evidence = Object.fromEntries(
  await Promise.all(
    Object.entries(outputFiles).map(async ([key, filePath]) => [
      key,
      { filename: path.basename(filePath), sha256: await sha256(filePath) },
    ]),
  ),
)

const classificationCounts = sheetClassifications.reduce((counts, sheet) => {
  counts[sheet.classification] = (counts[sheet.classification] ?? 0) + 1
  return counts
}, {})
const blockingIssueCount = issues.filter((issue) => issue.severity === 'blocking').length
const warningCount = issues.filter((issue) => issue.severity === 'warning').length

const manifest = {
  formatVersion: FORMAT_VERSION,
  normalizerVersion: NORMALIZER_VERSION,
  source: {
    sha256: artifactManifest.source.sha256,
    artifactEvidenceFormat: artifactManifest.formatVersion,
    ooxmlEvidenceFormat: ooxmlManifest.formatVersion,
  },
  counts: {
    sheetClassifications: classificationCounts,
    weeklySchedules: weeklySchedules.length,
    directoryCandidates: directoryCandidates.length,
    armedDirectoryCandidates: directoryCandidates.filter((candidate) => candidate.armed).length,
    siteCandidates: siteCandidates.length,
    shiftCandidates: shiftCandidates.length,
    blockingIssues: blockingIssueCount,
    warnings: warningCount,
  },
  promotionEligible: blockingIssueCount === 0,
  evidence,
}

await fs.writeFile(
  path.join(outputDirectory, 'normalization-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

process.stdout.write(`${JSON.stringify({
  sourceSha256: manifest.source.sha256,
  classifications: manifest.counts.sheetClassifications,
  weeklyScheduleCount: manifest.counts.weeklySchedules,
  directoryCandidateCount: manifest.counts.directoryCandidates,
  armedDirectoryCandidateCount: manifest.counts.armedDirectoryCandidates,
  siteCandidateCount: manifest.counts.siteCandidates,
  shiftCandidateCount: manifest.counts.shiftCandidates,
  blockingIssueCount,
  warningCount,
  promotionEligible: manifest.promotionEligible,
  evidenceSha256: createHash('sha256')
    .update(Object.values(evidence).map((item) => item.sha256).join(':'))
    .digest('hex'),
})}\n`)

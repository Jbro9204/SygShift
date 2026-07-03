import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool'

const FORMAT_VERSION = 'sygshift-source-evidence/v1'
const EXTRACTOR_VERSION = '0.1.0'

const [sourcePathArgument, outputDirectoryArgument, expectedSha256Argument] = process.argv.slice(2)

if (!sourcePathArgument || !outputDirectoryArgument) {
  throw new Error(
    'Usage: extract-workbook.mjs <source.xlsx> <private-output-directory> [expected-sha256]',
  )
}

const sourcePath = path.resolve(sourcePathArgument)
const outputDirectory = path.resolve(outputDirectoryArgument)

function columnName(columnNumber) {
  let result = ''
  let remaining = columnNumber

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    remaining = Math.floor((remaining - 1) / 26)
  }

  return result
}

function parseRangeAddress(address) {
  const match = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(address)
  if (!match) {
    throw new Error(`Unsupported worksheet range address: ${address}`)
  }

  const [, startColumnName, startRowText, endColumnName, endRowText] = match

  const columnNumber = (name) =>
    [...name].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0)

  return {
    startColumn: columnNumber(startColumnName),
    startRow: Number(startRowText),
    endColumn: columnNumber(endColumnName),
    endRow: Number(endRowText),
  }
}

function encodeValue(value) {
  if (value === null || value === undefined) {
    return { type: 'blank', value: null }
  }

  if (value instanceof Date) {
    return { type: 'date', value: value.toISOString() }
  }

  if (typeof value === 'string') {
    return { type: 'string', value }
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('The workbook contained a non-finite numeric value.')
    }
    return { type: 'number', value }
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean', value }
  }

  return { type: 'structured', value }
}

async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function writeLine(fileHandle, record) {
  await fileHandle.write(`${JSON.stringify(record)}\n`)
}

async function* readLines(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (line) yield line
  }
}

async function verifyEvidence(manifest, sheetsPath, cellsPath) {
  const [actualSheetsSha256, actualCellsSha256] = await Promise.all([
    sha256(sheetsPath),
    sha256(cellsPath),
  ])

  if (actualSheetsSha256 !== manifest.evidence.sheets.sha256) {
    throw new Error('Worksheet evidence fingerprint verification failed.')
  }

  if (actualCellsSha256 !== manifest.evidence.cells.sha256) {
    throw new Error('Cell evidence fingerprint verification failed.')
  }

  const sheets = new Map()
  for await (const line of readLines(sheetsPath)) {
    const sheet = JSON.parse(line)
    if (sheets.has(sheet.index)) {
      throw new Error(`Duplicate worksheet index ${sheet.index}.`)
    }
    sheets.set(sheet.index, sheet)
  }

  if (sheets.size !== manifest.counts.sheets) {
    throw new Error('Worksheet evidence count verification failed.')
  }

  for (let index = 0; index < sheets.size; index += 1) {
    if (!sheets.has(index)) {
      throw new Error(`Missing worksheet index ${index}.`)
    }
  }

  let verifiedCellCount = 0
  let verifiedPopulatedCellCount = 0
  let verifiedFormulaCellCount = 0
  let previousKey = null

  for await (const line of readLines(cellsPath)) {
    const cell = JSON.parse(line)
    const sheet = sheets.get(cell.sheetIndex)
    if (!sheet || sheet.rowCount === 0 || sheet.columnCount === 0) {
      throw new Error(`Cell ${cell.address} references an invalid worksheet range.`)
    }

    if (
      cell.row < sheet.startRow
      || cell.row >= sheet.startRow + sheet.rowCount
      || cell.column < sheet.startColumn
      || cell.column >= sheet.startColumn + sheet.columnCount
    ) {
      throw new Error(`Cell ${cell.address} is outside its recorded worksheet range.`)
    }

    if (cell.address !== `${columnName(cell.column)}${cell.row}`) {
      throw new Error(`Cell address verification failed for ${cell.address}.`)
    }

    const key = `${String(cell.sheetIndex).padStart(6, '0')}:${String(cell.row).padStart(8, '0')}:${String(cell.column).padStart(8, '0')}`
    if (previousKey !== null && key <= previousKey) {
      throw new Error(`Cell ordering or uniqueness verification failed at ${cell.address}.`)
    }
    previousKey = key

    verifiedCellCount += 1
    if (cell.valueType !== 'blank') verifiedPopulatedCellCount += 1
    if (cell.formula !== null) verifiedFormulaCellCount += 1
  }

  if (
    verifiedCellCount !== manifest.counts.cells
    || verifiedPopulatedCellCount !== manifest.counts.populatedCells
    || verifiedFormulaCellCount !== manifest.counts.formulaCells
  ) {
    throw new Error('Cell evidence count verification failed.')
  }

  return true
}

const sourceStat = await fs.stat(sourcePath)
const sourceSha256 = await sha256(sourcePath)

if (
  expectedSha256Argument
  && sourceSha256.toLowerCase() !== expectedSha256Argument.trim().toLowerCase()
) {
  throw new Error(
    `Source fingerprint mismatch. Expected ${expectedSha256Argument}, received ${sourceSha256}.`,
  )
}

await fs.mkdir(outputDirectory, { recursive: true })

const existingManifestPath = path.join(outputDirectory, 'manifest.json')
try {
  const existingManifest = JSON.parse(await fs.readFile(existingManifestPath, 'utf8'))
  if (existingManifest.source?.sha256 && existingManifest.source.sha256 !== sourceSha256) {
    throw new Error('The output directory already contains evidence for a different source file.')
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error
  }
}

const input = await FileBlob.load(sourcePath)
const workbook = await SpreadsheetFile.importXlsx(input)
const inspection = await workbook.inspect({
  kind: 'workbook,sheet',
  include: 'id,name',
  maxChars: 100_000,
})

const inspectionRecords = inspection.ndjson
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const sheetRecords = inspectionRecords
  .filter((record) => record.kind === 'sheet')
  .sort((left, right) => left.index - right.index)

if (sheetRecords.length === 0) {
  throw new Error('The workbook did not contain any worksheets.')
}

const sheetsPath = path.join(outputDirectory, 'sheets.ndjson')
const cellsPath = path.join(outputDirectory, 'cells.ndjson')
const sheetsFile = await fs.open(sheetsPath, 'w')
const cellsFile = await fs.open(cellsPath, 'w')

let cellCount = 0
let populatedCellCount = 0
let formulaCellCount = 0

try {
  for (const sheetRecord of sheetRecords) {
    const worksheet = workbook.worksheets.getItemAt(sheetRecord.index)

    if (!sheetRecord.address) {
      await writeLine(sheetsFile, {
        index: sheetRecord.index,
        name: sheetRecord.name,
        address: null,
        startRow: null,
        startColumn: null,
        rowCount: 0,
        columnCount: 0,
      })
      continue
    }

    const rangeBounds = parseRangeAddress(sheetRecord.address)
    const rowCount = rangeBounds.endRow - rangeBounds.startRow + 1
    const columnCount = rangeBounds.endColumn - rangeBounds.startColumn + 1
    const sourceRange = worksheet.getRange(sheetRecord.address)
    const values = sourceRange.values
    const formulas = sourceRange.formulas

    if (values.length !== rowCount || formulas.length !== rowCount) {
      throw new Error(`Row count mismatch while extracting worksheet ${sheetRecord.index}.`)
    }

    await writeLine(sheetsFile, {
      index: sheetRecord.index,
      name: sheetRecord.name,
      address: sheetRecord.address,
      startRow: rangeBounds.startRow,
      startColumn: rangeBounds.startColumn,
      rowCount,
      columnCount,
    })

    for (let rowOffset = 0; rowOffset < rowCount; rowOffset += 1) {
      if (
        values[rowOffset]?.length !== columnCount
        || formulas[rowOffset]?.length !== columnCount
      ) {
        throw new Error(
          `Column count mismatch in worksheet ${sheetRecord.index}, row ${rowOffset + 1}.`,
        )
      }

      for (let columnOffset = 0; columnOffset < columnCount; columnOffset += 1) {
        const row = rangeBounds.startRow + rowOffset
        const column = rangeBounds.startColumn + columnOffset
        const address = `${columnName(column)}${row}`
        const encoded = encodeValue(values[rowOffset][columnOffset])
        const formulaValue = formulas[rowOffset][columnOffset]
        const formula = typeof formulaValue === 'string' && formulaValue.startsWith('=')
          ? formulaValue
          : null

        cellCount += 1
        if (encoded.type !== 'blank') populatedCellCount += 1
        if (formula) formulaCellCount += 1

        await writeLine(cellsFile, {
          sheetIndex: sheetRecord.index,
          row,
          column,
          address,
          valueType: encoded.type,
          value: encoded.value,
          formula,
        })
      }
    }
  }
} finally {
  await Promise.all([sheetsFile.close(), cellsFile.close()])
}

const [sheetsSha256, cellsSha256] = await Promise.all([
  sha256(sheetsPath),
  sha256(cellsPath),
])

const manifest = {
  formatVersion: FORMAT_VERSION,
  extractorVersion: EXTRACTOR_VERSION,
  source: {
    filename: path.basename(sourcePath),
    sha256: sourceSha256,
    byteSize: sourceStat.size,
  },
  counts: {
    sheets: sheetRecords.length,
    cells: cellCount,
    populatedCells: populatedCellCount,
    blankCells: cellCount - populatedCellCount,
    formulaCells: formulaCellCount,
  },
  evidence: {
    sheets: { filename: 'sheets.ndjson', sha256: sheetsSha256 },
    cells: { filename: 'cells.ndjson', sha256: cellsSha256 },
  },
}

await fs.writeFile(existingManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const verified = await verifyEvidence(manifest, sheetsPath, cellsPath)

process.stdout.write(`${JSON.stringify({
  sourceSha256,
  sheetCount: manifest.counts.sheets,
  cellCount: manifest.counts.cells,
  populatedCellCount: manifest.counts.populatedCells,
  formulaCellCount: manifest.counts.formulaCells,
  verified,
  evidenceSha256: createHash('sha256')
    .update(`${sheetsSha256}:${cellsSha256}`)
    .digest('hex'),
})}\n`)

import { strToU8, zipSync } from 'fflate'

export type XlsxCell = string | number | boolean | null | undefined

export interface XlsxSheet {
  centerColumns?: number[]
  columnWidths?: number[]
  filterRowIndex?: number
  freezeRows?: number
  headerRows?: number[]
  integerColumns?: number[]
  metadataRows?: number[]
  mergedCells?: string[]
  name: string
  rows: XlsxCell[][]
  statusColumns?: number[]
  titleRows?: number[]
  wrapColumns?: number[]
}

const workbookMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function xmlEscape(value: string): string {
  const clean = [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return code === 9 || code === 10 || code === 13 || code >= 32
  }).join('')
  return clean
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function columnName(index: number): string {
  let name = ''
  let value = index + 1
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function styleForCell(sheet: XlsxSheet, cell: XlsxCell, rowIndex: number, columnIndex: number): number {
  if (sheet.titleRows?.includes(rowIndex)) return 1
  if (sheet.metadataRows?.includes(rowIndex)) return columnIndex === 0 ? 2 : 3
  if (sheet.headerRows?.includes(rowIndex)) return 4
  const normalized = String(cell ?? '').trim().toLocaleLowerCase()
  if (sheet.statusColumns?.includes(columnIndex)) {
    if (['current', 'compliant', 'eligible'].includes(normalized)) return 8
    if (normalized.includes('expir') || normalized.includes('pending') || normalized.includes('warning')) return 9
    if (['expired', 'not licensed', 'revoked', 'suspended', 'rejected', 'ineligible', 'restricted'].some((status) => normalized.includes(status))) return 10
  }
  if (sheet.wrapColumns?.includes(columnIndex)) return 11
  if (sheet.centerColumns?.includes(columnIndex)) return 12
  if (typeof cell === 'number' && sheet.integerColumns?.includes(columnIndex)) return 13
  if (typeof cell === 'number') return 7
  return 6
}

function cellXml(sheet: XlsxSheet, cell: XlsxCell, rowIndex: number, columnIndex: number): string {
  const reference = `${columnName(columnIndex)}${rowIndex + 1}`
  const style = styleForCell(sheet, cell, rowIndex, columnIndex)
  if (cell === null || cell === undefined || cell === '') return `<c r="${reference}" s="${style}"/>`
  if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${reference}" s="${style}"><v>${cell}</v></c>`
  if (typeof cell === 'boolean') return `<c r="${reference}" t="b" s="${style}"><v>${cell ? 1 : 0}</v></c>`
  return `<c r="${reference}" t="inlineStr" s="${style}"><is><t>${xmlEscape(String(cell))}</t></is></c>`
}

function worksheetXml(sheet: XlsxSheet): string {
  const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length))
  const rowCount = Math.max(1, sheet.rows.length)
  const freezeRows = sheet.freezeRows ?? 1
  const autoFilter = typeof sheet.filterRowIndex === 'number' && rowCount > sheet.filterRowIndex + 1
    ? `<autoFilter ref="A${sheet.filterRowIndex + 1}:${columnName(columnCount - 1)}${rowCount}"/>`
    : ''
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const width = sheet.columnWidths?.[index] ?? (index === 0 ? 24 : 16)
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  }).join('')
  const rows = sheet.rows.map((row, rowIndex) => {
    const height = sheet.titleRows?.includes(rowIndex) ? 38 : undefined
    return `<row r="${rowIndex + 1}"${height ? ` ht="${height}" customHeight="1"` : ''}>${row.map((cell, columnIndex) => cellXml(sheet, cell, rowIndex, columnIndex)).join('')}</row>`
  }).join('')
  const merges = sheet.mergedCells?.length
    ? `<mergeCells count="${sheet.mergedCells.length}">${sheet.mergedCells.map((reference) => `<mergeCell ref="${reference}"/>`).join('')}</mergeCells>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${columnName(columnCount - 1)}${rowCount}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85" zoomScaleNormal="85"><pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columns}</cols>
  <sheetData>${rows}</sheetData>
  ${autoFilter}
  ${merges}
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="9"/>
</worksheet>`
}

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="6">
    <font><sz val="11"/><name val="Aptos"/></font>
    <font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font>
    <font><b/><sz val="11"/><color rgb="FF201D19"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF8B352D"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF166044"/><name val="Aptos"/></font>
  </fonts>
  <fills count="9">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF171511"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF9B6A17"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF7EA"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE7F4ED"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFEDE9"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF5E4BE"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE4D8C2"/></left><right style="thin"><color rgb="FFE4D8C2"/></right><top style="thin"><color rgb="FFE4D8C2"/></top><bottom style="thin"><color rgb="FFE4D8C2"/></bottom><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFE7E1D7"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="14">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="2" fontId="0" fillId="5" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`

function workbookXml(sheets: XlsxSheet[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`
}

function workbookRelationshipsXml(sheets: XlsxSheet[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
}

function contentTypesXml(sheets: XlsxSheet[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`
}

const rootRelationshipsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

export function createXlsxWorkbookBlob(sheets: XlsxSheet[]): Blob {
  if (sheets.length === 0) throw new Error('The workbook needs at least one worksheet.')
  const archive = zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml(sheets)),
    '_rels/.rels': strToU8(rootRelationshipsXml),
    'xl/workbook.xml': strToU8(workbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelationshipsXml(sheets)),
    'xl/styles.xml': strToU8(stylesXml),
    ...Object.fromEntries(sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, strToU8(worksheetXml(sheet))])),
  }, { level: 6 })
  const buffer = new ArrayBuffer(archive.byteLength)
  new Uint8Array(buffer).set(archive)
  return new Blob([buffer], { type: workbookMimeType })
}

export function downloadXlsxWorkbook(sheets: XlsxSheet[], fileName: string): { fileName: string; size: number } {
  const workbook = createXlsxWorkbookBlob(sheets)
  if (workbook.size === 0) throw new Error('The workbook could not be created. Please try again.')
  const url = URL.createObjectURL(workbook)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { fileName, size: workbook.size }
}

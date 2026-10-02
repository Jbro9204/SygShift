import '@fontsource/alex-brush/400.css'
import '@fontsource/allura/400.css'
import '@fontsource/dancing-script/600.css'
import '@fontsource/great-vibes/400.css'

/* oxlint-disable react/only-export-components -- exported detector supports controlled-form corpus validation. */

import { useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FilePenLine,
  FileSignature,
  FolderInput,
  Maximize2,
  Minimize2,
  Minus,
  Move,
  Plus,
  Redo2,
  Scaling,
  Search,
  Send,
  Trash2,
  Type,
  Undo2,
  UploadCloud,
} from 'lucide-react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import { StandardFontEmbedder, StandardFonts } from 'pdf-lib'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { ModalDialog } from './ModalDialog'
import { SecurePdfViewer } from './SecurePdfViewer'
import { createSignatureEnvelope, getDocumentStudioWorkspace, sendSignatureEnvelope } from '../data/documentStudio'
import { uploadHrDocument, type HrDocumentWorkspace } from '../data/hrDocuments'
import {
  completedPdfFilename,
  createTypedSignaturePng,
  DEFAULT_SIGNATURE_WIDTH_RATIO,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_WIDTH_RATIO,
  finalizePdf,
  movePdfAnnotation,
  resizePdfAnnotation,
  resizePdfTextAnnotation,
  type PdfAnnotation,
  type PdfAnnotationKind,
  type PdfInlineSourceLine,
  type PdfInlineSourceSpan,
} from '../lib/pdfWorkbench'

GlobalWorkerOptions.workerSrc = workerUrl

type WorkbenchPanel = 'edit' | 'file' | 'send'
type RequiredAction = 'acknowledge' | 'approve' | 'certify' | 'review' | 'sign'
type SignatureFamily = 'Alex Brush' | 'Allura' | 'Dancing Script' | 'Great Vibes'

interface AnnotationGesture {
  annotationId: string
  changed: boolean
  mode: 'move' | 'resize'
  originalAnnotations: PdfAnnotation[]
  pointerId: number
  sheetHeight: number
  sheetWidth: number
  startClientX: number
  startClientY: number
  startWidthRatio: number
  startXRatio: number
  startYRatio: number
}

const signatureFamilies: SignatureFamily[] = ['Great Vibes', 'Dancing Script', 'Allura', 'Alex Brush']
export const MAX_DETECTED_TEMPLATE_FIELDS = 500
const actionLabels: Record<RequiredAction, string> = {
  acknowledge: 'Acknowledge receipt',
  approve: 'Approve',
  certify: 'Certify',
  review: 'Review only',
  sign: 'Sign',
}

interface DocumentWorkbenchProps {
  employeeOnly?: boolean
  initialEmployeeId?: string
  initialFile?: File | null
  initialTitle?: string
  onClose: () => void
  onSaved: () => void
  workspace: HrDocumentWorkspace
}

export interface DetectedTemplateField {
  boxHeightRatio: number
  controlType: 'checkbox' | 'choice' | 'date' | 'long_text' | 'signature' | 'text'
  defaultValue?: string
  description: string
  eraseHeightRatio: number
  eraseWidthRatio: number
  fontSize: number
  groupLabel: string
  id: string
  layout: 'field-box' | 'inline-body'
  label: string
  mappingStatus: 'mapped' | 'review'
  nativeFieldName?: string
  options?: Array<{ label: string; value: string }>
  page: number
  rawLabel: string
  sourceLine?: PdfInlineSourceLine
  sourceSpan?: PdfInlineSourceSpan
  widthRatio: number
  xRatio: number
  yRatio: number
}

export interface TemplateFieldDetectionResult {
  fields: DetectedTemplateField[]
  truncated: boolean
}

interface PositionedPdfText {
  heightRatio: number
  leftRatio: number
  text: string
  topRatio: number
  widthRatio: number
}

const templateMetricFont = StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as Parameters<typeof StandardFontEmbedder.for>[0])

function textSpanFractions(text: string, start: number, length: number): { startFraction: number; widthFraction: number } {
  try {
    const totalWidth = templateMetricFont.widthOfTextAtSize(text, 100)
    if (totalWidth > 0) {
      const startWidth = templateMetricFont.widthOfTextAtSize(text.slice(0, start), 100)
      const spanWidth = templateMetricFont.widthOfTextAtSize(text.slice(start, start + length), 100)
      return { startFraction: startWidth / totalWidth, widthFraction: spanWidth / totalWidth }
    }
  } catch {
    // Unsupported glyphs fall back to the PDF text item's character ratios.
  }
  return {
    startFraction: start / Math.max(text.length, 1),
    widthFraction: length / Math.max(text.length, 1),
  }
}

type FieldPurpose = 'Date / time' | 'Printed name' | 'Signature'

interface TemplateFieldContext {
  controlType: DetectedTemplateField['controlType']
  description: string
  groupLabel: string
  label: string
  layout: DetectedTemplateField['layout']
  mappingStatus: DetectedTemplateField['mappingStatus']
}

function humanizePdfFieldName(value: string): string {
  const leaf = value.split('.').at(-1) ?? value
  const cleaned = leaf
    .replace(/\[\d+\]$/g, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'Document field'
  return cleaned.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase())
}

function inferredControlType(label: string, purpose?: FieldPurpose): DetectedTemplateField['controlType'] {
  if (purpose === 'Date / time' || /\bdate(?:\s*\/\s*time)?\b|mm\s*\/\s*dd\s*\/\s*yyyy|signed\s+(?:on|at)/i.test(label)) return 'date'
  if (purpose === 'Printed name') return 'text'
  if (purpose === 'Signature' || /enter\s*\/\s*sign|\b(?:sign|signature|initials?)\b/i.test(label)) return 'signature'
  return /(describe|description|details|explain|explanation|facts|narrative|notes?|reason|statement|summary)/i.test(label)
    ? 'long_text'
    : 'text'
}

function cleanTemplateLabel(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (/^mm\s*\/\s*dd\s*\/\s*yyyy$/i.test(compact)) return 'Date'
  if (/^enter\s+enter\b/i.test(compact)) return cleanTemplateLabel(compact.replace(/^enter\s+enter\s*/i, ''))
  if (/^enter\s*\/\s*sign$/i.test(compact)) return 'Signature'
  const cleaned = compact.replace(/^enter\s+(?=\w)/i, '')
  if (!cleaned) return 'Document field'
  const letters = cleaned.replace(/[^A-Za-z]/g, '')
  const readable = letters.length > 1 && letters === letters.toLocaleUpperCase()
    ? `${cleaned[0].toLocaleUpperCase()}${cleaned.slice(1).toLocaleLowerCase()}`
    : `${cleaned[0].toLocaleUpperCase()}${cleaned.slice(1)}`
  return readable
    .replace(/\bhr\b/gi, 'HR')
    .replace(/\bid\b/gi, 'ID')
    .replace(/\bdob\b/gi, 'DOB')
    .replace(/\bssn\b/gi, 'SSN')
}

function isIgnoredContextLabel(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return !normalized
    || /^(?:controlled template|version\s+[\d.]+|page\s+\d+(?:\s+of\s+\d+)?|continued)$/i.test(normalized)
    || /^[A-Z]{2,8}-[A-Z]{2,8}-\d{2,5}(?:\s*\|.*)?$/i.test(normalized)
}

function expandedContextSegments(positionedText: PositionedPdfText[]): PositionedPdfText[] {
  const expressions = [
    /printed\s+name/gi,
    /date(?:\s*\/\s*time)?/gi,
    /signature|initials?/gi,
  ]
  const expanded = [...positionedText]
  for (const item of positionedText) {
    const rowPrefix = item.text.includes('[') ? item.text.slice(0, item.text.indexOf('[')).trim() : ''
    if (rowPrefix) {
      expanded.push({
        ...item,
        text: rowPrefix,
        widthRatio: Math.max(.012, item.widthRatio * rowPrefix.length / Math.max(1, item.text.length)),
      })
    }
    for (const expression of expressions) {
      expression.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = expression.exec(item.text))) {
        const startFraction = match.index / Math.max(1, item.text.length)
        const widthFraction = match[0].length / Math.max(1, item.text.length)
        expanded.push({
          ...item,
          leftRatio: item.leftRatio + item.widthRatio * startFraction,
          text: match[0],
          widthRatio: Math.max(.012, item.widthRatio * widthFraction),
        })
      }
    }
  }
  return expanded
}

function fieldPurposeAt(positionedText: PositionedPdfText[], xRatio: number, yRatio: number, tableOnly = false): FieldPurpose | undefined {
  const headers = expandedContextSegments(positionedText).flatMap((candidate) => {
    const normalized = candidate.text.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
    const purpose: FieldPurpose | undefined = /printed name/.test(normalized)
      ? 'Printed name'
      : /^date(?:\s*\/\s*time)?$/.test(normalized)
        ? 'Date / time'
        : /^(?:signature|initials?)$/.test(normalized)
          ? 'Signature'
          : undefined
    if (!purpose || candidate.topRatio >= yRatio) return []
    const center = candidate.leftRatio + candidate.widthRatio / 2
    const verticalDistance = yRatio - candidate.topRatio
    const horizontalDistance = Math.abs(xRatio - center)
    if (verticalDistance > .22) return []
    return [{ center, horizontalDistance, purpose, score: verticalDistance * .8 + horizontalDistance * 2, topRatio: candidate.topRatio }]
  })

  const rowEntries = positionedText
    .filter((candidate) => /^\[\s*enter(?:\s*\/\s*sign)?\s*\]$/i.test(candidate.text) && Math.abs(candidate.topRatio - yRatio) < .004)
    .map((candidate) => candidate.leftRatio)
    .sort((left, right) => left - right)
  if (rowEntries.length > 1) {
    const entryIndex = rowEntries.reduce((bestIndex, candidateX, index) => (
      Math.abs(candidateX - xRatio) < Math.abs(rowEntries[bestIndex] - xRatio) ? index : bestIndex
    ), 0)
    const headerRows = [...headers.reduce((rows, header) => {
      const key = Math.round(header.topRatio * 500)
      const row = rows.get(key) ?? []
      if (!row.some((existing) => existing.purpose === header.purpose && Math.abs(existing.center - header.center) < .01)) row.push(header)
      rows.set(key, row)
      return rows
    }, new Map<number, typeof headers>()).values()]
      .filter((row) => row.length === rowEntries.length && new Set(row.map((header) => header.purpose)).size === row.length)
      .map((row) => row.sort((left, right) => left.center - right.center))
      .sort((left, right) => right[0].topRatio - left[0].topRatio)
    const ordinalPurpose = headerRows[0]?.[entryIndex]?.purpose
    if (ordinalPurpose) return ordinalPurpose
  }
  if (tableOnly) return undefined
  return headers.filter((header) => header.horizontalDistance <= .18).sort((left, right) => left.score - right.score)[0]?.purpose
}

function signerRoleAt(positionedText: PositionedPdfText[], xRatio: number, yRatio: number): string | undefined {
  const roles = expandedContextSegments(positionedText).flatMap((candidate) => {
    const raw = candidate.text.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim().replace(/[|:]+$/g, '').trim()
    if (!raw || raw.length > 72 || !/[a-z]/i.test(raw) || /printed name|signature|initials?|date(?:\s*\/\s*time)?|^role$/i.test(raw)) return []
    if (candidate.leftRatio >= xRatio || Math.abs(candidate.topRatio - yRatio) > .035) return []
    const rightEdge = candidate.leftRatio + candidate.widthRatio
    if (rightEdge > xRatio + .03) return []
    const role = cleanTemplateLabel(raw)
    return [{ role, score: Math.abs(candidate.topRatio - yRatio) + Math.max(0, xRatio - rightEdge) * .2 }]
  })
  return roles.sort((left, right) => left.score - right.score)[0]?.role
}

function sameRowLabelAt(positionedText: PositionedPdfText[], xRatio: number, yRatio: number): string | undefined {
  const placeholdersOnLine = positionedText.filter((candidate) => (
    /\[\s*enter(?:\s*\/\s*sign)?\s*\]/i.test(candidate.text)
    && Math.abs(candidate.topRatio - yRatio) <= .024
  )).length
  if (placeholdersOnLine > 1) return undefined
  const candidates = positionedText.flatMap((candidate) => {
    const raw = candidate.text.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim().replace(/[|:]+$/g, '').trim()
    const letters = raw.replace(/[^A-Za-z]/g, '')
    if (!raw || raw.length > 80 || letters.length < 2 || isIgnoredContextLabel(raw)) return []
    if (Math.abs(candidate.topRatio - yRatio) > .024 || candidate.leftRatio >= xRatio) return []
    const rightEdge = candidate.leftRatio + candidate.widthRatio
    if (rightEdge > xRatio + .02 || xRatio - rightEdge > .2) return []
    return [{ label: cleanTemplateLabel(raw), score: Math.abs(candidate.topRatio - yRatio) + Math.max(0, xRatio - rightEdge) }]
  })
  return candidates.sort((left, right) => left.score - right.score)[0]?.label
}

function tableColumnAt(positionedText: PositionedPdfText[], xRatio: number, yRatio: number): { label: string; topRatio: number } | undefined {
  const candidates = positionedText.flatMap((candidate) => {
    const raw = candidate.text.replace(/\s+/g, ' ').trim()
    const letters = raw.replace(/[^A-Za-z]/g, '')
    if (!raw || raw.includes('[') || raw.length > 64 || letters.length < 2 || isIgnoredContextLabel(raw) || letters !== letters.toLocaleUpperCase()) return []
    if (candidate.topRatio >= yRatio || yRatio - candidate.topRatio > .34 || candidate.widthRatio > .32) return []
    const center = candidate.leftRatio + candidate.widthRatio / 2
    const horizontalDistance = Math.abs(xRatio - center)
    return [{
      label: cleanTemplateLabel(raw),
      score: (yRatio - candidate.topRatio) + horizontalDistance * 2,
      topRatio: candidate.topRatio,
      xRatio: candidate.leftRatio,
      widthRatio: candidate.widthRatio,
    }]
  })
  const entryXs = positionedText
    .filter((candidate) => /^\[\s*enter\s*\]$/i.test(candidate.text) && Math.abs(candidate.topRatio - yRatio) < .004)
    .map((candidate) => candidate.leftRatio)
    .sort((left, right) => left - right)
  if (entryXs.length > 1) {
    const entryIndex = entryXs.reduce((bestIndex, candidateX, index) => (
      Math.abs(candidateX - xRatio) < Math.abs(entryXs[bestIndex] - xRatio) ? index : bestIndex
    ), 0)

    // Table headings are often split across multiple PDF text runs (for example,
    // "SCHEDULE" above "PUBLISHED"). Build one logical heading per entry column
    // from the nearest header band instead of requiring every heading to share an
    // identical text baseline.
    const nearestHeaderTop = candidates.reduce((closest, candidate) => Math.max(closest, candidate.topRatio), -1)
    const logicalHeaders = entryXs.map((entryX, index) => {
      const leftBoundary = index === 0 ? 0 : (entryXs[index - 1] + entryX) / 2
      const rightBoundary = index === entryXs.length - 1 ? 1 : (entryX + entryXs[index + 1]) / 2
      const fragments = candidates
        .filter((candidate) => nearestHeaderTop - candidate.topRatio <= .03)
        .filter((candidate) => {
          const center = candidate.xRatio + candidate.widthRatio / 2
          return center >= leftBoundary && center < rightBoundary
        })
        .sort((left, right) => left.topRatio - right.topRatio || left.xRatio - right.xRatio)
      if (!fragments.length) return undefined
      const label = fragments
        .map((fragment) => fragment.label)
        .filter((fragment, fragmentIndex, values) => values.indexOf(fragment) === fragmentIndex)
        .join(' ')
      return { label: cleanTemplateLabel(label.toLocaleUpperCase()), topRatio: Math.min(...fragments.map((fragment) => fragment.topRatio)) }
    })
    if (logicalHeaders.every(Boolean)) return logicalHeaders[entryIndex]

    const headerRows = [...candidates.reduce((rows, candidate) => {
      const key = Math.round(candidate.topRatio * 500)
      const row = rows.get(key) ?? []
      row.push(candidate)
      rows.set(key, row)
      return rows
    }, new Map<number, typeof candidates>()).values()]
      .filter((row) => row.length === entryXs.length)
      .map((row) => row.sort((left, right) => left.xRatio - right.xRatio))
      .sort((left, right) => right[0].topRatio - left[0].topRatio)
    const ordinalMatch = headerRows[0]?.[entryIndex]
    if (ordinalMatch) return { label: ordinalMatch.label, topRatio: ordinalMatch.topRatio }
  }
  return candidates
    .filter((candidate) => Math.abs(xRatio - (candidate.xRatio + candidate.widthRatio / 2)) <= Math.max(.08, candidate.widthRatio * .8))
    .sort((left, right) => left.score - right.score)[0]
}

function sectionAt(positionedText: PositionedPdfText[], yRatio: number, page: number): string {
  const heading = positionedText
    .filter((candidate) => candidate.topRatio < yRatio && yRatio - candidate.topRatio < .3)
    .filter((candidate) => {
      const text = candidate.text.trim()
      if (text.length < 3 || text.length > 90 || isIgnoredContextLabel(text) || /printed name|date\s*\/\s*time|signature/i.test(text)) return false
      const letters = text.replace(/[^A-Za-z]/g, '')
      return letters.length >= 3 && letters === letters.toLocaleUpperCase()
    })
    .sort((left, right) => right.topRatio - left.topRatio)[0]
  return heading ? heading.text.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toLocaleUpperCase()) : `Page ${page} fields`
}

function inferTemplateFieldContext(input: {
  itemText: string
  label: string
  page: number
  positionedText: PositionedPdfText[]
  xRatio: number
  yRatio: number
}): TemplateFieldContext {
  const signaturePrompt = /^enter\s*\/\s*sign$/i.test(input.label.trim())
  const genericEntry = /^enter$/i.test(input.label.trim())
  const purpose = signaturePrompt
    ? fieldPurposeAt(input.positionedText, input.xRatio, input.yRatio)
    : genericEntry
      ? fieldPurposeAt(input.positionedText, input.xRatio, input.yRatio, true)
      : undefined
  const role = purpose || signaturePrompt ? signerRoleAt(input.positionedText, input.xRatio, input.yRatio) : undefined
  const tableColumn = genericEntry ? tableColumnAt(input.positionedText, input.xRatio, input.yRatio) : undefined
  const sameRowLabel = genericEntry && !tableColumn ? sameRowLabelAt(input.positionedText, input.xRatio, input.yRatio) : undefined
  const controlType = inferredControlType(tableColumn?.label ?? sameRowLabel ?? input.label, purpose)
  const textOutsidePlaceholder = input.itemText.replace(/\[[^\]]+\]/g, '')
  const hasBodyText = textOutsidePlaceholder.replace(/[^A-Za-z0-9]/g, '').length >= 8
    || /\b(?:dear|hello|hi)\s+\[[^\]]+\]\s*[:,]?/i.test(input.itemText)
  const layout: DetectedTemplateField['layout'] = hasBodyText && !purpose && !tableColumn && !sameRowLabel && controlType !== 'signature' ? 'inline-body' : 'field-box'
  const cleanedLabel = cleanTemplateLabel(input.label)
  const label = role && purpose ? `${role} — ${purpose}` : purpose ?? tableColumn?.label ?? sameRowLabel ?? cleanedLabel
  const genericPrompt = /^(?:enter|type|value|field)$/i.test(input.label.trim())
  const mappingStatus: DetectedTemplateField['mappingStatus'] = genericPrompt && !purpose && !tableColumn && !sameRowLabel ? 'review' : 'mapped'
  const groupLabel = role
    ? `Signatures — ${role}`
    : layout === 'inline-body'
      ? 'Document body'
      : tableColumn
        ? sectionAt(input.positionedText, tableColumn.topRatio, input.page)
        : sameRowLabel
          ? sectionAt(input.positionedText, input.yRatio, input.page)
        : sectionAt(input.positionedText, input.yRatio, input.page)
  const description = role && purpose
    ? `${purpose} field for the ${role.toLocaleLowerCase()} row.`
    : layout === 'inline-body'
      ? 'Inline field inside the document body. Edit it here without covering the surrounding paragraph.'
      : tableColumn
        ? `${tableColumn.label} entry in this table.`
        : sameRowLabel
          ? `${sameRowLabel} field on page ${input.page}.`
      : `Field on page ${input.page}.`
  return { controlType, description, groupLabel, label, layout, mappingStatus }
}

function finalizeDetectedFieldMap(fields: DetectedTemplateField[]): DetectedTemplateField[] {
  const mappedFields = fields.map((field) => ({ ...field }))
  const genericPattern = /^enter(?:\s*\/\s*sign)?$/i
  const genericRowsByPage = new Map<number, DetectedTemplateField[][]>()
  for (const field of mappedFields.filter((candidate) => genericPattern.test(candidate.rawLabel))) {
    const rows = genericRowsByPage.get(field.page) ?? []
    const row = rows.find((candidate) => Math.abs(candidate[0].yRatio - field.yRatio) < .004)
    if (row) row.push(field)
    else rows.push([field])
    genericRowsByPage.set(field.page, rows)
  }
  for (const rows of genericRowsByPage.values()) {
    rows.sort((left, right) => left[0].yRatio - right[0].yRatio)
    for (const row of rows) row.sort((left, right) => left.xRatio - right.xRatio)
  }

  type ColumnMapping = Pick<DetectedTemplateField, 'controlType' | 'description' | 'groupLabel' | 'label' | 'layout'> & { xRatio: number }
  let previousPageCandidates: Array<{ columns: ColumnMapping[]; page: number; yRatio: number }> = []
  for (const pageNumber of [...genericRowsByPage.keys()].sort((left, right) => left - right)) {
    const rows = genericRowsByPage.get(pageNumber) ?? []
    let activeColumns: ColumnMapping[] = []
    const firstRow = rows[0]
    if (firstRow && firstRow[0].yRatio <= .25) {
      const continuation = previousPageCandidates
        .filter((candidate) => candidate.page === pageNumber - 1)
        .map((candidate) => ({
          ...candidate,
          matches: firstRow.filter((field) => candidate.columns.some((column) => Math.abs(column.xRatio - field.xRatio) <= .018)).length,
        }))
        .filter((candidate) => candidate.matches >= Math.min(2, firstRow.length, candidate.columns.length))
        .sort((left, right) => right.matches - left.matches || right.yRatio - left.yRatio)[0]
      if (continuation) activeColumns = continuation.columns
    }
    const pageCandidates: Array<{ columns: ColumnMapping[]; page: number; yRatio: number }> = []
    for (const row of rows) {
      const rowY = row[0].yRatio
      const semanticCells = row.flatMap((field) => {
        const plainSignature = /^enter\s*\/\s*sign$/i.test(field.rawLabel) && field.label === 'Signature'
        if (field.mappingStatus !== 'mapped' || plainSignature) return []
        const purpose = field.label.includes(' — ') ? field.label.split(' — ').at(-1)! : field.label
        return [{
          controlType: field.controlType,
          description: field.description,
          groupLabel: field.groupLabel,
          label: purpose,
          layout: field.layout,
          xRatio: field.xRatio,
        } satisfies ColumnMapping]
      })
      for (const semanticCell of semanticCells) {
        const existingIndex = activeColumns.findIndex((column) => Math.abs(column.xRatio - semanticCell.xRatio) <= .018)
        if (existingIndex >= 0) activeColumns[existingIndex] = semanticCell
        else activeColumns.push(semanticCell)
      }
      for (const field of row) {
        const plainSignature = /^enter\s*\/\s*sign$/i.test(field.rawLabel) && field.label === 'Signature'
        if (field.mappingStatus === 'mapped' && !plainSignature) continue
        const source = activeColumns
          .filter((column) => Math.abs(column.xRatio - field.xRatio) <= .018)
          .sort((left, right) => Math.abs(left.xRatio - field.xRatio) - Math.abs(right.xRatio - field.xRatio))[0]
        if (!source) continue
        const currentRole = field.groupLabel.startsWith('Signatures — ') ? field.groupLabel.slice('Signatures — '.length) : undefined
        field.controlType = source.controlType
        field.description = currentRole
          ? `${source.label} field for the ${currentRole.toLocaleLowerCase()} row.`
          : `${source.label} entry in this table.`
        field.groupLabel = currentRole ? `Signatures — ${currentRole}` : source.groupLabel
        field.label = currentRole ? `${currentRole} — ${source.label}` : source.label
        field.layout = source.layout
        field.mappingStatus = 'mapped'
      }
      const completedColumns = row.flatMap((field) => {
        if (field.mappingStatus !== 'mapped') return []
        const label = field.label.includes(' — ') ? field.label.split(' — ').at(-1)! : field.label
        return [{ controlType: field.controlType, description: field.description, groupLabel: field.groupLabel, label, layout: field.layout, xRatio: field.xRatio } satisfies ColumnMapping]
      })
      if (rowY >= .5 && completedColumns.length) pageCandidates.push({ columns: completedColumns, page: pageNumber, yRatio: rowY })
    }
    previousPageCandidates = pageCandidates
  }

  const rowCoordinatesByGroup = new Map<string, Array<{ page: number; yRatio: number }>>()
  for (const field of mappedFields) {
    if (!/^enter$/i.test(field.rawLabel) || field.mappingStatus !== 'mapped') continue
    const rows = rowCoordinatesByGroup.get(field.groupLabel) ?? []
    if (!rows.some((row) => row.page === field.page && Math.abs(row.yRatio - field.yRatio) < .004)) rows.push({ page: field.page, yRatio: field.yRatio })
    rowCoordinatesByGroup.set(field.groupLabel, rows)
  }
  for (const rows of rowCoordinatesByGroup.values()) rows.sort((left, right) => left.page - right.page || left.yRatio - right.yRatio)

  const fieldsByLine = new Map<string, DetectedTemplateField[]>()
  for (const field of mappedFields) {
    if (field.layout !== 'field-box' || field.nativeFieldName) continue
    const key = `${field.page}:${Math.round(field.yRatio * 500)}`
    const line = fieldsByLine.get(key) ?? []
    line.push(field)
    fieldsByLine.set(key, line)
  }
  const verifiedWidths = new Map<string, number>()
  for (const line of fieldsByLine.values()) {
    if (line.length < 2) continue
    line.sort((left, right) => left.xRatio - right.xRatio)
    for (let index = 0; index < line.length; index += 1) {
      const field = line[index]
      if (field.controlType === 'checkbox') continue
      const next = line[index + 1]
      const previous = line.slice(0, index).reverse().find((candidate) => candidate.controlType !== 'checkbox')
      const available = next
        ? next.xRatio - field.xRatio - .006
        : previous
          ? Math.min(.96 - field.xRatio, field.xRatio - previous.xRatio - .006)
          : field.widthRatio
      if (available > .018) verifiedWidths.set(field.id, available)
    }
  }

  return mappedFields.map((field) => {
    const verifiedWidth = verifiedWidths.get(field.id)
    const minimumSafeWidth = Math.max(field.widthRatio, field.eraseWidthRatio)
    const widthRatio = verifiedWidth ?? minimumSafeWidth
    const rows = rowCoordinatesByGroup.get(field.groupLabel)
    const rowIndex = rows?.findIndex((row) => row.page === field.page && Math.abs(row.yRatio - field.yRatio) < .004) ?? -1
    return {
      ...field,
      eraseWidthRatio: Math.min(field.eraseWidthRatio, widthRatio),
      label: /^enter$/i.test(field.rawLabel) && rowIndex >= 0 ? `Row ${rowIndex + 1} — ${field.label}` : field.label,
      widthRatio,
    }
  })
}

function friendlyError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function bytesAsFile(bytes: Uint8Array, title: string): File {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new File([copy.buffer], completedPdfFilename(title), { type: 'application/pdf' })
}

function bytesAsDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192))
  }
  return `data:${mimeType};base64,${window.btoa(binary)}`
}

function SignatureImage({ annotation }: { annotation: PdfAnnotation }) {
  const source = useMemo(() => annotation.signaturePng ? bytesAsDataUrl(annotation.signaturePng, 'image/png') : null, [annotation.signaturePng])
  return source ? <img alt="" draggable={false} src={source} /> : <span>{annotation.text}</span>
}

export async function detectTemplateFields(pdf: PDFDocumentProxy): Promise<TemplateFieldDetectionResult> {
  const fields: DetectedTemplateField[] = []
  let truncated = false
  const addField = (field: DetectedTemplateField) => {
    if (fields.length < MAX_DETECTED_TEMPLATE_FIELDS) fields.push(field)
    else truncated = true
  }
  const seen = new Set<string>()
  const seenNativeNames = new Set<string>()
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const pdfPage = await pdf.getPage(pageNumber)
    const viewport = pdfPage.getViewport({ scale: 1 })
    if (typeof pdfPage.getAnnotations === 'function') {
      const widgets = await pdfPage.getAnnotations({ intent: 'display' }).catch(() => [])
      for (const widget of widgets) {
        if (!widget || widget.subtype !== 'Widget' || typeof widget.fieldName !== 'string' || seenNativeNames.has(widget.fieldName) || !Array.isArray(widget.rect)) continue
        const fieldType = widget.fieldType === 'Tx'
          ? widget.multiLine ? 'long_text' : 'text'
          : widget.fieldType === 'Btn' && widget.checkBox
            ? 'checkbox'
            : widget.fieldType === 'Ch'
              ? 'choice'
              : widget.fieldType === 'Sig'
                ? 'signature'
              : null
        if (!fieldType) continue
        const rect = widget.rect.map(Number)
        const firstCorner = viewport.convertToViewportPoint(rect[0], rect[1])
        const secondCorner = viewport.convertToViewportPoint(rect[2], rect[3])
        const converted = [...firstCorner, ...secondCorner]
        const left = Math.max(0, Math.min(converted[0], converted[2]))
        const top = Math.max(0, Math.min(converted[1], converted[3]))
        const width = Math.max(18, Math.abs(converted[2] - converted[0]))
        const height = Math.max(12, Math.abs(converted[3] - converted[1]))
        const label = typeof widget.alternativeText === 'string' && widget.alternativeText.trim()
          ? widget.alternativeText.trim()
          : humanizePdfFieldName(widget.fieldName)
        const semanticControlType = fieldType === 'text' ? inferredControlType(label) : fieldType
        const options = Array.isArray(widget.options)
          ? widget.options.map((option: unknown) => {
              const record = option && typeof option === 'object' ? option as Record<string, unknown> : {}
              const value = typeof record.exportValue === 'string' ? record.exportValue : typeof record.displayValue === 'string' ? record.displayValue : ''
              const optionLabel = typeof record.displayValue === 'string' ? record.displayValue : value
              return { label: optionLabel, value }
            }).filter((option: { value: string }) => option.value)
          : undefined
        seenNativeNames.add(widget.fieldName)
        addField({
          boxHeightRatio: Math.min(.4, height / viewport.height),
          controlType: semanticControlType,
          defaultValue: fieldType === 'checkbox' ? String(Boolean(widget.fieldValue && widget.fieldValue !== 'Off')) : typeof widget.fieldValue === 'string' ? widget.fieldValue : '',
          description: `Native PDF field on page ${pageNumber}.`,
          eraseHeightRatio: 0,
          eraseWidthRatio: 0,
          fontSize: Math.max(8, Math.min(15, Math.round(height * .65))),
          groupLabel: `Page ${pageNumber} fields`,
          id: `native:${widget.fieldName}`,
          label: cleanTemplateLabel(label),
          layout: 'field-box',
          mappingStatus: 'mapped',
          nativeFieldName: widget.fieldName,
          options,
          page: pageNumber,
          rawLabel: label,
          widthRatio: Math.min(.88, width / viewport.width),
          xRatio: Math.max(.01, Math.min(.97, left / viewport.width)),
          yRatio: Math.max(.01, Math.min(.97, top / viewport.height)),
        })
      }
    }
    if (typeof pdfPage.getTextContent !== 'function') continue
    const content = await pdfPage.getTextContent()
    const positionedText: PositionedPdfText[] = content.items.flatMap((contentItem) => {
      if (!('str' in contentItem) || !contentItem.str.trim() || !Array.isArray(contentItem.transform)) return []
      const contentHeight = Math.max(Math.abs(Number(contentItem.height) || Number(contentItem.transform[3]) || 0), 9)
      const contentWidth = Math.max(Number(contentItem.width) || 0, contentHeight)
      const [contentX, contentBaselineY] = viewport.convertToViewportPoint(Number(contentItem.transform[4]) || 0, Number(contentItem.transform[5]) || 0)
      return [{
        heightRatio: Math.max(.012, contentHeight / viewport.height),
        leftRatio: Math.max(0, Math.min(1, contentX / viewport.width)),
        text: contentItem.str.replace(/\s+/g, ' ').trim(),
        topRatio: Math.max(0, Math.min(1, (contentBaselineY - contentHeight * 1.08) / viewport.height)),
        widthRatio: Math.max(.012, contentWidth / viewport.width),
      }]
    })
    const followingTextTops = positionedText.map((item) => item.topRatio).sort((left, right) => left - right)
    for (const item of content.items) {
      if (!('str' in item) || !item.str.includes('[') || !Array.isArray(item.transform)) continue
      const expression = /\[([^\]\r\n]{2,160})\]/g
      let match: RegExpExecArray | null
      while ((match = expression.exec(item.str))) {
        const label = match[1].replace(/\s+/g, ' ').trim()
        if (!label) continue
        const itemWidth = Math.max(Number(item.width) || 0, 24)
        const itemHeight = Math.max(Math.abs(Number(item.height) || Number(item.transform[3]) || 0), 9)
        const { startFraction, widthFraction } = textSpanFractions(item.str, match.index, match[0].length)
        const [baselineX, baselineY] = viewport.convertToViewportPoint(Number(item.transform[4]) || 0, Number(item.transform[5]) || 0)
        const xRatio = Math.max(.01, Math.min(.92, (baselineX + itemWidth * startFraction) / viewport.width))
        const context = inferTemplateFieldContext({
          itemText: item.str,
          label,
          page: pageNumber,
          positionedText,
          xRatio,
          yRatio: Math.max(.01, Math.min(.97, (baselineY - itemHeight * 1.08) / viewport.height)),
        })
        const controlType = context.controlType
        const promptGlyphWidth = Math.max(1, itemWidth * widthFraction)
        const maximumAvailableWidth = Math.max(.006, .985 - xRatio)
        const eraseWidth = Math.max(.006, Math.min(maximumAvailableWidth, (promptGlyphWidth + 1) / viewport.width))
        const fieldPromptWidth = Math.max(eraseWidth, Math.min(maximumAvailableWidth, (promptGlyphWidth + 6) / viewport.width))
        const detectedWidth = context.layout === 'inline-body'
          ? eraseWidth
          : controlType === 'long_text'
          ? Math.max(fieldPromptWidth, Math.min(.72, .94 - xRatio))
          : controlType === 'signature'
            ? Math.max(fieldPromptWidth, Math.min(.28, .94 - xRatio))
            : Math.max(fieldPromptWidth, Math.min(.2, .94 - xRatio))
        const yRatio = Math.max(.01, Math.min(.97, (baselineY - itemHeight * 1.08) / viewport.height))
        const sourceLine = context.layout === 'inline-body'
          ? {
              baselineRatio: Math.max(0, Math.min(1, baselineY / viewport.height)),
              heightRatio: Math.max(.006, Math.min(.08, itemHeight * 1.12 / viewport.height)),
              id: `${pageNumber}:${Math.round(baselineX * 10)}:${Math.round(baselineY * 10)}`,
              text: item.str,
              topRatio: Math.max(0, Math.min(1, (baselineY - itemHeight * .9) / viewport.height)),
              widthRatio: Math.max(.006, Math.min(.985 - Math.max(0, baselineX / viewport.width), (itemWidth + 1) / viewport.width)),
              xRatio: Math.max(0, Math.min(.985, baselineX / viewport.width)),
            } satisfies PdfInlineSourceLine
          : undefined
        const nextTextTop = controlType === 'long_text'
          ? followingTextTops.find((candidate) => candidate > yRatio + Math.max(.03, itemHeight * 2 / viewport.height))
          : undefined
        const boundedLongTextHeight = nextTextTop === undefined
          ? Math.max(.06, Math.min(.18, .92 - yRatio))
          : Math.max(.045, Math.min(.18, nextTextTop - yRatio - .008))
        const key = `${pageNumber}:${Math.round(xRatio * 1_000)}:${Math.round(yRatio * 1_000)}:${label.toLocaleLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        addField({
          boxHeightRatio: controlType === 'long_text'
            ? boundedLongTextHeight
            : controlType === 'signature'
              ? Math.max(.018, Math.min(.05, itemHeight * 1.55 / viewport.height))
              : Math.max(.012, Math.min(.035, itemHeight * 1.08 / viewport.height)),
          controlType,
          description: context.description,
          eraseHeightRatio: Math.max(.006, Math.min(.08, (itemHeight + 3) / viewport.height)),
          eraseWidthRatio: eraseWidth,
          fontSize: Math.max(8, Math.min(15, Math.round(itemHeight))),
          groupLabel: context.groupLabel,
          id: key,
          label: context.label,
          layout: context.layout,
          mappingStatus: context.mappingStatus,
          page: pageNumber,
          rawLabel: label,
          sourceLine,
          sourceSpan: sourceLine ? { length: match[0].length, start: match.index } : undefined,
          widthRatio: Math.min(detectedWidth, .98 - xRatio),
          xRatio,
          yRatio,
        })
      }
    }
    for (const item of positionedText) {
      const symbol = /[☐☑□■]/u.exec(item.text)
      if (!symbol) continue
      const afterSymbol = item.text.slice(symbol.index + symbol[0].length).trim()
      const beforeSymbol = item.text.slice(0, symbol.index).trim()
      const adjacentLabel = positionedText
        .filter((candidate) => candidate !== item
          && Math.abs(candidate.topRatio - item.topRatio) <= Math.max(.012, item.heightRatio)
          && candidate.leftRatio > item.leftRatio
          && candidate.leftRatio - item.leftRatio < .35)
        .sort((left, right) => left.leftRatio - right.leftRatio)[0]?.text
      const label = (afterSymbol || beforeSymbol || adjacentLabel || 'Checkbox').slice(0, 160)
      const symbolFraction = symbol.index / Math.max(1, item.text.length)
      const xRatio = Math.max(.01, Math.min(.97, item.leftRatio + item.widthRatio * symbolFraction))
      const yRatio = Math.max(.01, Math.min(.97, item.topRatio))
      const key = `checkbox:${pageNumber}:${Math.round(xRatio * 1_000)}:${Math.round(yRatio * 1_000)}:${label.toLocaleLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      addField({
        boxHeightRatio: Math.max(.016, Math.min(.04, item.heightRatio * 1.25)),
        controlType: 'checkbox',
        defaultValue: String(/[☑■]/u.test(symbol[0])),
        description: `Checkbox on page ${pageNumber}.`,
        eraseHeightRatio: 0,
        eraseWidthRatio: 0,
        fontSize: Math.max(8, Math.min(15, Math.round(item.heightRatio * viewport.height))),
        groupLabel: sectionAt(positionedText, yRatio, pageNumber),
        id: key,
        label,
        layout: 'field-box',
        mappingStatus: 'mapped',
        page: pageNumber,
        rawLabel: label,
        widthRatio: Math.max(.016, Math.min(.04, item.heightRatio * viewport.height / viewport.width * 1.25)),
        xRatio,
        yRatio,
      })
    }
  }
  return { fields: finalizeDetectedFieldMap(fields), truncated }
}

export function DocumentWorkbench({ employeeOnly = false, initialEmployeeId, initialFile = null, initialTitle = '', onClose, onSaved, workspace }: DocumentWorkbenchProps) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const templateControlRefs = useRef(new Map<string, HTMLElement>())
  const guidedControlRefs = useRef(new Map<string, HTMLElement>())
  const pendingDocumentFocusRef = useRef<string | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const gestureRef = useRef<AnnotationGesture | null>(null)
  const annotationsRef = useRef<PdfAnnotation[]>([])
  const idempotencyKeysRef = useRef(new Map<string, string>())
  const finalFileCacheRef = useRef<{ file: File; fingerprint: string } | null>(null)
  const [file, setFile] = useState<File | null>(initialFile)
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [sheetSize, setSheetSize] = useState({ height: 0, width: 0 })
  const [sheetScale, setSheetScale] = useState(1)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [rendering, setRendering] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [title, setTitle] = useState(initialTitle || initialFile?.name.replace(/\.pdf$/i, '') || '')
  const [panel, setPanel] = useState<WorkbenchPanel>(employeeOnly ? 'file' : 'edit')
  const [advancedEditing, setAdvancedEditing] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [tool, setTool] = useState<PdfAnnotationKind | null>('text')
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [selectedTemplateFieldId, setSelectedTemplateFieldId] = useState<string | null>(null)
  const [textValue, setTextValue] = useState('')
  const [signatureName, setSignatureName] = useState('')
  const [signatureFamily, setSignatureFamily] = useState<SignatureFamily>('Great Vibes')
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([])
  const [templateFields, setTemplateFields] = useState<DetectedTemplateField[]>([])
  const [fieldDetectionTruncated, setFieldDetectionTruncated] = useState(false)
  const [fieldDetectionPending, setFieldDetectionPending] = useState(Boolean(initialFile))
  const [undoHistory, setUndoHistory] = useState<PdfAnnotation[][]>([])
  const [redoHistory, setRedoHistory] = useState<PdfAnnotation[][]>([])
  const initialEmployee = workspace.employees.find((employee) => employee.id === initialEmployeeId)
  const [employeeSearch, setEmployeeSearch] = useState(initialEmployee?.legalName ?? '')
  const [employeeId, setEmployeeId] = useState(initialEmployee?.id ?? (employeeOnly ? '' : 'company'))
  const [category, setCategory] = useState('Business document')
  const [description, setDescription] = useState('')
  const [progress, setProgress] = useState(0)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [savedDocument, setSavedDocument] = useState<{ employeeId: string; fingerprint: string; id: string } | null>(null)
  const [recipientSearch, setRecipientSearch] = useState('')
  const [recipientIds, setRecipientIds] = useState<string[]>([])
  const [requiredAction, setRequiredAction] = useState<RequiredAction>('sign')
  const [message, setMessage] = useState('Please review and complete this document in SygShift.')
  const [expiresAt, setExpiresAt] = useState('')
  const [preview, setPreview] = useState<{ bytes: Uint8Array; fingerprint: string } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const studio = useQuery({
    enabled: panel === 'send',
    queryFn: () => getDocumentStudioWorkspace(),
    queryKey: ['document-studio'],
  })
  const manageableVaults = workspace.vaults.filter((vault) => vault.canManage && vault.allowedMimeTypes.includes('application/pdf'))
  const selectedVault = manageableVaults.find((vault) => vault.code === 'hr-general') ?? manageableVaults[0]
  const filteredEmployees = useMemo(() => {
    const search = employeeSearch.trim().toLocaleLowerCase()
    return workspace.employees.filter((employee) => !search || `${employee.legalName} ${employee.employeeNumber ?? ''}`.toLocaleLowerCase().includes(search))
  }, [employeeSearch, workspace.employees])
  const filteredRecipients = useMemo(() => {
    const search = recipientSearch.trim().toLocaleLowerCase()
    return workspace.employees.filter((employee) => ['active', 'leave'].includes(employee.status) && (!search || `${employee.legalName} ${employee.employeeNumber ?? ''}`.toLocaleLowerCase().includes(search)))
  }, [recipientSearch, workspace.employees])
  const documentFingerprint = useMemo(() => JSON.stringify({
    annotations: annotations.map(({ boxHeightRatio, eraseHeightRatio, eraseWidthRatio, eraseXRatio, eraseYRatio, fieldLabel, fitMode, fontFamily, fontSize, kind, nativeFieldName, nativeFieldType, page: annotationPage, sourceLine, sourceSpan, templateFieldKey, templateFieldLayout, templateFieldType, text, widthRatio, xRatio, yRatio }) => ({ boxHeightRatio, eraseHeightRatio, eraseWidthRatio, eraseXRatio, eraseYRatio, fieldLabel, fitMode, fontFamily, fontSize, kind, nativeFieldName, nativeFieldType, page: annotationPage, sourceLine, sourceSpan, templateFieldKey, templateFieldLayout, templateFieldType, text, widthRatio, xRatio, yRatio })),
    category,
    description,
    employeeId,
    fieldMap: templateFields.map(({ controlType, id, label, layout, mappingStatus }) => ({ controlType, id, label, layout, mappingStatus })),
    source: file ? `${file.name}:${file.size}:${file.lastModified}` : '',
    title,
  }), [annotations, category, description, employeeId, file, templateFields, title])
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null

  useEffect(() => {
    annotationsRef.current = annotations
    if (selectedAnnotationId && !annotations.some((annotation) => annotation.id === selectedAnnotationId)) setSelectedAnnotationId(null)
  }, [annotations, selectedAnnotationId])

  useEffect(() => {
    const container = viewportRef.current
    if (!container) return
    const update = () => setViewportWidth(Math.max(240, Math.floor(container.clientWidth)))
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [file])

  useEffect(() => {
    if (!file) {
      setSourceBytes(null)
      setPdf(null)
      setFieldDetectionPending(false)
      return
    }
    let cancelled = false
    let loadingTask: ReturnType<typeof getDocument> | null = null
    setSourceBytes(null)
    setPdf(null)
    setFieldDetectionPending(true)
    setLoadError(null)
    setPage(1)
    setAnnotations([])
    annotationsRef.current = []
    setUndoHistory([])
    setRedoHistory([])
    setSelectedAnnotationId(null)
    setSelectedTemplateFieldId(null)
    setTemplateFields([])
    setFieldDetectionTruncated(false)
    setAdvancedEditing(false)
    void (async () => {
      try {
        if (file.type !== 'application/pdf' && !file.name.toLocaleLowerCase().endsWith('.pdf')) throw new Error('Choose a PDF so it can be opened, completed, and signed here.')
        const bytes = new Uint8Array(await file.arrayBuffer())
        const renderCopy = new Uint8Array(bytes.byteLength)
        renderCopy.set(bytes)
        loadingTask = getDocument({ data: renderCopy })
        const loaded = await loadingTask.promise
        if (cancelled) return
        setPdf(loaded)
        const detected = await detectTemplateFields(loaded)
        if (!cancelled) {
          setTemplateFields(detected.fields)
          setFieldDetectionTruncated(detected.truncated)
          setSourceBytes(bytes)
          setFieldDetectionPending(false)
          setAdvancedEditing(detected.fields.length === 0)
          setTool(detected.fields.length ? null : 'text')
        }
      } catch (error) {
        if (!cancelled) {
          setSourceBytes(null)
          setFieldDetectionPending(false)
          setLoadError(friendlyError(error, 'This PDF could not be opened.'))
        }
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      void loadingTask?.destroy()
    }
  }, [file])

  useEffect(() => {
    if (!pdf || !canvasRef.current || viewportWidth <= 0) return
    let cancelled = false
    let activeTask: RenderTask | null = null
    setRendering(true)
    void (async () => {
      try {
        const previous = renderTaskRef.current
        if (previous) {
          previous.cancel()
          await previous.promise.catch(() => undefined)
        }
        const pdfPage = await pdf.getPage(page)
        const base = pdfPage.getViewport({ scale: 1 })
        const cssWidth = Math.min(960, Math.max(220, viewportWidth - 30))
        const viewport = pdfPage.getViewport({ scale: cssWidth / base.width })
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        const buffer = document.createElement('canvas')
        buffer.width = Math.max(1, Math.floor(viewport.width * ratio))
        buffer.height = Math.max(1, Math.floor(viewport.height * ratio))
        const context = buffer.getContext('2d', { alpha: false })
        if (!context) throw new Error('The document canvas is unavailable.')
        context.fillStyle = '#fff'
        context.fillRect(0, 0, buffer.width, buffer.height)
        activeTask = pdfPage.render({ canvas: buffer, canvasContext: context, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], viewport })
        renderTaskRef.current = activeTask
        await activeTask.promise
        if (cancelled || !canvasRef.current) return
        const canvas = canvasRef.current
        canvas.width = buffer.width
        canvas.height = buffer.height
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        canvas.getContext('2d', { alpha: false })?.drawImage(buffer, 0, 0)
        setSheetSize({ height: viewport.height, width: viewport.width })
        setSheetScale(viewport.width / base.width)
      } catch (error) {
        if (!cancelled && (error as { name?: string } | null)?.name !== 'RenderingCancelledException') setLoadError('This page could not be displayed. Choose the PDF again or download the original.')
      } finally {
        if (!cancelled) setRendering(false)
        if (renderTaskRef.current === activeTask) renderTaskRef.current = null
      }
    })()
    return () => {
      cancelled = true
      activeTask?.cancel()
    }
  }, [page, pdf, viewportWidth, maximized])

  useEffect(() => {
    if (!selectedTemplateFieldId || !sheetSize.height) return
    const field = templateFields.find((candidate) => candidate.id === selectedTemplateFieldId)
    const container = viewportRef.current
    if (!field || field.page !== page || !container) return
    const top = Math.max(0, field.yRatio * sheetSize.height - container.clientHeight * .42)
    if (typeof container.scrollTo === 'function') container.scrollTo({ behavior: 'smooth', top })
    else container.scrollTop = top
    if (pendingDocumentFocusRef.current === field.id) {
      pendingDocumentFocusRef.current = null
      if (typeof container.scrollIntoView === 'function') container.scrollIntoView({ behavior: 'smooth', block: 'start' })
      templateControlRefs.current.get(field.id)?.focus({ preventScroll: true })
    }
  }, [page, selectedTemplateFieldId, sheetSize.height, templateFields])

  async function createFinalFile(): Promise<File> {
    if (fieldDetectionPending) throw new Error('Wait for this PDF to finish opening and mapping its fields before previewing, downloading, filing, or sending it.')
    if (!sourceBytes || !title.trim()) throw new Error('Open a PDF and add a document title first.')
    assertFormReady()
    if (finalFileCacheRef.current?.fingerprint === documentFingerprint) return finalFileCacheRef.current.file
    const finished = bytesAsFile(await finalizePdf(sourceBytes, annotations), title)
    finalFileCacheRef.current = { file: finished, fingerprint: documentFingerprint }
    return finished
  }

  async function openPreview() {
    setPreviewBusy(true)
    setPreviewError(null)
    try {
      const finished = await createFinalFile()
      setPreview({ bytes: new Uint8Array(await finished.arrayBuffer()), fingerprint: documentFingerprint })
    } catch (error) {
      setPreviewError(friendlyError(error, 'The completed PDF could not be previewed.'))
    } finally {
      setPreviewBusy(false)
    }
  }

  function closePreview() {
    setPreview(null)
  }

  function setAnnotationSnapshot(next: PdfAnnotation[]) {
    annotationsRef.current = next
    setAnnotations(next)
  }

  function commitAnnotationSnapshot(next: PdfAnnotation[]) {
    const current = annotationsRef.current
    if (next === current) return
    setUndoHistory((history) => [...history, current].slice(-60))
    setRedoHistory([])
    setAnnotationSnapshot(next)
  }

  function updateAnnotation(id: string, update: (annotation: PdfAnnotation) => PdfAnnotation) {
    commitAnnotationSnapshot(annotationsRef.current.map((annotation) => annotation.id === id ? update(annotation) : annotation))
  }

  function templateAnnotation(field: DetectedTemplateField, value: string, valueOrigin?: PdfAnnotation['valueOrigin']): PdfAnnotation {
    const eraseHeightRatio = field.nativeFieldName ? undefined : field.eraseHeightRatio
    const eraseWidthRatio = field.nativeFieldName ? undefined : field.eraseWidthRatio
    const hasEraseArea = Boolean(eraseHeightRatio && eraseHeightRatio > 0 && eraseWidthRatio && eraseWidthRatio > 0)
    return {
      boxHeightRatio: field.boxHeightRatio,
      eraseHeightRatio,
      eraseWidthRatio,
      eraseXRatio: hasEraseArea ? field.xRatio : undefined,
      eraseYRatio: hasEraseArea ? field.yRatio : undefined,
      fieldLabel: field.label,
      fitMode: field.controlType === 'long_text' ? 'bounded' : 'single-line',
      fontSize: field.fontSize,
      id: `template:${field.id}`,
      kind: field.controlType === 'checkbox' ? 'checkmark' : 'text',
      nativeFieldName: field.nativeFieldName,
      nativeFieldType: field.controlType === 'checkbox' ? 'checkbox' : field.controlType === 'choice' ? 'choice' : field.nativeFieldName ? 'text' : undefined,
      page: field.page,
      sourceLine: field.sourceLine,
      sourceSpan: field.sourceSpan,
      templateFieldKey: field.id,
      templateFieldLayout: field.layout,
      templateFieldType: field.controlType,
      text: value,
      valueOrigin,
      widthRatio: field.widthRatio,
      xRatio: field.controlType === 'checkbox' ? field.xRatio + field.widthRatio / 2 : field.xRatio,
      yRatio: field.controlType === 'checkbox' ? field.yRatio + field.boxHeightRatio / 2 : field.yRatio,
    }
  }

  function updateTemplateField(field: DetectedTemplateField, value: string) {
    if (field.controlType === 'signature') return
    const withoutField = annotationsRef.current.filter((annotation) => annotation.templateFieldKey !== field.id)
    const shouldPersist = field.controlType === 'checkbox'
      ? Boolean(field.nativeFieldName) || value === 'true'
      : Boolean(field.nativeFieldName) || Boolean(value.trim())
    commitAnnotationSnapshot(shouldPersist ? [...withoutField, templateAnnotation(field, value)] : withoutField)
  }

  function updateTemplateFieldDefinition(fieldId: string, update: Partial<Pick<DetectedTemplateField, 'controlType' | 'label' | 'mappingStatus'>>) {
    const current = templateFields.find((field) => field.id === fieldId)
    if (!current) return
    const nextControlType = update.controlType ?? current.controlType
    if (nextControlType !== current.controlType) {
      commitAnnotationSnapshot(annotationsRef.current.filter((annotation) => annotation.templateFieldKey !== fieldId))
      setSignatureName('')
    }
    setTemplateFields((fields) => fields.map((field) => field.id === fieldId ? { ...field, ...update } : field))
    finalFileCacheRef.current = null
    closePreview()
  }

  function confirmTemplateFieldMapping(field: DetectedTemplateField) {
    const label = field.label.trim()
    if (!label || /^(?:enter|type|value|field|document field)$/i.test(label)) {
      setLoadError('Add a clear field label before confirming this mapping.')
      guidedControlRefs.current.get(field.id)?.focus()
      return
    }
    updateTemplateFieldDefinition(field.id, { mappingStatus: 'mapped' })
    setLoadError(null)
  }

  function selectTemplateField(field: DetectedTemplateField, options: { focusDocument?: boolean; focusSidebar?: boolean } = {}) {
    const current = annotationsRef.current.find((annotation) => annotation.templateFieldKey === field.id)
    pendingDocumentFocusRef.current = options.focusDocument ? field.id : null
    setPage(field.page)
    setPanel('edit')
    setTool(null)
    setSelectedAnnotationId(null)
    setSelectedTemplateFieldId(field.id)
    if (field.controlType === 'signature') setSignatureName(current?.text ?? '')
    if (options.focusSidebar) {
      window.setTimeout(() => guidedControlRefs.current.get(field.id)?.focus({ preventScroll: false }), 0)
    }
  }

  function assertFormReady() {
    if (fieldDetectionTruncated) {
      throw new Error(`This PDF contains more than ${MAX_DETECTED_TEMPLATE_FIELDS} editable fields. It must be mapped as a controlled form before it can be finalized.`)
    }
    const unresolved = templateFields.find((field) => field.mappingStatus === 'review')
    if (!unresolved) return
    selectTemplateField(unresolved, { focusSidebar: true })
    throw new Error(`This form has an unclear field on page ${unresolved.page} and needs a template repair. SygShift will not guess where information belongs.`)
  }

  async function placeTemplateSignature(field: DetectedTemplateField) {
    const value = signatureName.trim()
    if (!value) {
      setLoadError('Type the signer name first.')
      return
    }
    try {
      const signaturePng = await createTypedSignaturePng(value, signatureFamily)
      const existing = annotationsRef.current.find((annotation) => annotation.templateFieldKey === field.id)
      const eraseHeightRatio = field.nativeFieldName ? field.boxHeightRatio : field.eraseHeightRatio
      const eraseWidthRatio = field.nativeFieldName ? field.widthRatio : field.eraseWidthRatio
      const hasEraseArea = eraseHeightRatio > 0 && eraseWidthRatio > 0
      const annotation = movePdfAnnotation({
        boxHeightRatio: field.boxHeightRatio,
        eraseHeightRatio,
        eraseWidthRatio,
        eraseXRatio: hasEraseArea ? field.xRatio : undefined,
        eraseYRatio: hasEraseArea ? field.yRatio : undefined,
        fieldLabel: field.label,
        fontFamily: signatureFamily,
        id: existing?.id ?? `template-signature:${field.id}`,
        kind: 'signature',
        page: field.page,
        signaturePng,
        templateFieldKey: field.id,
        templateFieldLayout: field.layout,
        templateFieldType: field.controlType,
        text: value,
        widthRatio: field.widthRatio,
        xRatio: field.xRatio + field.widthRatio / 2,
        yRatio: field.yRatio + field.boxHeightRatio / 2,
      }, field.xRatio + field.widthRatio / 2, field.yRatio + field.boxHeightRatio / 2)
      commitAnnotationSnapshot([
        ...annotationsRef.current.filter((current) => current.templateFieldKey !== field.id),
        annotation,
      ])
      setSelectedTemplateFieldId(field.id)
      setLoadError(null)
    } catch (error) {
      setLoadError(friendlyError(error, 'The signature could not be generated.'))
    }
  }

  function removeTemplateSignature(field: DetectedTemplateField) {
    commitAnnotationSnapshot(annotationsRef.current.filter((annotation) => annotation.templateFieldKey !== field.id))
    setSignatureName('')
    setLoadError(null)
  }

  function fillSelectedEmployeeDetails(targetEmployeeId = employeeId) {
    const employee = workspace.employees.find((candidate) => candidate.id === targetEmployeeId)
    if (!employee) return
    const today = new Intl.DateTimeFormat('en-US').format(new Date())
    let next = [...annotationsRef.current]
    for (const field of templateFields) {
      if (field.controlType === 'signature') continue
      const normalized = field.label.toLocaleLowerCase()
      let employeeValue: string | undefined
      if (/(employee|applicant).*(legal )?name|(legal )?name.*(employee|applicant)|^legal name$|^employee$/.test(normalized)) employeeValue = employee.legalName
      else if (/(employee|payroll).*(id|number)|(id|number).*(employee|payroll)/.test(normalized)) employeeValue = employee.employeeNumber ?? ''
      else if (/(job|position).*(title)|title.*(job|position)|^position$/.test(normalized)) employeeValue = employee.jobTitle ?? ''
      else if (/employment.*(type|classification)|(type|classification).*employment/.test(normalized)) employeeValue = employee.employmentType?.replaceAll('_', ' ') ?? ''
      else if (/(supervisor|manager).*(name)?|(name).*(supervisor|manager)/.test(normalized)) employeeValue = employee.supervisorLabel ?? ''
      else if (/(work )?(location|site)|(location|site).*(work|employee)/.test(normalized)) employeeValue = employee.locationText ?? ''
      else if (/(employer|company|business|organization).*(name)?|^employer$|^company$/.test(normalized)) employeeValue = 'Guardianship Security LLC'
      else if (/(document|completion|completed|prepared|today).*(date)|^document date$/.test(normalized)) employeeValue = today
      if (employeeValue === undefined) continue
      const existing = next.find((annotation) => annotation.templateFieldKey === field.id)
      const generated = existing?.valueOrigin === 'employee-prefill'
      if (!employeeValue.trim()) {
        if (generated) next = next.filter((annotation) => annotation.templateFieldKey !== field.id)
        continue
      }
      if (existing && !generated) continue
      if (!existing && field.defaultValue?.trim()) continue
      next = next.filter((annotation) => annotation.templateFieldKey !== field.id)
      next.push(templateAnnotation(field, employeeValue, 'employee-prefill'))
    }
    commitAnnotationSnapshot(next)
  }

  async function addAnnotation(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tool) { setSelectedAnnotationId(null); setSelectedTemplateFieldId(null); return }
    if (!sheetRef.current) return
    if (tool === 'text' && !textValue.trim()) { setLoadError('Type the text you want to add first.'); return }
    if (tool === 'signature' && !signatureName.trim()) { setLoadError('Type the signer name first.'); return }
    const bounds = sheetRef.current.getBoundingClientRect()
    const clickedXRatio = (event.clientX - bounds.left) / bounds.width
    const clickedYRatio = (event.clientY - bounds.top) / bounds.height
    const signatureTarget = tool === 'signature'
      ? templateFields
        .filter((field) => field.page === page && field.controlType === 'signature')
        .map((field) => ({
          distance: Math.hypot(clickedXRatio - (field.xRatio + field.widthRatio / 2), clickedYRatio - (field.yRatio + field.boxHeightRatio / 2)),
          field,
          inside: clickedXRatio >= field.xRatio - .03
            && clickedXRatio <= field.xRatio + field.widthRatio + .03
            && clickedYRatio >= field.yRatio - .03
            && clickedYRatio <= field.yRatio + field.boxHeightRatio + .03,
        }))
        .filter((candidate) => candidate.inside)
        .sort((left, right) => left.distance - right.distance)[0]?.field
      : undefined
    let signaturePng: Uint8Array | undefined
    try {
      if (tool === 'signature') signaturePng = await createTypedSignaturePng(signatureName, signatureFamily)
    } catch (error) {
      setLoadError(friendlyError(error, 'The signature could not be generated.'))
      return
    }
    const value = tool === 'text' ? textValue.trim() : tool === 'date' ? new Intl.DateTimeFormat('en-US').format(new Date()) : tool === 'checkmark' ? '✓' : signatureName.trim()
    const id = crypto.randomUUID()
    const signatureEraseHeightRatio = signatureTarget ? (signatureTarget.nativeFieldName ? signatureTarget.boxHeightRatio : signatureTarget.eraseHeightRatio) : undefined
    const signatureEraseWidthRatio = signatureTarget ? (signatureTarget.nativeFieldName ? signatureTarget.widthRatio : signatureTarget.eraseWidthRatio) : undefined
    const hasSignatureEraseArea = Boolean(signatureEraseHeightRatio && signatureEraseHeightRatio > 0 && signatureEraseWidthRatio && signatureEraseWidthRatio > 0)
    const annotation = movePdfAnnotation({
      boxHeightRatio: signatureTarget?.boxHeightRatio,
      eraseHeightRatio: signatureEraseHeightRatio,
      eraseWidthRatio: signatureEraseWidthRatio,
      eraseXRatio: hasSignatureEraseArea ? signatureTarget?.xRatio : undefined,
      eraseYRatio: hasSignatureEraseArea ? signatureTarget?.yRatio : undefined,
      fieldLabel: signatureTarget?.label,
      fontSize: tool === 'text' ? DEFAULT_TEXT_FONT_SIZE : undefined,
      id,
      fontFamily: tool === 'signature' ? signatureFamily : undefined,
      kind: tool,
      page,
      signaturePng,
      templateFieldKey: signatureTarget?.id,
      templateFieldLayout: signatureTarget?.layout,
      templateFieldType: signatureTarget?.controlType,
      text: value,
      widthRatio: tool === 'text'
        ? DEFAULT_TEXT_WIDTH_RATIO
        : tool === 'signature'
          ? signatureTarget ? signatureTarget.widthRatio : DEFAULT_SIGNATURE_WIDTH_RATIO
          : undefined,
      xRatio: signatureTarget ? signatureTarget.xRatio + signatureTarget.widthRatio / 2 : clickedXRatio,
      yRatio: signatureTarget ? signatureTarget.yRatio + signatureTarget.boxHeightRatio / 2 : clickedYRatio,
    }, signatureTarget ? signatureTarget.xRatio + signatureTarget.widthRatio / 2 : clickedXRatio, signatureTarget ? signatureTarget.yRatio + signatureTarget.boxHeightRatio / 2 : clickedYRatio)
    const withoutPreviousTarget = signatureTarget
      ? annotationsRef.current.filter((current) => current.templateFieldKey !== signatureTarget.id)
      : annotationsRef.current
    commitAnnotationSnapshot([...withoutPreviousTarget, annotation])
    setSelectedAnnotationId(id)
    setSelectedTemplateFieldId(null)
    setTool(null)
    setLoadError(null)
    if (tool === 'text') setTextValue('')
  }

  function startAnnotationGesture(event: ReactPointerEvent<HTMLElement>, annotation: PdfAnnotation, mode: AnnotationGesture['mode']) {
    if (!sheetRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = sheetRef.current.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      annotationId: annotation.id,
      changed: false,
      mode,
      originalAnnotations: annotationsRef.current,
      pointerId: event.pointerId,
      sheetHeight: Math.max(1, bounds.height),
      sheetWidth: Math.max(1, bounds.width),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidthRatio: annotation.widthRatio ?? (annotation.kind === 'signature' ? DEFAULT_SIGNATURE_WIDTH_RATIO : DEFAULT_TEXT_WIDTH_RATIO),
      startXRatio: annotation.xRatio,
      startYRatio: annotation.yRatio,
    }
    setSelectedAnnotationId(annotation.id)
    setPanel('edit')
    setTool(null)
  }

  function continueAnnotationGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const deltaX = (event.clientX - gesture.startClientX) / gesture.sheetWidth
    const deltaY = (event.clientY - gesture.startClientY) / gesture.sheetHeight
    if (Math.abs(deltaX) < .001 && Math.abs(deltaY) < .001) return
    gesture.changed = true
    const next = annotationsRef.current.map((annotation) => {
      if (annotation.id !== gesture.annotationId) return annotation
      if (gesture.mode === 'resize') return resizePdfAnnotation(annotation, gesture.startWidthRatio + deltaX)
      return movePdfAnnotation(annotation, gesture.startXRatio + deltaX, gesture.startYRatio + deltaY)
    })
    setAnnotationSnapshot(next)
  }

  function finishAnnotationGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    gestureRef.current = null
    if (!gesture.changed) return
    setUndoHistory((history) => [...history, gesture.originalAnnotations].slice(-60))
    setRedoHistory([])
  }

  function moveAnnotationWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>, annotation: PdfAnnotation) {
    const direction = { ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1] }[event.key]
    if (!direction) {
      if ((event.key === 'Delete' || event.key === 'Backspace') && annotation.id === selectedAnnotationId) {
        event.preventDefault()
        commitAnnotationSnapshot(annotationsRef.current.filter((item) => item.id !== annotation.id))
      }
      return
    }
    event.preventDefault()
    const step = event.shiftKey ? .02 : .004
    updateAnnotation(annotation.id, (current) => movePdfAnnotation(current, current.xRatio + direction[0] * step, current.yRatio + direction[1] * step))
  }

  function chooseFile(nextFile: File | null) {
    if (!nextFile) return
    setSourceBytes(null)
    setPdf(null)
    setFieldDetectionPending(true)
    setFile(nextFile)
    setTitle(nextFile.name.replace(/\.pdf$/i, ''))
    setSavedMessage(null)
    setSavedDocument(null)
    finalFileCacheRef.current = null
    closePreview()
    setSelectedAnnotationId(null)
    setAdvancedEditing(false)
    setUndoHistory([])
    setRedoHistory([])
    idempotencyKeysRef.current.clear()
  }

  function undo() {
    const previous = undoHistory.at(-1)
    if (!previous) return
    setUndoHistory((history) => history.slice(0, -1))
    setRedoHistory((history) => [...history, annotationsRef.current].slice(-60))
    setAnnotationSnapshot(previous)
  }

  function redo() {
    const next = redoHistory.at(-1)
    if (!next) return
    setRedoHistory((history) => history.slice(0, -1))
    setUndoHistory((history) => [...history, annotationsRef.current].slice(-60))
    setAnnotationSnapshot(next)
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!selectedVault) throw new Error('No document filing area is available for this PDF.')
      if (!employeeId) throw new Error('Choose the employee whose file should receive this document.')
      const finished = await createFinalFile()
      const savedFingerprint = documentFingerprint
      const savedEmployeeId = employeeId
      const idempotencyKey = idempotencyKeysRef.current.get(`save:${documentFingerprint}`) ?? crypto.randomUUID()
      idempotencyKeysRef.current.set(`save:${documentFingerprint}`, idempotencyKey)
      const result = await uploadHrDocument({
        accessClassification: selectedVault.classification,
        category,
        description,
        employeeId: employeeId === 'company' ? null : employeeId,
        file: finished,
        documentId: savedDocument?.employeeId === employeeId ? savedDocument.id : null,
        idempotencyKey,
        replacementReason: savedDocument?.employeeId === employeeId ? 'Updated from the Document Center workbench.' : null,
        title,
        vaultCode: selectedVault.code,
      }, setProgress)
      if (result.scanState === 'rejected' || result.scanState === 'cancelled') {
        throw new Error('This file could not be accepted. Download it, check the PDF, and try again.')
      }
      return { employeeId: savedEmployeeId, fingerprint: savedFingerprint, result }
    },
    onSuccess: ({ employeeId: savedEmployeeId, fingerprint, result }) => {
      const owner = savedEmployeeId === 'company' ? 'Company documents' : workspace.employees.find((employee) => employee.id === savedEmployeeId)?.legalName ?? 'the employee file'
      setSavedDocument({ employeeId: savedEmployeeId, fingerprint, id: result.documentId })
      setSavedMessage(`Saved to ${owner}.`)
      void queryClient.invalidateQueries({ queryKey: ['hr-documents'] })
      onSaved()
    },
  })

  const sendDocument = useMutation({
    mutationFn: async () => {
      if (!selectedVault) throw new Error('No document filing area is available for this PDF.')
      if (!recipientIds.length) throw new Error('Choose at least one recipient.')
      const standardPolicy = studio.data?.policies.find((policy) => policy.active && policy.code === 'STANDARD_EMPLOYEE_ELECTRONIC_SIGNATURE')
        ?? studio.data?.policies.find((policy) => policy.active && policy.code === 'EMPLOYEE_ACK')
        ?? studio.data?.policies.find((policy) => policy.active && policy.executionMethod === 'electronic')
      if (!standardPolicy) throw new Error('Document sending is temporarily unavailable. Your PDF can still be downloaded or saved to an employee file.')
      const finished = await createFinalFile()
      const filingEmployeeId = employeeId || 'company'
      let documentId = savedDocument?.fingerprint === documentFingerprint ? savedDocument.id : null
      if (!documentId) {
        const idempotencyKey = idempotencyKeysRef.current.get(`send-upload:${documentFingerprint}`) ?? crypto.randomUUID()
        idempotencyKeysRef.current.set(`send-upload:${documentFingerprint}`, idempotencyKey)
        const uploaded = await uploadHrDocument({
          accessClassification: selectedVault.classification,
          category,
          description,
          documentId: savedDocument?.employeeId === filingEmployeeId ? savedDocument.id : null,
          employeeId: filingEmployeeId !== 'company' ? filingEmployeeId : null,
          file: finished,
          idempotencyKey,
          replacementReason: savedDocument?.employeeId === filingEmployeeId ? 'Updated for delivery from the Document Center workbench.' : null,
          title,
          vaultCode: selectedVault.code,
        }, setProgress)
        if (uploaded.scanState === 'rejected' || uploaded.scanState === 'cancelled') {
          throw new Error('This file could not be accepted. Download it, check the PDF, and try again.')
        }
        documentId = uploaded.documentId
        setSavedDocument({ employeeId: filingEmployeeId, fingerprint: documentFingerprint, id: uploaded.documentId })
      }

      const deliveryFingerprint = JSON.stringify({ documentFingerprint, expiresAt, message, recipientIds: [...recipientIds].sort(), requiredAction })
      const envelopeKey = idempotencyKeysRef.current.get(`send-envelope:${deliveryFingerprint}`) ?? crypto.randomUUID()
      idempotencyKeysRef.current.set(`send-envelope:${deliveryFingerprint}`, envelopeKey)
      const created = await createSignatureEnvelope({
        documentId,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        idempotencyKey: envelopeKey,
        message: message.trim(),
        policyId: standardPolicy.id,
        recipients: recipientIds.map((recipientId) => ({
          authenticationTier: standardPolicy.authenticationTier,
          employeeId: recipientId,
          recipientRole: 'employee',
          requiredAction,
          routingOrder: 1,
        })),
        templateVersionId: null,
        title: title.trim(),
      })
      if (typeof created.id !== 'string') throw new Error('The document request confirmation was invalid.')
      await sendSignatureEnvelope(created.id)
    },
    onSuccess: async () => {
      setSavedMessage(`Sent to ${recipientIds.length} ${recipientIds.length === 1 ? 'employee' : 'employees'}. The request is now tracked under Signature requests.`)
      setRecipientIds([])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['document-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['hr-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['my-documents'] }),
        queryClient.invalidateQueries({ queryKey: ['my-notifications'] }),
      ])
      onSaved()
    },
  })

  async function download() {
    try {
      const finished = await createFinalFile()
      const url = URL.createObjectURL(finished)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = finished.name
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setSavedMessage('Downloaded. You can keep working or choose another destination.')
    } catch (error) {
      setLoadError(friendlyError(error, 'The completed PDF could not be downloaded.'))
    }
  }

  function renderTemplateControl(field: DetectedTemplateField) {
    const fieldAnnotation = annotations.find((annotation) => annotation.templateFieldKey === field.id)
    const value = fieldAnnotation?.text ?? field.defaultValue ?? ''
    const selected = selectedTemplateFieldId === field.id
    const hasValue = field.controlType === 'checkbox' ? value === 'true' : Boolean(value)
    const commonClassName = `document-workbench__template-control is-${field.controlType} is-${field.layout}${selected ? ' is-selected' : ''}${hasValue ? '' : ' is-empty'}`
    const commonStyle = {
      height: `${field.boxHeightRatio * 100}%`,
      left: `${field.xRatio * 100}%`,
      top: `${field.yRatio * 100}%`,
      width: `${field.widthRatio * 100}%`,
    }
    const stopSheetPlacement = (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation()
    const focusField = () => selectTemplateField(field)
    const registerControl = (element: HTMLElement | null) => {
      if (element) templateControlRefs.current.set(field.id, element)
      else templateControlRefs.current.delete(field.id)
    }

    if (field.layout === 'inline-body') {
      return <button
        aria-label={`${field.label} in document body${value ? `: ${value}` : ''}`}
        className={`${commonClassName} document-workbench__template-anchor`}
        key={field.id}
        onClick={() => selectTemplateField(field, { focusSidebar: true })}
        onPointerDown={stopSheetPlacement}
        ref={registerControl}
        style={commonStyle}
        title={`Edit ${field.label} without covering the document body`}
        type="button"
      ><span>{value || 'Edit'}</span></button>
    }

    if (field.controlType === 'checkbox') {
      const checked = value === 'true'
      return <button
        aria-label={`${field.label} on document: ${checked ? 'checked' : 'not checked'}`}
        aria-pressed={checked}
        className={commonClassName}
        key={field.id}
        onClick={() => updateTemplateField(field, String(!checked))}
        onFocus={focusField}
        onPointerDown={stopSheetPlacement}
        ref={registerControl}
        style={commonStyle}
        title={`${checked ? 'Clear' : 'Check'} ${field.label}`}
        type="button"
      >{checked ? <Check aria-hidden="true" /> : null}</button>
    }

    if (field.controlType === 'signature') {
      return <button
        aria-label={`Signature field ${field.label} on document${value ? `: ${value}` : ''}`}
        className={commonClassName}
        key={field.id}
        onClick={focusField}
        onPointerDown={stopSheetPlacement}
        ref={registerControl}
        style={commonStyle}
        title={value ? `Edit signature for ${value}` : `Sign ${field.label}`}
        type="button"
      >{fieldAnnotation ? <SignatureImage annotation={fieldAnnotation} /> : <span>Sign here</span>}</button>
    }

    if (field.controlType === 'choice' && field.options?.length) {
      return <select
        aria-label={`${field.label} on document`}
        className={commonClassName}
        key={field.id}
        onChange={(event) => updateTemplateField(field, event.target.value)}
        onFocus={focusField}
        onPointerDown={stopSheetPlacement}
        ref={registerControl}
        style={commonStyle}
        value={value}
      ><option value="">Choose</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    }

    if (field.controlType === 'long_text') {
      return <textarea
        aria-label={`${field.label} on document`}
        className={commonClassName}
        key={field.id}
        maxLength={4000}
        onChange={(event) => updateTemplateField(field, event.target.value)}
        onFocus={focusField}
        onPointerDown={stopSheetPlacement}
        placeholder="Click to type"
        ref={registerControl}
        spellCheck
        style={{ ...commonStyle, fontSize: `${Math.max(7, field.fontSize * sheetScale)}px` }}
        value={value}
      />
    }

    const fittedFontSize = Math.max(6, Math.min(
      field.fontSize * sheetScale,
      (field.widthRatio * sheetSize.width - 10) / Math.max(1, value.length * .52),
    ))
    return <input
      aria-label={`${field.label} on document`}
      className={commonClassName}
      key={field.id}
      maxLength={1000}
      onChange={(event) => updateTemplateField(field, event.target.value)}
      onFocus={focusField}
      onPointerDown={stopSheetPlacement}
      placeholder={field.controlType === 'date' ? 'Date' : 'Click to type'}
      ref={registerControl}
      spellCheck
      style={{ ...commonStyle, fontSize: `${fittedFontSize}px` }}
      value={value}
    />
  }

  function renderGuidedField(field: DetectedTemplateField) {
    const fieldAnnotation = annotations.find((annotation) => annotation.templateFieldKey === field.id)
    const value = fieldAnnotation?.text ?? field.defaultValue ?? ''
    const selected = selectedTemplateFieldId === field.id
    const controlId = `guided-${field.id.replace(/[^a-z0-9_-]/gi, '-')}`
    const focusField = () => selectTemplateField(field)
    const registerControl = (element: HTMLElement | null) => {
      if (element) guidedControlRefs.current.set(field.id, element)
      else guidedControlRefs.current.delete(field.id)
    }
    const jumpToField = <button
      aria-label={`Show ${field.label} on form`}
      className="document-workbench__guided-jump"
      onClick={() => selectTemplateField(field, { focusDocument: true })}
      type="button"
    >Show on form</button>

    if (field.mappingStatus === 'review' && advancedEditing) {
      return <div className={`document-workbench__guided-field document-workbench__mapping-review${selected ? ' is-active' : ''}`} key={field.id}>
        <div className="document-workbench__guided-field-heading"><strong>Confirm this field</strong><span>Page {field.page}</span></div>
        <p>The PDF only says “{field.rawLabel}.” Give it a clear label and type so it cannot be completed incorrectly.</p>
        <label className="document-workbench__mapping-control">Field label<input maxLength={120} onChange={(event) => updateTemplateFieldDefinition(field.id, { label: event.target.value })} onFocus={focusField} ref={registerControl as (element: HTMLInputElement | null) => void} value={field.label} /></label>
        <label className="document-workbench__mapping-control">Field type<select onChange={(event) => updateTemplateFieldDefinition(field.id, { controlType: event.target.value as DetectedTemplateField['controlType'] })} value={field.controlType}><option value="text">Short text</option><option value="long_text">Long response</option><option value="date">Date / time</option><option value="signature">Signature</option><option value="checkbox">Checkbox</option></select></label>
        <div className="document-workbench__guided-actions"><button className="primary-action primary-action--small" onClick={() => confirmTemplateFieldMapping(field)} type="button">Use this mapping</button>{jumpToField}</div>
      </div>
    }

    if (field.mappingStatus === 'review') {
      return <div className={`document-workbench__guided-field document-workbench__mapping-review${selected ? ' is-active' : ''}`} key={field.id}>
        <div className="document-workbench__guided-field-heading"><strong>Template repair needed</strong><span>Page {field.page}</span></div>
        <p>This source does not identify this field clearly, so SygShift will not guess. A document manager must repair this template or provide a generated replacement.</p>
        {jumpToField}
      </div>
    }

    if (field.controlType === 'signature') {
      return <div className={`document-workbench__guided-signature${selected ? ' is-active' : ''}`} key={field.id}>
        <div className="document-workbench__guided-field-heading"><strong>{field.label}</strong><span>Signature · Page {field.page}</span></div>
        <p>{field.description}</p>
        <div className="document-workbench__guided-actions">
          <button className="secondary-button secondary-button--small" onClick={() => selectTemplateField(field, { focusDocument: true })} ref={registerControl} type="button">{fieldAnnotation ? 'Review signature' : 'Add signature'}</button>
          {jumpToField}
        </div>
        <small>{fieldAnnotation ? `${fieldAnnotation.text} is placed in this signature field.` : 'No signature has been placed.'}</small>
      </div>
    }

    const heading = <div className="document-workbench__guided-field-heading"><label htmlFor={controlId}>{field.label}</label><span>{field.controlType === 'date' ? 'Date / time' : field.controlType.replace('_', ' ')} · Page {field.page}</span></div>
    const control = field.controlType === 'checkbox'
      ? <label className="document-workbench__guided-check" htmlFor={controlId}><input checked={value === 'true'} id={controlId} onChange={(event) => updateTemplateField(field, String(event.target.checked))} onFocus={focusField} ref={registerControl as (element: HTMLInputElement | null) => void} type="checkbox"/><span>Yes</span></label>
      : field.controlType === 'choice' && field.options?.length
        ? <select id={controlId} onChange={(event) => updateTemplateField(field, event.target.value)} onFocus={focusField} ref={registerControl as (element: HTMLSelectElement | null) => void} value={value}><option value="">Choose an option</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : field.controlType === 'long_text'
          ? <textarea id={controlId} maxLength={4000} onChange={(event: ReactChangeEvent<HTMLTextAreaElement>) => updateTemplateField(field, event.target.value)} onFocus={focusField} placeholder={`Enter ${field.label.toLocaleLowerCase()}`} ref={registerControl as (element: HTMLTextAreaElement | null) => void} rows={4} value={value}/>
          : <input id={controlId} inputMode={field.controlType === 'date' ? 'numeric' : undefined} maxLength={1000} onChange={(event: ReactChangeEvent<HTMLInputElement>) => updateTemplateField(field, event.target.value)} onFocus={focusField} placeholder={field.controlType === 'date' ? 'MM/DD/YYYY or date/time' : `Enter ${field.label.toLocaleLowerCase()}`} ref={registerControl as (element: HTMLInputElement | null) => void} value={value}/>
    return <div className={`document-workbench__guided-field${selected ? ' is-active' : ''}${field.layout === 'inline-body' ? ' is-inline-body' : ''}`} key={field.id}>
      {heading}
      <p>{field.description}</p>
      {control}
      {jumpToField}
    </div>
  }

  const visibleAnnotations = annotations.filter((annotation) => annotation.page === page
    && (panel !== 'edit' || !annotation.templateFieldKey)
    && !(annotation.nativeFieldType === 'checkbox' && annotation.text !== 'true'))
  const visibleTemplateFields = templateFields.filter((field) => field.page === page)
  const selectedTemplateField = templateFields.find((field) => field.id === selectedTemplateFieldId) ?? null
  const selectedTemplateAnnotation = selectedTemplateField ? annotations.find((annotation) => annotation.templateFieldKey === selectedTemplateField.id) ?? null : null
  const selectedTextAnnotation = selectedAnnotation?.kind === 'text' ? selectedAnnotation : null
  const selectedSignatureAnnotation = selectedAnnotation?.kind === 'signature' ? selectedAnnotation : null
  const templateFieldGroups = [...templateFields.reduce((groups, field) => {
    const existing = groups.get(field.groupLabel)
    if (existing) existing.push(field)
    else groups.set(field.groupLabel, [field])
    return groups
  }, new Map<string, DetectedTemplateField[]>()).entries()]
  const completedTemplateFields = templateFields.filter((field) => {
    const value = annotations.find((annotation) => annotation.templateFieldKey === field.id)?.text ?? field.defaultValue ?? ''
    return field.controlType === 'checkbox' ? value === 'true' : Boolean(value.trim())
  }).length
  const reviewTemplateFields = templateFields.filter((field) => field.mappingStatus === 'review').length
  const busy = save.isPending || sendDocument.isPending || previewBusy
  const operationError = save.error ?? sendDocument.error

  return <ModalDialog
    busy={busy}
    busyLabel={previewBusy ? 'Building the finished preview…' : save.isPending ? `Saving document… ${progress}%` : progress < 100 ? `Preparing document… ${progress}%` : 'Sending document…'}
    className={`document-workbench${maximized ? ' is-maximized' : ''}`}
    description={file ? 'Answer the guided questions, review the exact completed PDF, then download, file, or send it.' : 'Choose a PDF from your device. It opens immediately so you can work without a setup process.'}
    dismissible={!busy}
    headingIcon={<FilePenLine />}
    onClose={onClose}
    title={file ? title || 'Work on document' : employeeOnly ? 'Add to an employee file' : 'Open a document'}
  >
    {!file ? <div className="document-workbench__start">
      <div className={`document-workbench__dropzone${dragActive ? ' active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragLeave={() => setDragActive(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragActive(false); chooseFile(event.dataTransfer.files.item(0)) }}>
        <input accept="application/pdf,.pdf" hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={inputRef} type="file" />
        <UploadCloud aria-hidden="true" size={42} />
        <h3>Drop a PDF here</h3>
        <p>Or choose one from your computer. It will open here immediately.</p>
        <button className="primary-action" data-dialog-autofocus onClick={() => inputRef.current?.click()} type="button">Choose PDF</button>
      </div>
      <div className="document-workbench__start-notes"><span><CheckCircle2 size={18} />Type directly on the document</span><span><CheckCircle2 size={18} />Create a signature from a typed name</span><span><CheckCircle2 size={18} />Download, send, or add to an employee file</span></div>
    </div> : <div className="document-workbench__body">
      <header className="document-workbench__toolbar">
        <div className="document-workbench__paging">
          <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button"><ChevronLeft size={18} /></button>
          <strong>Page {page} of {pdf?.numPages ?? '—'}</strong>
          <button aria-label="Next page" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((current) => Math.min(pdf?.numPages ?? current, current + 1))} type="button"><ChevronRight size={18} /></button>
        </div>
        <div className="document-workbench__history">
          <button aria-label="Undo last document change" disabled={!undoHistory.length} onClick={undo} title="Undo" type="button"><Undo2 size={18} /></button>
          <button aria-label="Redo last document change" disabled={!redoHistory.length} onClick={redo} title="Redo" type="button"><Redo2 size={18} /></button>
          <button aria-label="Clear all additions" disabled={!annotations.length} onClick={() => { commitAnnotationSnapshot([]); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} title="Clear all additions" type="button"><Trash2 size={18} /></button>
        </div>
        <button aria-label={maximized ? 'Restore editor size' : 'Maximize editor'} aria-pressed={maximized} className="document-workbench__maximize" onClick={() => setMaximized((current) => !current)} title={maximized ? 'Restore editor size' : 'Maximize editor'} type="button">{maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        <button className="secondary-button secondary-button--small" onClick={() => inputRef.current?.click()} type="button">Choose another PDF</button>
        <input accept="application/pdf,.pdf" hidden onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} ref={inputRef} type="file" />
      </header>

      <div className={`document-workbench__main${panel === 'edit' && templateFields.length > 0 && !advancedEditing ? ' is-guided' : ''}`}>
        <section className="document-workbench__document" aria-busy={rendering} ref={viewportRef}>
          {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
          {!pdf && !loadError ? <p className="document-workbench__loading">Opening PDF…</p> : null}
          <div className={`document-workbench__sheet${tool ? ' is-placing' : ''}`} onPointerDown={(event) => void addAnnotation(event)} ref={sheetRef} style={{ height: sheetSize.height || undefined, width: sheetSize.width || undefined }}>
            <canvas hidden={!pdf || !sheetSize.width} ref={canvasRef} />
            {panel === 'edit' ? (advancedEditing ? visibleTemplateFields : visibleTemplateFields.filter((field) => field.id === selectedTemplateFieldId)).map(renderTemplateControl) : null}
            {visibleAnnotations.map((annotation) => <div
              className={`document-workbench__annotation is-${annotation.kind}${annotation.templateFieldKey ? ' is-template-field' : ''}${annotation.nativeFieldName ? ' is-native-field' : ''}${selectedAnnotationId === annotation.id ? ' is-selected' : ''}`}
              key={annotation.id}
              style={{
                left: `${annotation.xRatio * 100}%`,
                top: `${annotation.yRatio * 100}%`,
                ...(annotation.kind === 'text' ? {
                  fontSize: `${annotation.fitMode === 'single-line'
                    ? Math.max(6, Math.min((annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) * sheetScale, ((annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * sheetSize.width - 12) / Math.max(1, annotation.text.length * .52)))
                    : Math.max(10, (annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) * sheetScale)}px`,
                  ...(annotation.boxHeightRatio ? { height: `${annotation.boxHeightRatio * 100}%` } : {}),
                  whiteSpace: annotation.fitMode === 'single-line' ? 'nowrap' : undefined,
                  width: `${(annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * 100}%`,
                } : {}),
                ...(annotation.kind === 'signature' ? { fontFamily: `"${annotation.fontFamily ?? signatureFamily}", cursive`, fontSize: `${Math.max(18, (annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * sheetSize.width / 5)}px`, ...(annotation.boxHeightRatio ? { height: `${annotation.boxHeightRatio * 100}%` } : {}), width: `${(annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * 100}%` } : {}),
              }}
            >
              <button
                aria-label={`${annotation.kind === 'text' ? 'Text box' : annotation.kind}: ${annotation.text}${annotation.templateFieldKey || annotation.nativeFieldName ? '' : '. Drag or use arrow keys to move.'}`}
                aria-pressed={selectedAnnotationId === annotation.id}
                className="document-workbench__annotation-content"
                onClick={() => { if (!annotation.templateFieldKey && !annotation.nativeFieldName) { setSelectedAnnotationId(annotation.id); setSelectedTemplateFieldId(null); setTool(null); setPanel('edit') } }}
                onKeyDown={(event) => { if (!annotation.templateFieldKey && !annotation.nativeFieldName) moveAnnotationWithKeyboard(event, annotation) }}
                onPointerCancel={finishAnnotationGesture}
                onPointerDown={(event) => annotation.templateFieldKey || annotation.nativeFieldName ? event.stopPropagation() : startAnnotationGesture(event, annotation, 'move')}
                onPointerMove={continueAnnotationGesture}
                onPointerUp={finishAnnotationGesture}
                title={annotation.templateFieldKey || annotation.nativeFieldName ? 'Placed automatically from the form answer.' : 'Drag to move. Arrow keys also move this item.'}
                type="button"
              >{annotation.kind === 'signature' ? <SignatureImage annotation={annotation} /> : annotation.nativeFieldType === 'checkbox' ? '✓' : annotation.text}</button>
              {(annotation.kind === 'text' || annotation.kind === 'signature') && !annotation.templateFieldKey && !annotation.nativeFieldName && selectedAnnotationId === annotation.id ? <button
                aria-label={annotation.kind === 'signature' ? 'Resize selected signature' : 'Resize selected text box'}
                className="document-workbench__resize-handle"
                onPointerCancel={finishAnnotationGesture}
                onPointerDown={(event) => startAnnotationGesture(event, annotation, 'resize')}
                onPointerMove={continueAnnotationGesture}
                onPointerUp={finishAnnotationGesture}
                title="Drag to resize text box"
                type="button"
              ><Scaling aria-hidden="true" size={13} /></button> : null}
            </div>)}
          </div>
        </section>

        <aside className="document-workbench__side">
          <div className="document-workbench__side-tabs" role="tablist" aria-label="Document actions">
            <button aria-selected={panel === 'edit'} className={panel === 'edit' ? 'active' : ''} onClick={() => setPanel('edit')} role="tab" type="button"><FilePenLine size={17} />{templateFields.length && !advancedEditing ? 'Questions' : 'Edit PDF'}</button>
            <button aria-selected={panel === 'file'} className={panel === 'file' ? 'active' : ''} onClick={() => setPanel('file')} role="tab" type="button"><FolderInput size={17} />File</button>
            <button aria-selected={panel === 'send'} className={panel === 'send' ? 'active' : ''} onClick={() => setPanel('send')} role="tab" type="button"><Send size={17} />Send</button>
          </div>

          {panel === 'edit' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">{templateFields.length && !advancedEditing ? 'Complete document' : 'Advanced PDF tools'}</p><h3>{templateFields.length && !advancedEditing ? 'Answer the form questions' : 'Add or adjust PDF content'}</h3><p>{templateFields.length && !advancedEditing ? 'Your answers are placed in the correct locations automatically. Use “Show on form” whenever you want to verify a placement.' : 'Use these tools only when this copy needs text or a signature that is not part of the guided form.'}</p></div>
            {!advancedEditing && selectedTemplateField?.controlType === 'signature' ? <section className="document-workbench__direct-signature" aria-label={`Sign ${selectedTemplateField.label}`}>
              <div className="document-workbench__selection-heading"><span><FileSignature aria-hidden="true" size={17} /></span><div><strong>{selectedTemplateAnnotation ? 'Update this signature' : 'Sign this field'}</strong><small>{selectedTemplateField.label} · Page {selectedTemplateField.page}</small></div></div>
              <label className="document-workbench__field">Signer name<input autoFocus maxLength={120} onChange={(event) => setSignatureName(event.target.value)} placeholder="Type the full name" value={signatureName} /></label>
              <div className="document-workbench__signature-preview" style={{ fontFamily: `"${signatureFamily}", cursive` }}>{signatureName || 'Your signature'}</div>
              <div className="document-workbench__signature-styles" aria-label="Signature style">{signatureFamilies.map((family) => <button aria-pressed={signatureFamily === family} className={signatureFamily === family ? 'active' : ''} key={family} onClick={() => setSignatureFamily(family)} style={{ fontFamily: `"${family}", cursive` }} type="button">{signatureName || 'Signature'}</button>)}</div>
              <div className="document-workbench__direct-signature-actions"><button className="primary-action" disabled={!signatureName.trim()} onClick={() => void placeTemplateSignature(selectedTemplateField)} type="button">{selectedTemplateAnnotation ? 'Update signature' : 'Place signature'}</button>{selectedTemplateAnnotation ? <button className="danger-button danger-button--small" onClick={() => removeTemplateSignature(selectedTemplateField)} type="button"><Trash2 size={16} />Remove</button> : null}</div>
            </section> : null}
            {templateFields.length && !advancedEditing ? <section className="document-workbench__guided-fields" aria-label="Form questions">
              <label className="document-workbench__guided-employee">Whose form is this?<select onChange={(event) => { const nextEmployeeId = event.target.value; setEmployeeId(nextEmployeeId); if (nextEmployeeId !== 'company') fillSelectedEmployeeDetails(nextEmployeeId) }} value={employeeId}><option value="company">Not tied to one employee</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.legalName}{employee.employeeNumber ? ` · ${employee.employeeNumber}` : ''}</option>)}</select><small>Choosing an employee fills matching name, ID, title, supervisor, location, and company fields when available.</small></label>
              <div className="document-workbench__guided-heading"><div><p className="eyebrow">Form questions</p><h3>{templateFields.length} {templateFields.length === 1 ? 'question' : 'questions'}</h3><p>Complete each section below. SygShift places every answer into the finished document.</p></div>{workspace.employees.some((employee) => employee.id === employeeId) ? <button className="secondary-button secondary-button--small" onClick={() => fillSelectedEmployeeDetails()} type="button">Fill employee details</button> : null}</div>
              <section aria-label="Document readiness" className={`document-workbench__readiness${reviewTemplateFields || fieldDetectionTruncated ? ' needs-review' : ''}`}>
                <div><strong>{fieldDetectionTruncated ? 'Template repair required' : reviewTemplateFields ? 'Template repair needed' : completedTemplateFields ? 'Ready for final preview' : 'Ready to complete'}</strong><span>{completedTemplateFields} of {templateFields.length} answered</span></div>
                <p>{fieldDetectionTruncated ? `This PDF exceeds the ${MAX_DETECTED_TEMPLATE_FIELDS}-question safety limit and needs a generated replacement or a managed template.` : reviewTemplateFields ? `${reviewTemplateFields} ${reviewTemplateFields === 1 ? 'question needs' : 'questions need'} template repair. SygShift will not guess where information belongs.` : 'Preview the finished PDF before you download, file, or send it.'}</p>
              </section>
              <div className="document-workbench__guided-list">{templateFieldGroups.map(([groupLabel, fields]) => <section className="document-workbench__guided-group" key={groupLabel}><header><strong>{groupLabel}</strong><span>{fields.length} {fields.length === 1 ? 'field' : 'fields'}</span></header>{fields.map(renderGuidedField)}</section>)}</div>
              <button className="secondary-button document-workbench__advanced-toggle" onClick={() => { setAdvancedEditing(true); setSelectedTemplateFieldId(null); setTool(null) }} type="button">Advanced PDF tools</button>
            </section> : null}
            {!templateFields.length && !advancedEditing ? <section className="document-workbench__advanced-notice"><strong>No guided questions were found</strong><p>This PDF can still be completed with the manual text, date, checkmark, and signature tools.</p><button className="secondary-button" onClick={() => { setAdvancedEditing(true); setTool('text') }} type="button">Open advanced PDF tools</button></section> : null}
            {advancedEditing && templateFields.length ? <section className="document-workbench__advanced-notice"><strong>Advanced PDF tools</strong><p>Manual additions are available below. Guided answers stay saved while you make adjustments.</p><button className="secondary-button" onClick={() => { setAdvancedEditing(false); setTool(null); setSelectedAnnotationId(null) }} type="button">Back to questions</button></section> : null}
            {advancedEditing && reviewTemplateFields ? <section className="document-workbench__guided-fields" aria-label="Template repair controls"><div className="document-workbench__guided-heading"><div><p className="eyebrow">Template administration</p><h3>Repair unclear fields</h3><p>These mapping controls are for document managers, not routine form completion.</p></div></div><div className="document-workbench__guided-list">{templateFieldGroups.map(([groupLabel, fields]) => fields.some((field) => field.mappingStatus === 'review') ? <section className="document-workbench__guided-group" key={groupLabel}><header><strong>{groupLabel}</strong></header>{fields.filter((field) => field.mappingStatus === 'review').map(renderGuidedField)}</section> : null)}</div></section> : null}
            {advancedEditing ? <div className="document-workbench__tools">
              <button aria-pressed={tool === null && !selectedTemplateFieldId} className={tool === null && !selectedTemplateFieldId ? 'active' : ''} onClick={() => { setTool(null); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><Move size={18} /><span>Select / move</span></button>
              <button aria-pressed={tool === 'text' && !selectedAnnotationId} className={tool === 'text' && !selectedAnnotationId ? 'active' : ''} onClick={() => { setTool('text'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><Type size={18} /><span>Text</span></button>
              <button aria-pressed={tool === 'signature'} className={tool === 'signature' ? 'active' : ''} onClick={() => { setTool('signature'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><FileSignature size={18} /><span>Signature</span></button>
              <button aria-pressed={tool === 'date'} className={tool === 'date' ? 'active' : ''} onClick={() => { setTool('date'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><CalendarDays size={18} /><span>Date</span></button>
              <button aria-pressed={tool === 'checkmark'} className={tool === 'checkmark' ? 'active' : ''} onClick={() => { setTool('checkmark'); setSelectedAnnotationId(null); setSelectedTemplateFieldId(null) }} type="button"><Check size={18} /><span>Check</span></button>
            </div> : null}
            {advancedEditing && (tool === 'text' || selectedTextAnnotation) ? <>
              <label className="document-workbench__field">{selectedTextAnnotation ? 'Selected text box' : 'Text to add'}<textarea maxLength={2000} onChange={(event) => selectedTextAnnotation ? updateAnnotation(selectedTextAnnotation.id, (current) => ({ ...current, text: event.target.value })) : setTextValue(event.target.value)} placeholder="Type the complete text here" rows={4} value={selectedTextAnnotation?.text ?? textValue} /></label>
              {selectedTextAnnotation ? <section className="document-workbench__text-controls" aria-label="Selected text box controls">
                <div className="document-workbench__selection-heading"><span><Move aria-hidden="true" size={17} /></span><div><strong>Selected text box</strong><small>Drag the text to move it. Drag its gold corner to resize the box.</small></div></div>
                <div className="document-workbench__size-control"><span>Text size</span><div><button aria-label="Decrease text size" disabled={(selectedTextAnnotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) <= 8} onClick={() => updateAnnotation(selectedTextAnnotation.id, (current) => ({ ...current, fontSize: Math.max(8, (current.fontSize ?? DEFAULT_TEXT_FONT_SIZE) - 1) }))} type="button"><Minus size={16} /></button><output>{selectedTextAnnotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE} pt</output><button aria-label="Increase text size" disabled={(selectedTextAnnotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE) >= 28} onClick={() => updateAnnotation(selectedTextAnnotation.id, (current) => ({ ...current, fontSize: Math.min(28, (current.fontSize ?? DEFAULT_TEXT_FONT_SIZE) + 1) }))} type="button"><Plus size={16} /></button></div></div>
                <label className="document-workbench__width-control">Text box width <output>{Math.round((selectedTextAnnotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * 100)}%</output><input aria-label="Text box width" max="88" min="16" onChange={(event) => updateAnnotation(selectedTextAnnotation.id, (current) => resizePdfTextAnnotation(current, Number(event.target.value) / 100))} type="range" value={Math.round((selectedTextAnnotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) * 100)} /></label>
                <div className="document-workbench__selection-actions"><button className="secondary-button secondary-button--small" onClick={() => { setSelectedAnnotationId(null); setTextValue('') }} type="button"><Type size={16} />Add another text box</button><button className="danger-button danger-button--small" onClick={() => { commitAnnotationSnapshot(annotationsRef.current.filter((item) => item.id !== selectedTextAnnotation.id)); setSelectedAnnotationId(null) }} type="button"><Trash2 size={16} />Remove text box</button></div>
              </section> : null}
            </> : null}
            {advancedEditing && (tool === 'signature' || selectedSignatureAnnotation) ? <div className="document-workbench__signature">
              {selectedSignatureAnnotation ? <section className="document-workbench__text-controls" aria-label="Selected signature controls">
                <div className="document-workbench__selection-heading"><span><Move aria-hidden="true" size={17} /></span><div><strong>Selected signature</strong><small>Drag the signature to move it. Drag its gold corner or use the size control below.</small></div></div>
                <div className="document-workbench__selected-signature"><SignatureImage annotation={selectedSignatureAnnotation} /></div>
                <label className="document-workbench__width-control">Signature size <output>{Math.round((selectedSignatureAnnotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * 100)}%</output><input aria-label="Signature size" max="70" min="12" onChange={(event) => updateAnnotation(selectedSignatureAnnotation.id, (current) => resizePdfAnnotation(current, Number(event.target.value) / 100))} type="range" value={Math.round((selectedSignatureAnnotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO) * 100)} /></label>
                <div className="document-workbench__selection-actions"><button className="secondary-button secondary-button--small" onClick={() => { setSelectedAnnotationId(null); setTool('signature') }} type="button"><FileSignature size={16} />Add another signature</button><button className="danger-button danger-button--small" onClick={() => { commitAnnotationSnapshot(annotationsRef.current.filter((item) => item.id !== selectedSignatureAnnotation.id)); setSelectedAnnotationId(null); setTool(null) }} type="button"><Trash2 size={16} />Remove signature</button></div>
              </section> : <>
                <label className="document-workbench__field">Signer name<input maxLength={120} onChange={(event) => setSignatureName(event.target.value)} placeholder="Type the full name" value={signatureName} /></label>
                <div className="document-workbench__signature-preview" style={{ fontFamily: `"${signatureFamily}", cursive` }}>{signatureName || 'Your signature'}</div>
                <div className="document-workbench__signature-styles" aria-label="Signature style">{signatureFamilies.map((family) => <button aria-pressed={signatureFamily === family} className={signatureFamily === family ? 'active' : ''} key={family} onClick={() => setSignatureFamily(family)} style={{ fontFamily: `"${family}", cursive` }} type="button">{signatureName || 'Signature'}</button>)}</div>
              </>}
            </div> : null}
            {advancedEditing ? <p className="document-workbench__tip">Tip: select an item to move it. Text boxes can also wrap, resize, and be edited after placement.</p> : null}
          </div> : null}

          {panel === 'file' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">Save to SygShift</p><h3>{employeeOnly ? 'Add to an employee file' : 'Choose where this belongs'}</h3><p>The filing area is selected automatically. Choose only the person or company record.</p></div>
            <label className="document-workbench__field">Document title<input maxLength={160} onChange={(event) => setTitle(event.target.value)} value={title} /></label>
            {!employeeOnly ? <label className="document-workbench__choice"><input checked={employeeId === 'company'} onChange={() => setEmployeeId('company')} type="radio" /><span><strong>Company documents</strong><small>Shared company record</small></span></label> : null}
            <label className="document-workbench__field">Find an employee<div className="document-workbench__search"><Search size={17} /><input maxLength={120} onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search by name or employee number" value={employeeSearch} /></div></label>
            <div className="document-workbench__people">{filteredEmployees.map((employee) => <label className="document-workbench__choice" key={employee.id}><input checked={employeeId === employee.id} onChange={() => setEmployeeId(employee.id)} type="radio" /><span><strong>{employee.legalName}</strong><small>{employee.employeeNumber ?? 'Employee record'}</small></span></label>)}</div>
            <label className="document-workbench__field">Document type<select onChange={(event) => setCategory(event.target.value)} value={category}><option>Business document</option><option>Proposal</option><option>Employment document</option><option>Policy or acknowledgment</option><option>Training document</option><option>Other</option></select></label>
            <label className="document-workbench__field">Note <span>Optional</span><textarea maxLength={1000} onChange={(event) => setDescription(event.target.value)} placeholder="Add a short internal note" rows={3} value={description} /></label>
            <button className="primary-action document-workbench__wide-action" disabled={!sourceBytes || fieldDetectionPending || !employeeId || !title.trim() || save.isPending || savedDocument?.fingerprint === documentFingerprint} onClick={() => save.mutate()} type="button"><FolderInput size={18} />{savedDocument?.fingerprint === documentFingerprint ? 'Saved' : employeeId === 'company' ? 'Save to company documents' : 'Add to employee file'}</button>
          </div> : null}

          {panel === 'send' ? <div className="document-workbench__panel">
            <div><p className="eyebrow">Send from SygShift</p><h3>Who needs this document?</h3><p>Choose the people and what they need to do. SygShift handles the delivery details.</p></div>
            <label className="document-workbench__field">Action<select onChange={(event) => setRequiredAction(event.target.value as RequiredAction)} value={requiredAction}>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="document-workbench__field">Find recipients<div className="document-workbench__search"><Search size={17} /><input maxLength={120} onChange={(event) => setRecipientSearch(event.target.value)} placeholder="Search employees" value={recipientSearch} /></div></label>
            <div className="document-workbench__people"><p>{recipientIds.length} selected</p>{filteredRecipients.map((employee) => <label className="document-workbench__choice" key={employee.id}><input checked={recipientIds.includes(employee.id)} onChange={() => setRecipientIds((current) => current.includes(employee.id) ? current.filter((id) => id !== employee.id) : current.length < 25 ? [...current, employee.id] : current)} type="checkbox" /><span><strong>{employee.legalName}</strong><small>{employee.employeeNumber ?? 'Active employee'}</small></span></label>)}</div>
            <label className="document-workbench__field">Message <span>Optional</span><textarea maxLength={2000} onChange={(event) => setMessage(event.target.value)} rows={3} value={message} /></label>
            <label className="document-workbench__field">Due date <span>Optional</span><input onChange={(event) => setExpiresAt(event.target.value)} type="datetime-local" value={expiresAt} /></label>
            {studio.isError ? <p className="form-error">Document sending is temporarily unavailable. Download and filing still work.</p> : null}
            <button className="primary-action document-workbench__wide-action" disabled={!sourceBytes || fieldDetectionPending || !recipientIds.length || !title.trim() || !studio.data || sendDocument.isPending} onClick={() => sendDocument.mutate()} type="button"><Send size={18} />Send document</button>
          </div> : null}
        </aside>
      </div>

      <footer className="document-workbench__footer">
        <div aria-live="polite">{savedMessage ? <span className="document-workbench__success"><CheckCircle2 size={18} />{savedMessage}</span> : templateFields.length && !advancedEditing ? <span>{completedTemplateFields} of {templateFields.length} questions answered · Preview the finished PDF before filing, sending, or downloading.</span> : <span>{annotations.length} {annotations.length === 1 ? 'addition' : 'additions'} · Changes are applied when you download, send, or file the PDF.</span>}</div>
        {operationError || previewError ? <p className="form-error" role="alert">{previewError ?? friendlyError(operationError, 'The document action could not be completed.')}</p> : null}
        <div><button className="secondary-button" disabled={busy} onClick={onClose} type="button">Close</button><button className="secondary-button" disabled={!sourceBytes || fieldDetectionPending || !title.trim() || busy} onClick={() => void openPreview()} type="button"><Eye size={18} />Preview finished PDF</button><button className="primary-action" disabled={!sourceBytes || fieldDetectionPending || !title.trim() || busy} onClick={() => void download()} type="button"><Download size={18} />Download PDF</button></div>
      </footer>
      {preview ? <ModalDialog className="document-workbench-preview" description="This is the exact completed PDF that will be downloaded, filed, or sent." onClose={closePreview} title={`Review ${title}`}><div className="document-workbench-preview__body" data-output-fingerprint={preview.fingerprint}><SecurePdfViewer bytes={preview.bytes} title={`Finished ${title}`} /><footer><button className="secondary-button" onClick={closePreview} type="button">Back to editing</button><button className="primary-action" onClick={() => void download()} type="button"><Download size={18} />Download this PDF</button></footer></div></ModalDialog> : null}
    </div>}
  </ModalDialog>
}

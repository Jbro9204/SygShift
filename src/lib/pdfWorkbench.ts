import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  rgb,
} from 'pdf-lib'

export type PdfAnnotationKind = 'checkmark' | 'date' | 'signature' | 'text'
export type PdfTemplateFieldLayout = 'field-box' | 'inline-body'
export type PdfTemplateFieldType = 'checkbox' | 'choice' | 'date' | 'long_text' | 'signature' | 'text'

export interface PdfInlineSourceLine {
  baselineRatio: number
  heightRatio: number
  id: string
  text: string
  topRatio: number
  widthRatio: number
  xRatio: number
}

export interface PdfInlineSourceSpan {
  length: number
  start: number
}

export interface PdfAnnotation {
  boxHeightRatio?: number
  eraseHeightRatio?: number
  eraseWidthRatio?: number
  eraseXRatio?: number
  eraseYRatio?: number
  fieldLabel?: string
  fitMode?: 'bounded' | 'free' | 'single-line'
  fontSize?: number
  fontFamily?: string
  id: string
  kind: PdfAnnotationKind
  nativeFieldName?: string
  nativeFieldType?: 'checkbox' | 'choice' | 'text'
  page: number
  sourceLine?: PdfInlineSourceLine
  sourceSpan?: PdfInlineSourceSpan
  text: string
  widthRatio?: number
  xRatio: number
  yRatio: number
  signaturePng?: Uint8Array
  templateFieldKey?: string
  templateFieldLayout?: PdfTemplateFieldLayout
  templateFieldType?: PdfTemplateFieldType
  valueOrigin?: 'employee-prefill'
}

export type PdfPreflightIssueCode =
  | 'ambiguous-template-field'
  | 'body-mask-risk'
  | 'conflicting-template-field'
  | 'field-collision'
  | 'invalid-annotation-geometry'
  | 'invalid-annotation-page'
  | 'invalid-field-type'
  | 'invalid-signature'

export interface PdfPreflightIssue {
  annotationIds: string[]
  code: PdfPreflightIssueCode
  fieldLabel?: string
  message: string
}

export interface PdfPreflightResult {
  issues: PdfPreflightIssue[]
  ok: boolean
}

export interface PdfPreflightOptions {
  pageCount: number
}

export class PdfPreflightError extends Error {
  readonly issues: PdfPreflightIssue[]

  constructor(issues: PdfPreflightIssue[]) {
    const shown = issues.slice(0, 6).map((issue) => `- ${issue.message}`)
    const remaining = issues.length - shown.length
    super([
      'This document cannot be completed safely. Correct these fields and preview it again:',
      ...shown,
      ...(remaining > 0 ? [`- ${remaining} more document issue${remaining === 1 ? '' : 's'} must be corrected.`] : []),
    ].join('\n'))
    this.name = 'PdfPreflightError'
    this.issues = issues
  }
}

export const DEFAULT_TEXT_WIDTH_RATIO = .44
export const DEFAULT_TEXT_FONT_SIZE = 12
export const DEFAULT_SIGNATURE_WIDTH_RATIO = .31

const boundedRatio = (value: number) => Math.min(.98, Math.max(.02, value))
const boundedTextWidth = (value: number) => Math.min(.88, Math.max(.16, value))
const boundedSignatureWidth = (value: number) => Math.min(.7, Math.max(.12, value))
const MIN_TEMPLATE_FONT_SIZE = 6
const TEMPLATE_BOX_PADDING = 1
const GEOMETRY_EPSILON = .0005
const COLLISION_EPSILON = .000_004

interface NormalizedRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

function annotationName(annotation: PdfAnnotation): string {
  return annotation.fieldLabel?.trim() || annotation.templateFieldKey?.trim() || annotation.id
}

function finiteRatio(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizedRect(left: number, top: number, width: number, height: number): NormalizedRect {
  return { bottom: top + height, height, left, right: left + width, top, width }
}

function outputRect(annotation: PdfAnnotation): NormalizedRect | null {
  const width = annotation.widthRatio
    ?? (annotation.kind === 'signature' ? DEFAULT_SIGNATURE_WIDTH_RATIO : annotation.kind === 'text' ? DEFAULT_TEXT_WIDTH_RATIO : .025)
  const height = annotation.boxHeightRatio ?? (annotation.kind === 'signature' ? .045 : annotation.kind === 'text' || annotation.kind === 'date' ? .03 : .025)
  if (!finiteRatio(width) || !finiteRatio(height)) return null
  const centered = annotation.kind === 'signature' || annotation.kind === 'checkmark'
  return normalizedRect(
    centered ? annotation.xRatio - width / 2 : annotation.xRatio,
    centered ? annotation.yRatio - height / 2 : annotation.yRatio,
    width,
    height,
  )
}

function maskRect(annotation: PdfAnnotation): NormalizedRect | null {
  if (!finiteRatio(annotation.eraseWidthRatio) || !finiteRatio(annotation.eraseHeightRatio) || annotation.eraseWidthRatio <= 0 || annotation.eraseHeightRatio <= 0) return null
  const fallback = outputRect(annotation)
  const left = annotation.eraseXRatio ?? fallback?.left
  const top = annotation.eraseYRatio ?? fallback?.top
  if (!finiteRatio(left) || !finiteRatio(top)) return null
  return normalizedRect(left, top, annotation.eraseWidthRatio, annotation.eraseHeightRatio)
}

function rectInsidePage(rect: NormalizedRect): boolean {
  return rect.left >= -GEOMETRY_EPSILON
    && rect.top >= -GEOMETRY_EPSILON
    && rect.right <= 1 + GEOMETRY_EPSILON
    && rect.bottom <= 1 + GEOMETRY_EPSILON
    && rect.width > 0
    && rect.height > 0
}

function outputContainsExactSourceMask(output: NormalizedRect, mask: NormalizedRect): boolean {
  const exactGlyphTolerance = .004
  return mask.left >= output.left - GEOMETRY_EPSILON
    && mask.right <= output.right + GEOMETRY_EPSILON
    && mask.top >= output.top - exactGlyphTolerance
    && mask.bottom <= output.bottom + exactGlyphTolerance
}

function inlineSourceLineRect(line: PdfInlineSourceLine): NormalizedRect | null {
  if (![line.xRatio, line.topRatio, line.widthRatio, line.heightRatio, line.baselineRatio].every(finiteRatio)) return null
  return normalizedRect(line.xRatio, line.topRatio, line.widthRatio, line.heightRatio)
}

function sameInlineSourceLine(left: PdfInlineSourceLine, right: PdfInlineSourceLine): boolean {
  return left.id === right.id
    && left.text === right.text
    && Math.abs(left.xRatio - right.xRatio) <= GEOMETRY_EPSILON
    && Math.abs(left.topRatio - right.topRatio) <= GEOMETRY_EPSILON
    && Math.abs(left.widthRatio - right.widthRatio) <= GEOMETRY_EPSILON
    && Math.abs(left.heightRatio - right.heightRatio) <= GEOMETRY_EPSILON
    && Math.abs(left.baselineRatio - right.baselineRatio) <= GEOMETRY_EPSILON
}

function intersectionArea(left: NormalizedRect, right: NormalizedRect): number {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left)
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
  return width > GEOMETRY_EPSILON && height > GEOMETRY_EPSILON ? width * height : 0
}

function inferredTemplateFieldType(annotation: PdfAnnotation): PdfTemplateFieldType | null {
  if (annotation.templateFieldType) return annotation.templateFieldType
  if (annotation.nativeFieldType === 'checkbox') return 'checkbox'
  if (annotation.nativeFieldType === 'choice') return 'choice'
  const label = annotation.fieldLabel?.trim() ?? ''
  if (/^enter\s*\/\s*sign$/i.test(label)) return null
  if (/\b(?:date|dated|date\s*\/\s*time)\b|mm\s*\/\s*dd\s*\/\s*yyyy/i.test(label)) return 'date'
  if (/\b(?:initials?|signature|signed by|signer)\b/i.test(label)) return 'signature'
  if (annotation.fitMode === 'bounded') return 'long_text'
  if (annotation.nativeFieldType === 'text') return 'text'
  return null
}

function looksLikeUsDate(value: string): boolean {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(?:\d{1,2}:\d{2}\s*)?(?:AM|PM)?)?$/i.exec(value.trim())
  if (!match) return false
  const month = Number(match[1])
  const day = Number(match[2])
  const year = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return false
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function addIssue(
  issues: PdfPreflightIssue[],
  code: PdfPreflightIssueCode,
  annotation: PdfAnnotation,
  message: string,
  annotationIds: string[] = [annotation.id],
) {
  issues.push({ annotationIds, code, fieldLabel: annotation.fieldLabel, message })
}

export function validatePdfAnnotations(
  annotations: PdfAnnotation[],
  { pageCount }: PdfPreflightOptions,
): PdfPreflightResult {
  const issues: PdfPreflightIssue[] = []
  const controlled = annotations.filter((annotation) => Boolean(annotation.templateFieldKey))
  const templateFields = new Map<string, PdfAnnotation[]>()
  const inlineSourceLines = new Map<string, PdfAnnotation[]>()

  for (const annotation of annotations) {
    const name = annotationName(annotation)
    if (!Number.isInteger(annotation.page) || annotation.page < 1 || annotation.page > pageCount) {
      addIssue(issues, 'invalid-annotation-page', annotation, `“${name}” points to page ${annotation.page}, but this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.`)
    }
    if (!finiteRatio(annotation.xRatio) || !finiteRatio(annotation.yRatio)) {
      addIssue(issues, 'invalid-annotation-geometry', annotation, `“${name}” has an invalid document position.`)
      continue
    }
    const rendered = outputRect(annotation)
    if (!rendered || !rectInsidePage(rendered)) {
      addIssue(issues, 'invalid-annotation-geometry', annotation, `“${name}” extends outside its page. Reposition or resize this field.`)
    }
    const hasAnyMaskGeometry = (annotation.eraseWidthRatio ?? 0) > 0
      || (annotation.eraseHeightRatio ?? 0) > 0
      || annotation.eraseXRatio !== undefined
      || annotation.eraseYRatio !== undefined
    const mask = maskRect(annotation)
    if (hasAnyMaskGeometry && !mask) {
      addIssue(issues, 'invalid-annotation-geometry', annotation, `“${name}” has an incomplete source-placeholder boundary.`)
    } else if (mask && !rectInsidePage(mask)) {
      addIssue(issues, 'invalid-annotation-geometry', annotation, `The source-placeholder boundary for “${name}” extends outside its page.`)
    }

    if (!annotation.templateFieldKey) continue
    const matching = templateFields.get(annotation.templateFieldKey) ?? []
    matching.push(annotation)
    templateFields.set(annotation.templateFieldKey, matching)

    const expectedType = inferredTemplateFieldType(annotation)
    if (!expectedType && /^enter\s*\/\s*sign$/i.test(annotation.fieldLabel?.trim() ?? '')) {
      addIssue(
        issues,
        'ambiguous-template-field',
        annotation,
        `“${name}” is ambiguous. Identify it as Printed name, Signature, or Date/time before completing the document.`,
      )
    }
    if (expectedType === 'signature') {
      if (annotation.kind !== 'signature' || !annotation.signaturePng?.byteLength) {
        addIssue(issues, 'invalid-signature', annotation, `“${name}” is a signature field, but it does not contain a valid placed signature.`)
      }
    } else if (annotation.kind === 'signature') {
      addIssue(issues, 'invalid-field-type', annotation, `“${name}” is not a signature field. Use the field’s ${expectedType === 'date' ? 'date/time' : 'text'} control instead.`)
    }
    if (expectedType === 'date' && (annotation.kind === 'signature' || !looksLikeUsDate(annotation.text))) {
      addIssue(issues, 'invalid-field-type', annotation, `“${name}” must contain a valid MM/DD/YYYY date, not a signature or unrelated text.`)
    }
    if (expectedType === 'checkbox' && annotation.kind !== 'checkmark') {
      addIssue(issues, 'invalid-field-type', annotation, `“${name}” is a checkbox and must use the checkbox control.`)
    }
    if ((expectedType === 'choice' || expectedType === 'long_text' || expectedType === 'text') && annotation.kind !== 'text') {
      addIssue(issues, 'invalid-field-type', annotation, `“${name}” must use a text${expectedType === 'choice' ? ' or choice' : ''} control.`)
    }
    if ((expectedType === 'date' || expectedType === 'text') && annotation.fitMode !== 'single-line' && annotation.fitMode !== 'bounded') {
      addIssue(issues, 'body-mask-risk', annotation, `“${name}” is not bounded to its document field. Select a verified field before completing the PDF.`)
    }
    if (expectedType === 'long_text' && annotation.fitMode !== 'bounded') {
      addIssue(issues, 'body-mask-risk', annotation, `“${name}” must use a bounded paragraph field so its text cannot cover the rest of the document.`)
    }

    if (!annotation.nativeFieldName && expectedType !== 'checkbox' && !mask) {
      addIssue(issues, 'body-mask-risk', annotation, `“${name}” has no exact source-placeholder boundary. It cannot be safely written over this PDF.`)
    }
    if (!annotation.nativeFieldName && mask) {
      if (!annotation.templateFieldLayout) {
        addIssue(issues, 'body-mask-risk', annotation, `“${name}” is missing a verified field boundary. Its source text cannot be safely erased.`)
      }
      if (rendered && !outputContainsExactSourceMask(rendered, mask)) {
        addIssue(issues, 'body-mask-risk', annotation, `The erase area for “${name}” reaches outside its verified field box and could cover document text.`)
      }
      if (annotation.templateFieldLayout === 'inline-body') {
        const permittedInlineType = expectedType === 'date' || expectedType === 'text'
        if (!permittedInlineType || annotation.fitMode !== 'single-line' || mask.width > .45 || mask.height > .055) {
          addIssue(issues, 'body-mask-risk', annotation, `“${name}” cannot be safely inserted into the body paragraph. Review its type and exact inline boundary.`)
        }
      }
    }


    const hasInlineSourceMetadata = Boolean(annotation.sourceLine || annotation.sourceSpan)
    if (hasInlineSourceMetadata) {
      if (annotation.templateFieldLayout !== 'inline-body' || !annotation.sourceLine || !annotation.sourceSpan) {
        addIssue(issues, 'body-mask-risk', annotation, `“${name}” has incomplete source-line information and cannot safely reflow the surrounding sentence.`)
      } else {
        const line = annotation.sourceLine
        const span = annotation.sourceSpan
        const lineRect = inlineSourceLineRect(line)
        const validSpan = Number.isInteger(span.start)
          && Number.isInteger(span.length)
          && span.start >= 0
          && span.length > 0
          && span.start + span.length <= line.text.length
        if (!line.id.trim() || !line.text.trim() || !lineRect || !rectInsidePage(lineRect)
          || line.baselineRatio < line.topRatio - GEOMETRY_EPSILON
          || line.baselineRatio > line.topRatio + line.heightRatio + GEOMETRY_EPSILON) {
          addIssue(issues, 'body-mask-risk', annotation, `The source sentence for “${name}” has an invalid document boundary.`)
        }
        if (!validSpan || !/^\[[^\]\r\n]{2,160}\]$/.test(validSpan ? line.text.slice(span.start, span.start + span.length) : '')) {
          addIssue(issues, 'body-mask-risk', annotation, `The placeholder for “${name}” cannot be located safely inside its source sentence.`)
        }
        const lineKey = `${annotation.page}:${line.id}`
        const matching = inlineSourceLines.get(lineKey) ?? []
        matching.push(annotation)
        inlineSourceLines.set(lineKey, matching)
      }
    }
  }

  for (const matching of inlineSourceLines.values()) {
    const first = matching[0]
    const firstLine = first.sourceLine!
    const inconsistent = matching.find((annotation) => !annotation.sourceLine || !sameInlineSourceLine(firstLine, annotation.sourceLine))
    if (inconsistent) {
      addIssue(
        issues,
        'body-mask-risk',
        first,
        `The fields in “${firstLine.text}” do not agree on the source sentence boundary. Review their mappings before completing the PDF.`,
        matching.map((annotation) => annotation.id),
      )
      continue
    }
    const ordered = [...matching].sort((left, right) => left.sourceSpan!.start - right.sourceSpan!.start)
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1].sourceSpan!
      const current = ordered[index].sourceSpan!
      if (current.start >= previous.start + previous.length) continue
      addIssue(
        issues,
        'body-mask-risk',
        ordered[index],
        `Two values target the same part of “${firstLine.text}.” Review their mappings before completing the PDF.`,
        [ordered[index - 1].id, ordered[index].id],
      )
    }
  }

  for (const [key, matching] of templateFields) {
    if (matching.length < 2) continue
    const label = annotationName(matching[0])
    addIssue(
      issues,
      'conflicting-template-field',
      matching[0],
      `“${label}” has ${matching.length} competing values for the same document field (${key}). Keep only one value.`,
      matching.map((annotation) => annotation.id),
    )
  }

  for (let index = 0; index < controlled.length; index += 1) {
    const left = controlled[index]
    const leftRect = outputRect(left)
    if (!leftRect) continue
    for (let otherIndex = index + 1; otherIndex < controlled.length; otherIndex += 1) {
      const right = controlled[otherIndex]
      if (left.page !== right.page || left.templateFieldKey === right.templateFieldKey) continue
      const rightRect = outputRect(right)
      if (!rightRect) continue
      const area = intersectionArea(leftRect, rightRect)
      const smallerArea = Math.min(leftRect.width * leftRect.height, rightRect.width * rightRect.height)
      if (area <= COLLISION_EPSILON || area / Math.max(smallerArea, COLLISION_EPSILON) <= .02) continue
      addIssue(
        issues,
        'field-collision',
        left,
        `“${annotationName(left)}” overlaps “${annotationName(right)}” on page ${left.page}. Correct the field mapping before completing the PDF.`,
        [left.id, right.id],
      )
    }
  }

  return { issues, ok: issues.length === 0 }
}

function printableText(value: string): string {
  return value
    .replaceAll('“', '"')
    .replaceAll('”', '"')
    .replaceAll('‘', "'")
    .replaceAll('’', "'")
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
}

export function movePdfAnnotation(annotation: PdfAnnotation, xRatio: number, yRatio: number): PdfAnnotation {
  if (annotation.templateFieldKey) {
    return {
      ...annotation,
      xRatio,
      yRatio,
    }
  }
  const width = annotation.kind === 'text'
    ? boundedTextWidth(annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO)
    : annotation.kind === 'signature'
      ? boundedSignatureWidth(annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO)
      : 0
  const centered = annotation.kind === 'signature'
  return {
    ...annotation,
    xRatio: centered
      ? Math.min(1 - width / 2, Math.max(width / 2, xRatio))
      : Math.min(annotation.kind === 'text' ? .98 - width : .98, Math.max(.02, xRatio)),
    yRatio: boundedRatio(yRatio),
  }
}

export function resizePdfAnnotation(annotation: PdfAnnotation, widthRatio: number): PdfAnnotation {
  if (annotation.kind === 'signature') {
    const bounded = boundedSignatureWidth(widthRatio)
    return movePdfAnnotation({ ...annotation, widthRatio: bounded }, annotation.xRatio, annotation.yRatio)
  }
  return resizePdfTextAnnotation(annotation, widthRatio)
}

export function resizePdfTextAnnotation(annotation: PdfAnnotation, widthRatio: number): PdfAnnotation {
  if (annotation.kind !== 'text') return annotation
  return {
    ...annotation,
    widthRatio: Math.min(.98 - annotation.xRatio, boundedTextWidth(widthRatio)),
  }
}

export function wrapPdfText(value: string, maximumWidth: number, measure: (value: string) => number): string[] {
  const paragraphs = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map(printableText)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    const words = paragraph.split(/\s+/).filter(Boolean)
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(candidate) <= maximumWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      if (measure(word) <= maximumWidth) {
        line = word
        continue
      }
      let fragment = ''
      for (const character of word) {
        const candidateFragment = fragment + character
        if (fragment && measure(candidateFragment) > maximumWidth) {
          lines.push(fragment)
          fragment = character
        } else {
          fragment = candidateFragment
        }
      }
      line = fragment
    }
    if (line) lines.push(line)
  }
  return lines.length ? lines : ['']
}

interface BoundedTextLayout {
  fontSize: number
  lineHeight: number
  lines: string[]
}

export function fitPdfText(
  value: string,
  maximumWidth: number,
  maximumHeight: number,
  preferredFontSize: number,
  measure: (value: string, size: number) => number,
  singleLine = false,
): BoundedTextLayout | null {
  const printable = printableText(value)
  for (let size = preferredFontSize; size >= MIN_TEMPLATE_FONT_SIZE; size -= .5) {
    const lineHeight = size * 1.18
    const lines = singleLine
      ? [printable.replace(/\s+/g, ' ').trim()]
      : wrapPdfText(printable, maximumWidth, (line) => measure(line, size))
    if (lines.length * lineHeight <= maximumHeight && lines.every((line) => measure(line, size) <= maximumWidth + .01)) {
      return { fontSize: size, lineHeight, lines }
    }
  }
  return null
}

function drawAnnotationMask(
  page: ReturnType<PDFDocument['getPage']>,
  annotation: PdfAnnotation,
  pageWidth: number,
  pageHeight: number,
  fallbackXRatio: number,
  fallbackYRatio: number,
) {
  if (!annotation.eraseWidthRatio || !annotation.eraseHeightRatio) return
  const left = pageWidth * (annotation.eraseXRatio ?? fallbackXRatio)
  const topRatio = annotation.eraseYRatio ?? fallbackYRatio
  const maskWidth = pageWidth * annotation.eraseWidthRatio
  const maskHeight = pageHeight * annotation.eraseHeightRatio
  page.drawRectangle({
    color: rgb(1, 1, 1),
    height: maskHeight,
    width: maskWidth,
    x: left,
    y: pageHeight - pageHeight * topRatio - maskHeight,
  })
}

function recomposeInlineSourceLine(annotations: PdfAnnotation[]): string {
  const source = annotations[0].sourceLine!.text
  return [...annotations]
    .sort((left, right) => right.sourceSpan!.start - left.sourceSpan!.start)
    .reduce((line, annotation) => {
      const span = annotation.sourceSpan!
      return `${line.slice(0, span.start)}${printableText(annotation.text)}${line.slice(span.start + span.length)}`
    }, source)
}

function drawReflowedInlineSourceLine(
  page: ReturnType<PDFDocument['getPage']>,
  annotations: PdfAnnotation[],
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
) {
  const sourceLine = annotations[0].sourceLine!
  const { height, width } = page.getSize()
  const line = recomposeInlineSourceLine(annotations)
  const preferredSize = Math.max(MIN_TEMPLATE_FONT_SIZE, Math.min(...annotations.map((annotation) => annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE)))
  const lineWidth = Math.max(1, sourceLine.widthRatio * width)
  const layout = fitPdfText(
    line,
    Math.max(1, lineWidth - TEMPLATE_BOX_PADDING * 2),
    preferredSize * 1.2,
    preferredSize,
    (value, size) => font.widthOfTextAtSize(value, size),
    true,
  )
  if (!layout) {
    const labels = annotations.map(annotationName).join(', ')
    throw new Error(`The completed sentence containing ${labels} does not fit on its original document line. Shorten those values and preview the PDF again.`)
  }

  const horizontalMaskPadding = 1
  const verticalMaskPadding = .08
  const maskX = Math.max(0, sourceLine.xRatio * width - horizontalMaskPadding)
  const maskTop = Math.max(0, sourceLine.topRatio * height - verticalMaskPadding)
  const maskRight = Math.min(width, (sourceLine.xRatio + sourceLine.widthRatio) * width + horizontalMaskPadding)
  const maskBottom = Math.min(height, (sourceLine.topRatio + sourceLine.heightRatio) * height + verticalMaskPadding)
  page.drawRectangle({
    color: rgb(1, 1, 1),
    height: Math.max(1, maskBottom - maskTop),
    width: Math.max(1, maskRight - maskX),
    x: maskX,
    y: height - maskBottom,
  })
  page.drawText(line, {
    color: rgb(.075, .075, .075),
    font,
    maxWidth: Math.max(1, lineWidth - TEMPLATE_BOX_PADDING * 2),
    size: layout.fontSize,
    x: sourceLine.xRatio * width,
    y: height - sourceLine.baselineRatio * height,
  })
}

export async function preflightPdfAnnotations(source: Uint8Array, annotations: PdfAnnotation[]): Promise<PdfPreflightResult> {
  const pdf = await PDFDocument.load(source, { ignoreEncryption: false })
  return validatePdfAnnotations(annotations, { pageCount: pdf.getPageCount() })
}

export async function createTypedSignaturePng(
  name: string,
  family: 'Alex Brush' | 'Allura' | 'Dancing Script' | 'Great Vibes',
): Promise<Uint8Array> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Type the signer name first.')
  if (typeof document === 'undefined') throw new Error('Signature creation requires a browser.')
  const fontWeight = family === 'Dancing Script' ? 600 : 400
  await document.fonts?.load(`${fontWeight} 96px "${family}"`).catch(() => undefined)
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The signature canvas is unavailable.')
  context.font = `${fontWeight} 180px "${family}", cursive`
  const metrics = context.measureText(trimmed)
  const left = Math.max(0, metrics.actualBoundingBoxLeft || 0)
  const right = Math.max(1, metrics.actualBoundingBoxRight || metrics.width || 1)
  const ascent = Math.max(1, metrics.actualBoundingBoxAscent || 150)
  const descent = Math.max(1, metrics.actualBoundingBoxDescent || 45)
  const contentWidth = left + right
  const contentHeight = ascent + descent
  const horizontalPadding = 54
  const verticalPadding = 28
  const scale = Math.min(1, 1_280 / contentWidth, 250 / contentHeight)
  canvas.width = Math.max(1, Math.ceil(contentWidth * scale + horizontalPadding * 2))
  canvas.height = Math.max(1, Math.ceil(contentHeight * scale + verticalPadding * 2))
  const drawingContext = canvas.getContext('2d')
  if (!drawingContext) throw new Error('The signature canvas is unavailable.')
  drawingContext.clearRect(0, 0, canvas.width, canvas.height)
  drawingContext.fillStyle = '#17130d'
  drawingContext.font = `${fontWeight} 180px "${family}", cursive`
  drawingContext.textBaseline = 'alphabetic'
  drawingContext.save()
  drawingContext.translate(horizontalPadding + left * scale, verticalPadding + ascent * scale)
  drawingContext.scale(scale, scale)
  drawingContext.fillText(trimmed, 0, 0)
  drawingContext.restore()
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('The signature image could not be created.')), 'image/png'))
  return new Uint8Array(await blob.arrayBuffer())
}

export async function finalizePdf(source: Uint8Array, annotations: PdfAnnotation[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(source, { ignoreEncryption: false })
  const preflight = validatePdfAnnotations(annotations, { pageCount: pdf.getPageCount() })
  if (!preflight.ok) throw new PdfPreflightError(preflight.issues)
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  const nativeAnnotations = annotations.filter((annotation) => annotation.nativeFieldName)
  // pdf.getForm() creates an empty AcroForm when the source did not have one.
  // Only open the form API when native widgets actually exist so ordinary PDFs
  // remain ordinary PDFs after completion.
  if (nativeAnnotations.length || pdf.catalog.getAcroForm()) {
    const form = pdf.getForm()
    if (form.hasXFA()) form.deleteXFA()
    for (const annotation of nativeAnnotations) {
      const field = form.getFieldMaybe(annotation.nativeFieldName!)
      if (!field) throw new Error(`The PDF field "${annotation.nativeFieldName}" is no longer available.`)
      const value = printableText(annotation.text)
      if (field instanceof PDFTextField) {
        if (annotation.fitMode === 'single-line' || annotation.fitMode === 'bounded') {
          const page = pdf.getPage(annotation.page - 1)
          const { height, width } = page.getSize()
          const boxWidth = Math.max(1, width * (annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO) - TEMPLATE_BOX_PADDING * 2)
          const boxHeight = Math.max(1, height * (annotation.boxHeightRatio ?? .03) - TEMPLATE_BOX_PADDING * 2)
          const layout = fitPdfText(
            value,
            boxWidth,
            boxHeight,
            annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE,
            (line, fontSize) => font.widthOfTextAtSize(line, fontSize),
            annotation.fitMode === 'single-line',
          )
          if (!layout) {
            const label = annotation.fieldLabel ? ` in “${annotation.fieldLabel}”` : ''
            throw new Error(`The text${label} does not fit in its document box. Shorten it and preview the PDF again.`)
          }
          field.setFontSize(layout.fontSize)
        }
        field.setText(value)
      } else if (field instanceof PDFCheckBox) {
        if (value === 'true') field.check()
        else field.uncheck()
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        if (value) field.select(value)
        else field.clear()
      } else {
        throw new Error(`The PDF field "${annotation.nativeFieldName}" cannot be completed in this editor.`)
      }
    }
    if (form.getFields().length) {
      form.updateFieldAppearances(font)
      form.flatten({ updateFieldAppearances: false })
    }
  }

  const completedInlineAnnotations = new Set<string>()
  const inlineSourceLines = new Map<string, PdfAnnotation[]>()
  for (const annotation of annotations) {
    if (annotation.nativeFieldName
      || annotation.templateFieldLayout !== 'inline-body'
      || !annotation.sourceLine
      || !annotation.sourceSpan) continue
    const key = `${annotation.page}:${annotation.sourceLine.id}`
    const matching = inlineSourceLines.get(key) ?? []
    matching.push(annotation)
    inlineSourceLines.set(key, matching)
  }
  for (const matching of inlineSourceLines.values()) {
    const page = pdf.getPage(matching[0].page - 1)
    if (!page) continue
    drawReflowedInlineSourceLine(page, matching, font)
    matching.forEach((annotation) => completedInlineAnnotations.add(annotation.id))
  }

  for (const annotation of annotations) {
    if (annotation.nativeFieldName || completedInlineAnnotations.has(annotation.id)) continue
    const page = pdf.getPage(annotation.page - 1)
    if (!page) continue
    const { height, width } = page.getSize()
    const positioned = movePdfAnnotation(annotation, annotation.xRatio, annotation.yRatio)
    const x = positioned.xRatio * width
    const y = height - positioned.yRatio * height

    if (annotation.kind === 'signature' && annotation.signaturePng) {
      const image = await pdf.embedPng(annotation.signaturePng)
      const exactTarget = annotation.templateFieldKey ? outputRect(annotation) : null
      const maximumImageWidth = exactTarget
        ? Math.max(1, exactTarget.width * width - TEMPLATE_BOX_PADDING * 2)
        : width * boundedSignatureWidth(annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO)
      const maximumImageHeight = exactTarget
        ? Math.max(1, exactTarget.height * height - TEMPLATE_BOX_PADDING * 2)
        : annotation.boxHeightRatio
          ? Math.max(8, height * annotation.boxHeightRatio - TEMPLATE_BOX_PADDING * 2)
          : height - 16
      const imageScale = Math.min(maximumImageWidth / image.width, maximumImageHeight / image.height)
      const imageWidth = image.width * imageScale
      const imageHeight = image.height * imageScale
      drawAnnotationMask(page, annotation, width, height, positioned.xRatio, positioned.yRatio)
      const targetX = exactTarget ? exactTarget.left * width : Math.max(8, Math.min(width - imageWidth - 8, x - imageWidth / 2))
      const targetY = exactTarget ? height - exactTarget.bottom * height : Math.max(8, Math.min(height - imageHeight - 8, y - imageHeight / 2))
      const centeredX = exactTarget ? targetX + (exactTarget.width * width - imageWidth) / 2 : targetX
      const centeredY = exactTarget ? targetY + (exactTarget.height * height - imageHeight) / 2 : targetY
      page.drawImage(image, {
        height: imageHeight,
        width: imageWidth,
        x: centeredX,
        y: centeredY,
      })
      continue
    }

    const size = annotation.kind === 'date' ? 11 : annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE
    if (annotation.kind === 'text' || (annotation.kind === 'date' && annotation.templateFieldKey)) {
      const requestedWidth = width * (annotation.templateFieldKey
        ? annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO
        : boundedTextWidth(annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO))
      const availableWidth = Math.max(1, width - x - (annotation.templateFieldKey ? 0 : 8))
      const boxWidth = annotation.templateFieldKey
        ? Math.min(availableWidth, requestedWidth)
        : Math.max(42, Math.min(availableWidth, requestedWidth))
      drawAnnotationMask(page, annotation, width, height, positioned.xRatio, positioned.yRatio)
      if (annotation.fitMode === 'single-line' || annotation.fitMode === 'bounded') {
        const boxHeight = annotation.templateFieldKey
          ? height * (annotation.boxHeightRatio ?? annotation.eraseHeightRatio ?? .03)
          : Math.max(size * 1.25, height * (annotation.boxHeightRatio ?? annotation.eraseHeightRatio ?? .03))
        const layout = fitPdfText(
          annotation.text,
          Math.max(1, boxWidth - TEMPLATE_BOX_PADDING * 2),
          Math.max(1, boxHeight - TEMPLATE_BOX_PADDING * 2),
          size,
          (line, fontSize) => font.widthOfTextAtSize(line, fontSize),
          annotation.fitMode === 'single-line',
        )
        if (!layout) {
          const label = annotation.fieldLabel ? ` in “${annotation.fieldLabel}”` : ''
          throw new Error(`The text${label} does not fit in its document box. Shorten it and preview the PDF again.`)
        }
        layout.lines.forEach((line, index) => {
          const baseline = y - TEMPLATE_BOX_PADDING - layout.fontSize - index * layout.lineHeight
          page.drawText(line, {
            color: rgb(.075, .075, .075),
            font,
            maxWidth: boxWidth - TEMPLATE_BOX_PADDING * 2,
            size: layout.fontSize,
            x: x + TEMPLATE_BOX_PADDING,
            y: baseline,
          })
        })
        continue
      }
      const lineHeight = size * 1.28
      const lines = wrapPdfText(annotation.text, boxWidth, (line) => font.widthOfTextAtSize(line, size))
      lines.forEach((line, index) => {
        const baseline = y - size - index * lineHeight
        if (baseline < 8) return
        page.drawText(line, {
          color: rgb(.075, .075, .075),
          font,
          maxWidth: boxWidth,
          size,
          x,
          y: baseline,
        })
      })
      continue
    }

    if (annotation.kind === 'checkmark') {
      const markWidth = 12
      const markHeight = 10
      const thickness = 2.1
      page.drawLine({
        color: rgb(.045, .045, .045),
        end: { x: x - markWidth * .08, y: y - markHeight * .42 },
        start: { x: x - markWidth * .46, y: y - markHeight * .02 },
        thickness,
      })
      page.drawLine({
        color: rgb(.045, .045, .045),
        end: { x: x + markWidth * .54, y: y + markHeight * .46 },
        start: { x: x - markWidth * .08, y: y - markHeight * .42 },
        thickness,
      })
      continue
    }

    page.drawText(printableText(annotation.text), {
      color: rgb(.075, .075, .075),
      font,
      maxWidth: Math.max(80, width - x - 12),
      size,
      x: Math.max(8, x),
      y: Math.max(8, y - size / 2),
    })
  }

  return pdf.save({ addDefaultPage: false, useObjectStreams: true })
}

export function completedPdfFilename(title: string): string {
  const safe = title.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 140) || 'Completed document'
  return `${safe.replace(/\.pdf$/i, '')}.pdf`
}

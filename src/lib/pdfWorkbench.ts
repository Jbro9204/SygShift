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
  text: string
  widthRatio?: number
  xRatio: number
  yRatio: number
  signaturePng?: Uint8Array
  templateFieldKey?: string
}

export const DEFAULT_TEXT_WIDTH_RATIO = .44
export const DEFAULT_TEXT_FONT_SIZE = 12
export const DEFAULT_SIGNATURE_WIDTH_RATIO = .31

const boundedRatio = (value: number) => Math.min(.98, Math.max(.02, value))
const boundedTextWidth = (value: number) => Math.min(.88, Math.max(.16, value))
const boundedSignatureWidth = (value: number) => Math.min(.7, Math.max(.12, value))
const MIN_TEMPLATE_FONT_SIZE = 6
const TEMPLATE_BOX_PADDING = 2

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
  const top = pageHeight - pageHeight * (annotation.eraseYRatio ?? fallbackYRatio)
  const maskWidth = Math.min(pageWidth - Math.max(0, left - TEMPLATE_BOX_PADDING), pageWidth * annotation.eraseWidthRatio + TEMPLATE_BOX_PADDING * 2)
  const maskHeight = Math.min(pageHeight, pageHeight * annotation.eraseHeightRatio + TEMPLATE_BOX_PADDING * 2)
  page.drawRectangle({
    color: rgb(1, 1, 1),
    height: maskHeight,
    width: maskWidth,
    x: Math.max(0, left - TEMPLATE_BOX_PADDING),
    y: Math.max(0, top - maskHeight + TEMPLATE_BOX_PADDING),
  })
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
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  const nativeAnnotations = annotations.filter((annotation) => annotation.nativeFieldName)
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

  for (const annotation of annotations) {
    if (annotation.nativeFieldName) continue
    const page = pdf.getPage(annotation.page - 1)
    if (!page) continue
    const { height, width } = page.getSize()
    const positioned = movePdfAnnotation(annotation, annotation.xRatio, annotation.yRatio)
    const x = positioned.xRatio * width
    const y = height - positioned.yRatio * height

    if (annotation.kind === 'signature' && annotation.signaturePng) {
      const image = await pdf.embedPng(annotation.signaturePng)
      const maximumImageWidth = width * boundedSignatureWidth(annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO)
      const maximumImageHeight = annotation.boxHeightRatio
        ? Math.max(8, height * annotation.boxHeightRatio - TEMPLATE_BOX_PADDING * 2)
        : height - 16
      const imageScale = Math.min(maximumImageWidth / image.width, maximumImageHeight / image.height)
      const imageWidth = image.width * imageScale
      const imageHeight = image.height * imageScale
      drawAnnotationMask(page, annotation, width, height, positioned.xRatio, positioned.yRatio)
      page.drawImage(image, {
        height: imageHeight,
        width: imageWidth,
        x: Math.max(8, Math.min(width - imageWidth - 8, x - imageWidth / 2)),
        y: Math.max(8, Math.min(height - imageHeight - 8, y - imageHeight / 2)),
      })
      continue
    }

    const size = annotation.kind === 'date' ? 11 : annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE
    if (annotation.kind === 'text') {
      const boxWidth = Math.max(42, Math.min(width - x - 8, width * boundedTextWidth(annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO)))
      drawAnnotationMask(page, annotation, width, height, positioned.xRatio, positioned.yRatio)
      if (annotation.fitMode === 'single-line' || annotation.fitMode === 'bounded') {
        const boxHeight = Math.max(size * 1.25, height * (annotation.boxHeightRatio ?? annotation.eraseHeightRatio ?? .03))
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

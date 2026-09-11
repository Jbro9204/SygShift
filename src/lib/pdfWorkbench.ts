import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export type PdfAnnotationKind = 'checkmark' | 'date' | 'signature' | 'text'

export interface PdfAnnotation {
  eraseHeightRatio?: number
  eraseWidthRatio?: number
  fontSize?: number
  fontFamily?: string
  id: string
  kind: PdfAnnotationKind
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
  const checkFont = await pdf.embedFont(StandardFonts.ZapfDingbats)

  for (const annotation of annotations) {
    const page = pdf.getPage(annotation.page - 1)
    if (!page) continue
    const { height, width } = page.getSize()
    const positioned = movePdfAnnotation(annotation, annotation.xRatio, annotation.yRatio)
    const x = positioned.xRatio * width
    const y = height - positioned.yRatio * height

    if (annotation.kind === 'signature' && annotation.signaturePng) {
      const image = await pdf.embedPng(annotation.signaturePng)
      const imageWidth = width * boundedSignatureWidth(annotation.widthRatio ?? DEFAULT_SIGNATURE_WIDTH_RATIO)
      const imageHeight = imageWidth * (image.height / image.width)
      page.drawImage(image, {
        height: imageHeight,
        width: imageWidth,
        x: Math.max(8, Math.min(width - imageWidth - 8, x - imageWidth / 2)),
        y: Math.max(8, Math.min(height - imageHeight - 8, y - imageHeight / 2)),
      })
      continue
    }

    const size = annotation.kind === 'checkmark' ? 18 : annotation.kind === 'date' ? 11 : annotation.fontSize ?? DEFAULT_TEXT_FONT_SIZE
    if (annotation.kind === 'text') {
      const boxWidth = Math.max(42, Math.min(width - x - 8, width * boundedTextWidth(annotation.widthRatio ?? DEFAULT_TEXT_WIDTH_RATIO)))
      const lineHeight = size * 1.28
      const lines = wrapPdfText(annotation.text, boxWidth, (line) => font.widthOfTextAtSize(line, size))
      if (annotation.eraseWidthRatio && annotation.eraseHeightRatio) {
        const eraseHeight = Math.max(size * 1.4, height * annotation.eraseHeightRatio)
        page.drawRectangle({
          color: rgb(1, 1, 1),
          height: eraseHeight,
          width: Math.max(boxWidth, width * annotation.eraseWidthRatio),
          x: Math.max(0, x - 2),
          y: Math.max(0, y - eraseHeight),
        })
      }
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

    page.drawText(annotation.kind === 'checkmark' ? '✓' : printableText(annotation.text), {
      color: rgb(.075, .075, .075),
      font: annotation.kind === 'checkmark' ? checkFont : font,
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

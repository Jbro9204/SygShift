import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

export type PdfAnnotationKind = 'checkmark' | 'date' | 'signature' | 'text'

export interface PdfAnnotation {
  fontFamily?: string
  id: string
  kind: PdfAnnotationKind
  page: number
  text: string
  xRatio: number
  yRatio: number
  signaturePng?: Uint8Array
}

const boundedRatio = (value: number) => Math.min(.98, Math.max(.02, value))

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
  canvas.width = 1_400
  canvas.height = 300
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The signature canvas is unavailable.')
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#17130d'
  context.font = `${fontWeight} 180px "${family}", cursive`
  context.textBaseline = 'middle'
  const measured = Math.max(1, context.measureText(trimmed).width)
  const scale = Math.min(1, 1_250 / measured)
  context.save()
  context.translate(70, canvas.height / 2)
  context.scale(scale, scale)
  context.fillText(trimmed, 0, 0)
  context.restore()
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
    const x = boundedRatio(annotation.xRatio) * width
    const y = height - boundedRatio(annotation.yRatio) * height

    if (annotation.kind === 'signature' && annotation.signaturePng) {
      const image = await pdf.embedPng(annotation.signaturePng)
      const imageWidth = Math.min(width * .34, 190)
      const imageHeight = imageWidth * (image.height / image.width)
      page.drawImage(image, {
        height: imageHeight,
        width: imageWidth,
        x: Math.max(8, Math.min(width - imageWidth - 8, x - imageWidth / 2)),
        y: Math.max(8, Math.min(height - imageHeight - 8, y - imageHeight / 2)),
      })
      continue
    }

    const size = annotation.kind === 'checkmark' ? 18 : annotation.kind === 'date' ? 11 : 12
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

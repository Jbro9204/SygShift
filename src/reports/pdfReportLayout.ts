import {
  degrees,
  drawText,
  PDFName,
  rgb,
  type Color,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib'

export const reportPdfColors = {
  gold: rgb(0.79, 0.56, 0.19),
  ink: rgb(0.08, 0.09, 0.10),
  muted: rgb(0.36, 0.35, 0.32),
  rule: rgb(0.82, 0.79, 0.72),
  soft: rgb(0.97, 0.96, 0.93),
  white: rgb(1, 1, 1),
} as const

export type ReportPdfPage = {
  bodyTop: number
  bottom: number
  height: number
  margin: number
  page: PDFPage
  width: number
}

type DrawReportPdfTextOptions = {
  color: Color
  font: PDFFont
  maximumWidth?: number
  size: number
  x: number
  y: number
}

const pageFontKeys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>()

function getPageFontKey(page: PDFPage, font: PDFFont): PDFName {
  let fonts = pageFontKeys.get(page)
  if (!fonts) {
    fonts = new Map<PDFFont, PDFName>()
    pageFontKeys.set(page, fonts)
  }
  let key = fonts.get(font)
  if (!key) {
    key = PDFName.of(`ReportFont${fonts.size + 1}`)
    page.node.setFontDictionary(key, font.ref)
    fonts.set(font, key)
  }
  return key
}

type AddReportPageOptions = {
  bold: PDFFont
  document: PDFDocument
  height: number
  kicker: string
  margin: number
  regular: PDFFont
  subtitle?: string
  title: string
  width: number
}

export function pdfSafeText(value: unknown): string {
  return String(value ?? '')
    .replaceAll(/[\u2010-\u2015]/g, '-')
    .replaceAll(/[\u2018\u2019]/g, "'")
    .replaceAll(/[\u201c\u201d]/g, '"')
    .replaceAll(/[^\u0020-\u007e\u00a0-\u00ff]/g, '?')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export function fitPdfText(value: unknown, font: PDFFont, size: number, maximumWidth: number): string {
  const text = pdfSafeText(value)
  if (!text || maximumWidth <= 0) return ''
  if (font.widthOfTextAtSize(text, size) <= maximumWidth) return text
  const suffix = '...'
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${text.slice(0, middle).trimEnd()}${suffix}`
    if (font.widthOfTextAtSize(candidate, size) <= maximumWidth) low = middle
    else high = middle - 1
  }
  return `${text.slice(0, low).trimEnd()}${suffix}`
}

export function drawReportPdfText(
  page: PDFPage,
  value: unknown,
  options: DrawReportPdfTextOptions,
): void {
  const { color, font, maximumWidth, size, x, y } = options
  const text = maximumWidth === undefined
    ? pdfSafeText(value)
    : fitPdfText(value, font, size, maximumWidth)
  if (!text) return
  page.pushOperators(...drawText(font.encodeText(text), {
    color,
    font: getPageFontKey(page, font),
    rotate: degrees(0),
    size,
    x,
    xSkew: degrees(0),
    y,
    ySkew: degrees(0),
  }))
}

export function addReportPdfPage(options: AddReportPageOptions): ReportPdfPage {
  const { bold, document, height, kicker, margin, regular, subtitle, title, width } = options
  const page = document.addPage([width, height])
  const headerHeight = 82
  page.drawRectangle({ x: 0, y: height - headerHeight, width, height: headerHeight, color: reportPdfColors.ink })
  drawReportPdfText(page, kicker.toUpperCase(), {
    x: margin, y: height - 25, font: bold, size: 8.5, color: reportPdfColors.gold,
    maximumWidth: width - margin * 2,
  })
  drawReportPdfText(page, title, {
    x: margin, y: height - 51, font: bold, size: 19, color: reportPdfColors.white,
    maximumWidth: width - margin * 2,
  })
  if (subtitle) {
    drawReportPdfText(page, subtitle, {
      x: margin, y: height - 68, font: regular, size: 8, color: rgb(0.88, 0.86, 0.81),
      maximumWidth: width - margin * 2,
    })
  }
  return { bodyTop: height - headerHeight - 20, bottom: 40, height, margin, page, width }
}

export function addReportPdfFooters(
  document: PDFDocument,
  font: PDFFont,
  label = 'Protected SygShift report',
): void {
  const pages = document.getPages()
  pages.forEach((page, index) => {
    const { width } = page.getSize()
    const margin = 34
    page.drawLine({
      start: { x: margin, y: 29 }, end: { x: width - margin, y: 29 },
      thickness: 0.55, color: reportPdfColors.rule,
    })
    drawReportPdfText(page, label, {
      x: margin, y: 16, font, size: 7, color: reportPdfColors.muted,
      maximumWidth: Math.max(0, width - margin * 2 - 90),
    })
    const pageLabel = `Page ${index + 1} of ${pages.length}`
    drawReportPdfText(page, pageLabel, {
      x: width - margin - font.widthOfTextAtSize(pageLabel, 7),
      y: 16, font, size: 7, color: reportPdfColors.muted,
    })
  })
}

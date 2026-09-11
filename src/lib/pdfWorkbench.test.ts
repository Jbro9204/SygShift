import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  completedPdfFilename,
  DEFAULT_SIGNATURE_WIDTH_RATIO,
  finalizePdf,
  movePdfAnnotation,
  resizePdfAnnotation,
  resizePdfTextAnnotation,
  wrapPdfText,
  type PdfAnnotation,
} from './pdfWorkbench'

describe('PDF workbench finalization', () => {
  it('preserves the source page and writes ordinary workbench additions', async () => {
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const bytes = await source.save()
    const completed = await finalizePdf(bytes, [
      { id: 'text', kind: 'text', page: 1, text: 'Approved', xRatio: .2, yRatio: .3 },
      { id: 'date', kind: 'date', page: 1, text: '09/10/2026', xRatio: .55, yRatio: .65 },
      { id: 'check', kind: 'checkmark', page: 1, text: '✓', xRatio: .8, yRatio: .8 },
      {
        fontSize: 12,
        id: 'wrapped-text',
        kind: 'text',
        page: 1,
        text: 'This is a long explanation that must wrap inside its selected text box.\nThis line was entered separately.',
        widthRatio: .25,
        xRatio: .15,
        yRatio: .45,
      },
    ])
    const reopened = await PDFDocument.load(completed)
    expect(reopened.getPageCount()).toBe(1)
    expect(completed.byteLength).toBeGreaterThan(bytes.byteLength)

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    const savedText = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(savedText).toContain('Approved')
    expect(savedText).toContain('This is a long explanation')
    expect(savedText).toContain('This line was entered separately.')
  })

  it('creates a safe completed PDF filename', () => {
    expect(completedPdfFilename('BD: Compensation / Draft.pdf')).toBe('BD- Compensation - Draft.pdf')
    expect(completedPdfFilename('')).toBe('Completed document.pdf')
  })

  it('wraps long text and preserves deliberate line breaks', () => {
    const lines = wrapPdfText('Alpha beta gamma delta\nSecond line', 12, (value) => value.length)
    expect(lines).toEqual(['Alpha beta', 'gamma delta', 'Second line'])
    expect(wrapPdfText('uninterruptedlongword', 6, (value) => value.length)).toEqual(['uninte', 'rrupte', 'dlongw', 'ord'])
  })

  it('keeps moved and resized text boxes inside the page', () => {
    const annotation: PdfAnnotation = { id: 'text', kind: 'text', page: 1, text: 'Details', widthRatio: .44, xRatio: .2, yRatio: .3 }
    expect(movePdfAnnotation(annotation, .9, -.2)).toMatchObject({ xRatio: .54, yRatio: .02 })
    expect(resizePdfTextAnnotation(annotation, .05).widthRatio).toBe(.16)
    expect(resizePdfTextAnnotation(annotation, .95).widthRatio).toBe(.78)
  })

  it('resizes signatures proportionally and keeps their full width on the page', () => {
    const signature: PdfAnnotation = { id: 'signature', kind: 'signature', page: 1, text: 'Michelle Hood', widthRatio: DEFAULT_SIGNATURE_WIDTH_RATIO, xRatio: .5, yRatio: .8 }
    expect(resizePdfAnnotation(signature, .05).widthRatio).toBe(.12)
    expect(resizePdfAnnotation(signature, .95).widthRatio).toBe(.7)
    expect(movePdfAnnotation(resizePdfAnnotation(signature, .7), .95, .8).xRatio).toBe(.65)
    expect(movePdfAnnotation(resizePdfAnnotation(signature, .7), .01, .8).xRatio).toBe(.35)
  })
})

import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  completedPdfFilename,
  DEFAULT_SIGNATURE_WIDTH_RATIO,
  fitPdfText,
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

  it('fills and flattens native PDF form fields into the finished working copy', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage([612, 792])
    const font = await source.embedFont('Helvetica')
    const form = source.getForm()
    form.createTextField('employee_name').addToPage(page, { font, height: 24, width: 220, x: 72, y: 690 })
    form.createCheckBox('employee_received_copy').addToPage(page, { height: 18, width: 18, x: 72, y: 650 })
    const status = form.createDropdown('employment_status')
    status.addOptions(['Active', 'Leave'])
    status.addToPage(page, { font, height: 24, width: 160, x: 72, y: 610 })
    const bytes = await source.save()

    const completed = await finalizePdf(bytes, [
      { id: 'name', kind: 'text', nativeFieldName: 'employee_name', nativeFieldType: 'text', page: 1, text: 'Michelle Hood', xRatio: .1, yRatio: .1 },
      { id: 'copy', kind: 'checkmark', nativeFieldName: 'employee_received_copy', nativeFieldType: 'checkbox', page: 1, text: 'true', xRatio: .1, yRatio: .2 },
      { id: 'status', kind: 'text', nativeFieldName: 'employment_status', nativeFieldType: 'choice', page: 1, text: 'Active', xRatio: .1, yRatio: .3 },
    ])

    const reopened = await PDFDocument.load(completed)
    expect(reopened.getForm().getFields()).toHaveLength(0)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    const savedText = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(savedText).toContain('Michelle Hood')
    expect(savedText).toContain('Active')
  })

  it('auto-fits a long value inside a short native form row before flattening it', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage([612, 792])
    const font = await source.embedFont('Helvetica')
    source.getForm().createTextField('position').addToPage(page, { font, height: 18, width: 110, x: 72, y: 690 })
    const completed = await finalizePdf(await source.save(), [{
      boxHeightRatio: 18 / 792,
      fieldLabel: 'Position',
      fitMode: 'single-line',
      fontSize: 10,
      id: 'position',
      kind: 'text',
      nativeFieldName: 'position',
      nativeFieldType: 'text',
      page: 1,
      text: 'IT and Business Development Engineer',
      widthRatio: 110 / 612,
      xRatio: 72 / 612,
      yRatio: (792 - 708) / 792,
    }])

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    const item = content.items.find((candidate) => 'str' in candidate && candidate.str.includes('IT and Business'))
    expect(item && 'str' in item ? item.str : '').toBe('IT and Business Development Engineer')
    expect(item && 'height' in item ? item.height : 99).toBeLessThan(10)
  })

  it('wraps long text and preserves deliberate line breaks', () => {
    const lines = wrapPdfText('Alpha beta gamma delta\nSecond line', 12, (value) => value.length)
    expect(lines).toEqual(['Alpha beta', 'gamma delta', 'Second line'])
    expect(wrapPdfText('uninterruptedlongword', 6, (value) => value.length)).toEqual(['uninte', 'rrupte', 'dlongw', 'ord'])
  })

  it('shrinks a long position into one bounded line instead of overlapping the next row', () => {
    const layout = fitPdfText(
      'IT and Business Development Engineer',
      110,
      12,
      10,
      (value, size) => value.length * size * .5,
      true,
    )
    expect(layout).not.toBeNull()
    expect(layout?.lines).toEqual(['IT and Business Development Engineer'])
    expect(layout?.fontSize).toBeLessThan(10)
    expect(layout!.lines.length * layout!.lineHeight).toBeLessThanOrEqual(12)
  })

  it('draws manual checkmarks as visible vector strokes without a fragile dingbat font', async () => {
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const completed = await finalizePdf(await source.save(), [
      { id: 'check', kind: 'checkmark', page: 1, text: '✓', xRatio: .25, yRatio: .25 },
    ])
    const reopened = await PDFDocument.load(completed)
    const resources = reopened.getPage(0).node.Resources()
    const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
    const baseFonts = fonts?.entries().map(([, reference]) => {
      const dictionary = reopened.context.lookup(reference, PDFDict)
      return dictionary.get(PDFName.of('BaseFont'))?.toString() ?? ''
    }) ?? []
    expect(baseFonts.some((name) => name.includes('ZapfDingbats'))).toBe(false)
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

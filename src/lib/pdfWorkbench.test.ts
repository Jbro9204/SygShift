import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  completedPdfFilename,
  DEFAULT_SIGNATURE_WIDTH_RATIO,
  fitPdfText,
  finalizePdf,
  movePdfAnnotation,
  PdfPreflightError,
  preflightPdfAnnotations,
  resizePdfAnnotation,
  resizePdfTextAnnotation,
  validatePdfAnnotations,
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
    expect(reopened.catalog.getAcroForm()).toBeUndefined()
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

  it('keeps controlled template fields at their exact mapped coordinates', async () => {
    const source = await PDFDocument.create()
    source.addPage([1_000, 1_000])
    const annotation: PdfAnnotation = {
      boxHeightRatio: .03,
      eraseHeightRatio: .02,
      eraseWidthRatio: .04,
      eraseXRatio: .9,
      eraseYRatio: .2,
      fieldLabel: 'Narrow edge field',
      fitMode: 'single-line',
      fontSize: 12,
      id: 'edge-field',
      kind: 'text',
      page: 1,
      templateFieldKey: 'edge_field',
      templateFieldLayout: 'field-box',
      templateFieldType: 'text',
      text: 'EDGE',
      widthRatio: .05,
      xRatio: .9,
      yRatio: .2,
    }

    expect(movePdfAnnotation(annotation, annotation.xRatio, annotation.yRatio)).toMatchObject({
      widthRatio: .05,
      xRatio: .9,
      yRatio: .2,
    })
    const completed = await finalizePdf(await source.save(), [annotation])
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    const item = content.items.find((candidate) => 'str' in candidate && candidate.str === 'EDGE')
    expect(item && 'transform' in item ? item.transform[4] : 0).toBeCloseTo(901, 0)
  })

  it('resizes signatures proportionally and keeps their full width on the page', () => {
    const signature: PdfAnnotation = { id: 'signature', kind: 'signature', page: 1, text: 'Michelle Hood', widthRatio: DEFAULT_SIGNATURE_WIDTH_RATIO, xRatio: .5, yRatio: .8 }
    expect(resizePdfAnnotation(signature, .05).widthRatio).toBe(.12)
    expect(resizePdfAnnotation(signature, .95).widthRatio).toBe(.7)
    expect(movePdfAnnotation(resizePdfAnnotation(signature, .7), .95, .8).xRatio).toBe(.65)
    expect(movePdfAnnotation(resizePdfAnnotation(signature, .7), .01, .8).xRatio).toBe(.35)
  })

  it('reports invalid pages and geometry before PDF output is created', () => {
    const result = validatePdfAnnotations([
      { id: 'bad-page', kind: 'date', page: 3, text: '10/01/2026', xRatio: .2, yRatio: .2 },
      { id: 'bad-position', kind: 'text', page: 1, text: 'Outside', widthRatio: .3, xRatio: .85, yRatio: .2 },
    ], { pageCount: 2 })

    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'invalid-annotation-page',
      'invalid-annotation-geometry',
    ]))
  })

  it('rejects competing values and collisions between controlled template fields', () => {
    const controlled = (overrides: Partial<PdfAnnotation>): PdfAnnotation => ({
      boxHeightRatio: .04,
      fieldLabel: 'Employee name',
      fitMode: 'single-line',
      id: 'employee-name',
      kind: 'text',
      page: 1,
      templateFieldKey: 'employee_name',
      templateFieldLayout: 'field-box',
      templateFieldType: 'text',
      text: 'Kareama Webster',
      widthRatio: .3,
      xRatio: .2,
      yRatio: .2,
      ...overrides,
    })
    const result = validatePdfAnnotations([
      controlled({ id: 'employee-name-a' }),
      controlled({ id: 'employee-name-b', text: 'Another employee' }),
      controlled({
        fieldLabel: 'Employee ID',
        id: 'employee-id',
        templateFieldKey: 'employee_id',
        text: 'SYG-1074',
        widthRatio: .2,
        xRatio: .45,
      }),
    ], { pageCount: 1 })

    expect(result.issues.some((issue) => issue.code === 'conflicting-template-field'
      && issue.annotationIds.includes('employee-name-a')
      && issue.annotationIds.includes('employee-name-b'))).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'field-collision'
      && issue.annotationIds.includes('employee-id'))).toBe(true)
  })

  it('keeps printed names, signatures, and date/time cells semantically separate', () => {
    const result = validatePdfAnnotations([
      {
        boxHeightRatio: .04,
        fieldLabel: 'Employee printed name',
        fitMode: 'single-line',
        id: 'printed-name',
        kind: 'signature',
        page: 1,
        signaturePng: new Uint8Array([1]),
        templateFieldKey: 'employee_printed_name',
        templateFieldLayout: 'field-box',
        templateFieldType: 'text',
        text: 'Kareama Webster',
        widthRatio: .22,
        xRatio: .2,
        yRatio: .75,
      },
      {
        boxHeightRatio: .04,
        fieldLabel: 'Employee signature',
        fitMode: 'single-line',
        id: 'signature',
        kind: 'text',
        page: 1,
        templateFieldKey: 'employee_signature',
        templateFieldLayout: 'field-box',
        templateFieldType: 'signature',
        text: 'Kareama Webster',
        widthRatio: .22,
        xRatio: .46,
        yRatio: .75,
      },
      {
        boxHeightRatio: .04,
        fieldLabel: 'Employee date/time',
        fitMode: 'single-line',
        id: 'signed-at',
        kind: 'signature',
        page: 1,
        signaturePng: new Uint8Array([1]),
        templateFieldKey: 'employee_signed_at',
        templateFieldLayout: 'field-box',
        templateFieldType: 'date',
        text: 'Kareama Webster',
        widthRatio: .18,
        xRatio: .72,
        yRatio: .75,
      },
      {
        boxHeightRatio: .04,
        fieldLabel: 'Enter / Sign',
        fitMode: 'single-line',
        id: 'ambiguous',
        kind: 'text',
        page: 1,
        templateFieldKey: 'legacy_grid_cell',
        templateFieldLayout: 'field-box',
        text: 'Unknown purpose',
        widthRatio: .18,
        xRatio: .05,
        yRatio: .85,
      },
    ], { pageCount: 1 })

    expect(result.issues.some((issue) => issue.code === 'invalid-field-type' && issue.annotationIds.includes('printed-name'))).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'invalid-signature' && issue.annotationIds.includes('signature'))).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'invalid-field-type' && issue.annotationIds.includes('signed-at'))).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'ambiguous-template-field' && issue.annotationIds.includes('ambiguous'))).toBe(true)
  })

  it('treats a signature placeholder mask separately from the full signature cell', () => {
    const result = validatePdfAnnotations([{
      boxHeightRatio: .05,
      eraseHeightRatio: .02,
      eraseWidthRatio: .07,
      eraseXRatio: .465,
      eraseYRatio: .49,
      fieldLabel: 'Receiving Manager signature',
      id: 'manager-signature',
      kind: 'signature',
      page: 1,
      signaturePng: new Uint8Array([1]),
      templateFieldKey: 'receiving_manager_signature',
      templateFieldLayout: 'field-box',
      templateFieldType: 'signature',
      text: 'Misty Kimbal',
      widthRatio: .3,
      xRatio: .5,
      yRatio: .5,
    }], { pageCount: 1 })

    expect(result).toEqual({ issues: [], ok: true })
  })

  it('blocks unverified or oversized body masks that could hide paragraph text', () => {
    const result = validatePdfAnnotations([
      {
        boxHeightRatio: .035,
        eraseHeightRatio: .08,
        eraseWidthRatio: .52,
        eraseXRatio: .25,
        eraseYRatio: .4,
        fieldLabel: 'Notice date',
        fitMode: 'single-line',
        id: 'notice-date',
        kind: 'text',
        page: 1,
        templateFieldKey: 'notice_date',
        templateFieldLayout: 'inline-body',
        templateFieldType: 'date',
        text: '10/01/2026',
        widthRatio: .14,
        xRatio: .25,
        yRatio: .4,
      },
      {
        boxHeightRatio: .04,
        eraseHeightRatio: .025,
        eraseWidthRatio: .12,
        fieldLabel: 'Final day',
        fitMode: 'single-line',
        id: 'unverified-final-day',
        kind: 'text',
        page: 1,
        templateFieldKey: 'final_day',
        templateFieldType: 'date',
        text: '10/15/2026',
        widthRatio: .15,
        xRatio: .55,
        yRatio: .4,
      },
    ], { pageCount: 1 })

    expect(result.issues.filter((issue) => issue.code === 'body-mask-risk').length).toBeGreaterThanOrEqual(3)
    expect(result.issues.some((issue) => issue.message.includes('could cover document text'))).toBe(true)
    expect(result.issues.some((issue) => issue.message.includes('missing a verified field boundary'))).toBe(true)
  })

  it('preserves body copy and writes a verified inline value into final PDF bytes', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage([612, 792])
    const font = await source.embedFont('Helvetica')
    page.drawText('Guardianship received your voluntary resignation on', { font, size: 11, x: 72, y: 620 })
    page.drawText('[NOTICE DATE]', { font, size: 11, x: 330, y: 620 })
    page.drawText('and recorded your final day.', { font, size: 11, x: 420, y: 620 })
    const bytes = await source.save()
    const annotation: PdfAnnotation = {
      boxHeightRatio: 18 / 792,
      eraseHeightRatio: 15 / 792,
      eraseWidthRatio: 80 / 612,
      eraseXRatio: 326 / 612,
      eraseYRatio: 160 / 792,
      fieldLabel: 'Notice date',
      fitMode: 'single-line',
      fontSize: 11,
      id: 'notice-date',
      kind: 'text',
      page: 1,
      templateFieldKey: 'notice_date',
      templateFieldLayout: 'inline-body',
      templateFieldType: 'date',
      text: '10/01/2026',
      widthRatio: 90 / 612,
      xRatio: 326 / 612,
      yRatio: 160 / 792,
    }

    await expect(preflightPdfAnnotations(bytes, [annotation])).resolves.toMatchObject({ ok: true, issues: [] })
    const completed = await finalizePdf(bytes, [annotation])
    const reopened = await PDFDocument.load(completed)
    expect(reopened.getPageCount()).toBe(1)
    expect(completed.byteLength).toBeGreaterThan(bytes.byteLength)

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    const savedText = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(savedText).toContain('Guardianship received your voluntary resignation on')
    expect(savedText).toContain('and recorded your final day.')
    expect(savedText).toContain('10/01/2026')
  })

  it('reflows one inline placeholder with its surrounding sentence and punctuation', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage([612, 792])
    const font = await source.embedFont('Helvetica')
    const sourceText = 'Dear [EMPLOYEE FIRST NAME]:'
    const expectedText = 'Dear Eliot:'
    const sourceX = 72
    const sourceBaseline = 620
    const fontSize = 11
    page.drawText(sourceText, { font, size: fontSize, x: sourceX, y: sourceBaseline })
    const token = '[EMPLOYEE FIRST NAME]'
    const tokenStart = sourceText.indexOf(token)
    const tokenX = sourceX + font.widthOfTextAtSize(sourceText.slice(0, tokenStart), fontSize)
    const tokenWidth = font.widthOfTextAtSize(token, fontSize)
    const lineTop = 792 - sourceBaseline - fontSize * 1.08
    const annotation: PdfAnnotation = {
      boxHeightRatio: 14 / 792,
      eraseHeightRatio: 14 / 792,
      eraseWidthRatio: (tokenWidth + 1) / 612,
      eraseXRatio: tokenX / 612,
      eraseYRatio: lineTop / 792,
      fieldLabel: 'Employee first name',
      fitMode: 'single-line',
      fontSize,
      id: 'employee-first-name',
      kind: 'text',
      page: 1,
      sourceLine: {
        baselineRatio: (792 - sourceBaseline) / 792,
        heightRatio: 14 / 792,
        id: 'page-1-line-1',
        text: sourceText,
        topRatio: lineTop / 792,
        widthRatio: (font.widthOfTextAtSize(sourceText, fontSize) + 1) / 612,
        xRatio: sourceX / 612,
      },
      sourceSpan: { length: token.length, start: tokenStart },
      templateFieldKey: 'employee_first_name',
      templateFieldLayout: 'inline-body',
      templateFieldType: 'text',
      text: 'Eliot',
      widthRatio: (tokenWidth + 6) / 612,
      xRatio: tokenX / 612,
      yRatio: lineTop / 792,
    }

    const completed = await finalizePdf(await source.save(), [annotation])
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    expect(content.items.some((item) => 'str' in item && item.str === expectedText)).toBe(true)
    expect(content.items.some((item) => 'str' in item && item.str === 'Eliot')).toBe(false)
  })

  it('coalesces multiple inline values on one source line before redrawing it', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage([612, 792])
    const font = await source.embedFont('Helvetica')
    const sourceText = 'Your final day is [LAST DAY], and your final scheduled shift is [SHIFT / SITE OR N/A].'
    const expectedText = 'Your final day is 10/15/2026, and your final scheduled shift is Elevon overnight.'
    const sourceX = 48
    const sourceBaseline = 620
    const fontSize = 8
    const lineTop = 792 - sourceBaseline - fontSize * 1.08
    page.drawText(sourceText, { font, size: fontSize, x: sourceX, y: sourceBaseline })
    const sourceLine = {
      baselineRatio: (792 - sourceBaseline) / 792,
      heightRatio: 11 / 792,
      id: 'page-1-line-2',
      text: sourceText,
      topRatio: lineTop / 792,
      widthRatio: (font.widthOfTextAtSize(sourceText, fontSize) + 1) / 612,
      xRatio: sourceX / 612,
    }
    const annotationFor = (id: string, token: string, text: string, type: 'date' | 'text'): PdfAnnotation => {
      const tokenStart = sourceText.indexOf(token)
      const tokenX = sourceX + font.widthOfTextAtSize(sourceText.slice(0, tokenStart), fontSize)
      const tokenWidth = font.widthOfTextAtSize(token, fontSize)
      return {
        boxHeightRatio: 11 / 792,
        eraseHeightRatio: 11 / 792,
        eraseWidthRatio: (tokenWidth + 1) / 612,
        eraseXRatio: tokenX / 612,
        eraseYRatio: lineTop / 792,
        fieldLabel: id,
        fitMode: 'single-line',
        fontSize,
        id,
        kind: 'text',
        page: 1,
        sourceLine,
        sourceSpan: { length: token.length, start: tokenStart },
        templateFieldKey: id,
        templateFieldLayout: 'inline-body',
        templateFieldType: type,
        text,
        widthRatio: (tokenWidth + 5) / 612,
        xRatio: tokenX / 612,
        yRatio: lineTop / 792,
      }
    }
    const annotations = [
      annotationFor('last_day', '[LAST DAY]', '10/15/2026', 'date'),
      annotationFor('shift_site', '[SHIFT / SITE OR N/A]', 'Elevon overnight', 'text'),
    ]

    const completed = await finalizePdf(await source.save(), annotations)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    expect(content.items.some((item) => 'str' in item && item.str === expectedText)).toBe(true)
    expect(content.items.some((item) => 'str' in item && item.str === '10/15/2026')).toBe(false)
    expect(content.items.some((item) => 'str' in item && item.str === 'Elevon overnight')).toBe(false)
  })

  it('fits long bounded controlled values without allowing them into the next field', async () => {
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const annotation: PdfAnnotation = {
      boxHeightRatio: .09,
      eraseHeightRatio: .025,
      eraseWidthRatio: .16,
      eraseXRatio: .12,
      eraseYRatio: .25,
      fieldLabel: 'Employee statement',
      fitMode: 'bounded',
      fontSize: 11,
      id: 'statement',
      kind: 'text',
      page: 1,
      templateFieldKey: 'employee_statement',
      templateFieldLayout: 'field-box',
      templateFieldType: 'long_text',
      text: 'Please accept this email as formal notification that I am submitting my two-week resignation from Guardianship Security.',
      widthRatio: .58,
      xRatio: .12,
      yRatio: .25,
    }
    const completed = await finalizePdf(await source.save(), [annotation])
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loaded = await pdfjs.getDocument({ data: new Uint8Array(completed) }).promise
    const content = await (await loaded.getPage(1)).getTextContent()
    const savedText = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
    expect(savedText).toContain('Please accept this email as formal notification')
    expect(savedText).toContain('Guardianship Security.')
  })

  it('returns actionable preflight errors and no finished bytes for an unsafe document', async () => {
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const bytes = await source.save()
    const unsafe: PdfAnnotation = {
      boxHeightRatio: .03,
      eraseHeightRatio: .09,
      eraseWidthRatio: .4,
      fieldLabel: 'Final day',
      fitMode: 'single-line',
      id: 'final-day',
      kind: 'signature',
      page: 1,
      signaturePng: new Uint8Array([1]),
      templateFieldKey: 'final_day',
      templateFieldLayout: 'inline-body',
      templateFieldType: 'date',
      text: 'Not a date',
      widthRatio: .15,
      xRatio: .3,
      yRatio: .4,
    }

    await expect(finalizePdf(bytes, [unsafe])).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PdfPreflightError)
      expect((error as Error).message).toContain('cannot be completed safely')
      expect((error as Error).message).toContain('Final day')
      return true
    })
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildSignedPdf } from '../worker'

const onePixelPng = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

async function sourcePdf() {
  const pdf = await PDFDocument.create()
  pdf.addPage([612, 792])
  return new Uint8Array(await pdf.save())
}

function payload(fields: Array<Record<string, unknown>>) {
  return {
    state: 'processing' as const,
    envelopeId: '11111111-1111-4111-8111-111111111111',
    documentTitle: 'Employee acknowledgment',
    sourceMimeType: 'application/pdf',
    sourceChecksum: 'a'.repeat(64),
    recipients: [{
      actedAt: '2026-09-08T18:00:00.000Z',
      fields,
      legalName: 'Jordan Example',
      requiredAction: 'sign',
      signature: {
        bucket: 'signature-appearances',
        checksum: createHash('sha256').update(onePixelPng).digest('hex'),
        displayName: 'Jordan Example',
        objectKey: 'employee/signature.png',
      },
    }],
  }
}

describe('finalized signature PDF presentation', () => {
  it('appends a visible signature page when a reusable template was intentionally omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(onePixelPng, { status: 200 })))
    const result = await buildSignedPdf(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      payload([]),
      await sourcePdf(),
    )

    expect((await PDFDocument.load(result)).getPageCount()).toBe(2)
    vi.unstubAllGlobals()
  })

  it('does not add an extra page when the signature has an explicit template position', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(onePixelPng, { status: 200 })))
    const result = await buildSignedPdf(
      { serviceRoleKey: 'service-role', url: 'https://example.supabase.co' },
      payload([{ fieldType: 'signature', heightRatio: 0.08, pageNumber: 1, widthRatio: 0.3, xRatio: 0.1, yRatio: 0.8 }]),
      await sourcePdf(),
    )

    expect((await PDFDocument.load(result)).getPageCount()).toBe(1)
    vi.unstubAllGlobals()
  })
})

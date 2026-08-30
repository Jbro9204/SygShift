/// <reference types="node" />

import { zipSync, strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { recentAuthenticatorMfa, validateHrDocumentFile } from '../worker/index'

const encoder = new TextEncoder()

describe('HRIS Stage 4 protected document pipeline', () => {
  it('accepts only content whose extension, declared MIME type, and signature agree', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

    expect(validateHrDocumentFile(png, 'guard-card.png', 'image/png')).toEqual({
      detectedMimeType: 'image/png',
      extension: 'png',
      sanitizedFilename: 'guard-card.png',
    })
    expect(() => validateHrDocumentFile(png, 'guard-card.jpg', 'image/jpeg'))
      .toThrow('The file name, declared type, and verified content do not match.')
  })

  it('rejects active PDF content before it can enter quarantine', () => {
    const unsafePdf = encoder.encode('%PDF-1.7\n1 0 obj << /OpenAction 2 0 R /JavaScript true >>')

    expect(() => validateHrDocumentFile(unsafePdf, 'unsafe.pdf', 'application/pdf'))
      .toThrow('PDF files with scripts, launch actions, or embedded content are not allowed.')
  })

  it('rejects Office files with macros, embedded objects, or external relationships', () => {
    const macroDocument = zipSync({
      'word/document.xml': strToU8('<document/>'),
      'word/vbaProject.bin': new Uint8Array([1, 2, 3]),
    })
    expect(() => validateHrDocumentFile(
      macroDocument,
      'unsafe.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )).toThrow('Macro, embedded, or external Office content is not allowed.')

    const externalDocument = zipSync({
      'word/document.xml': strToU8('<document/>'),
      'word/_rels/document.xml.rels': strToU8('<Relationship TargetMode="External" Target="https://example.invalid"/>'),
    })
    expect(() => validateHrDocumentFile(
      externalDocument,
      'external.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )).toThrow('Office documents with external relationships are not allowed.')
  })

  it('accepts a structurally verified macro-free Office document', () => {
    const document = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8('<document><body>Verified</body></document>'),
    })

    expect(validateHrDocumentFile(
      document,
      'verified.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ).detectedMimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('accepts recent authenticator MFA and rejects stale or trusted-device-only sessions', () => {
    const now = 2_000_000_000
    const recentClaims = {
      aal: 'aal2',
      amr: [{ method: 'totp', timestamp: now - 60 }],
    }
    const staleClaims = {
      aal: 'aal2',
      amr: [{ method: 'totp', timestamp: now - (16 * 60) }],
    }
    const trustedDeviceOnly = {
      aal: 'aal2',
      amr: [{ method: 'trusted_device', timestamp: now - 5 }],
    }

    expect(recentAuthenticatorMfa(recentClaims, now)).toBe(new Date((now - 60) * 1000).toISOString())
    expect(recentAuthenticatorMfa(staleClaims, now)).toBeNull()
    expect(recentAuthenticatorMfa(trustedDeviceOnly, now)).toBeNull()
  })
})

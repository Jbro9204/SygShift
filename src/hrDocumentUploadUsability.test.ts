import { describe, expect, it } from 'vitest'
import { hrDocumentMimeType } from './data/hrDocuments'

describe('HR document upload usability', () => {
  it('recognizes supported files when Windows or a browser omits the MIME type', () => {
    expect(hrDocumentMimeType({ name: 'Outside Proposal.DOCX', type: '' })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(hrDocumentMimeType({ name: 'Signed agreement.pdf', type: 'application/octet-stream' })).toBe('application/pdf')
    expect(hrDocumentMimeType({ name: 'Hours.XLSX', type: '' })).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('preserves a supported browser MIME type for server-side content verification', () => {
    expect(hrDocumentMimeType({ name: 'photo.jpg', type: 'image/jpeg' })).toBe('image/jpeg')
  })
})

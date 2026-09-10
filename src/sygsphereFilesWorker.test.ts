// The primary Vitest include is intentionally limited to src. Import the Worker suite here so the
// protected SygSphere streaming/preview boundary is exercised by the normal test command.
import '../worker/sygsphereFiles.test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateSygSphereResumableFile, validateSygSphereUploadIntent, waitForPrivateStorageObjectHead } from '../worker/index'

afterEach(() => vi.unstubAllGlobals())

describe('SygSphere larger-file validation', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('accepts a matching image only in the protected larger-file range', () => {
    expect(validateSygSphereResumableFile(png, 'field-photo.png', 'image/png', 26214401)).toEqual({
      detectedMimeType: 'image/png',
      sanitizedFilename: 'field-photo.png',
    })
  })

  it('rejects type mismatches, non-image larger files, and files over 100 MB', () => {
    expect(() => validateSygSphereResumableFile(png, 'field-photo.jpg', 'image/jpeg', 26214401)).toThrow('do not match')
    expect(() => validateSygSphereResumableFile(new TextEncoder().encode('%PDF-1.7'), 'report.pdf', 'application/pdf', 26214401)).toThrow('JPEG, PNG, and WebP')
    expect(() => validateSygSphereResumableFile(png, 'field-photo.png', 'image/png', 104857601)).toThrow('100 MB')
  })

  it('authorizes small supported documents for the same private quarantine pipeline', () => {
    expect(validateSygSphereUploadIntent('field-report.pdf', 'application/pdf', 29_500)).toEqual({
      mimeType: 'application/pdf',
      sanitizedFilename: 'field-report.pdf',
    })
    expect(validateSygSphereUploadIntent('briefing.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 26214400).mimeType).toContain('wordprocessingml')
    expect(() => validateSygSphereUploadIntent('field-report.pdf', 'application/pdf', 26214401)).toThrow('over 25 MB')
    expect(() => validateSygSphereUploadIntent('field-report.pdf', 'text/plain', 29_500)).toThrow('do not match')
  })

  it('waits for a just-finished resumable object to become visible before finalization', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await waitForPrivateStorageObjectHead(
      { serviceRoleKey: 'service-role-test', url: 'https://project.supabase.co' },
      'sygsphere-files',
      'conversation/file',
      [0, 0],
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

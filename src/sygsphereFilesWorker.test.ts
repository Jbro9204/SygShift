// The primary Vitest include is intentionally limited to src. Import the Worker suite here so the
// protected SygSphere streaming/preview boundary is exercised by the normal test command.
import '../worker/sygsphereFiles.test'
import { describe, expect, it } from 'vitest'
import { validateSygSphereResumableFile } from '../worker/index'

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
})

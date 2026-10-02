import { describe, expect, it } from 'vitest'
import { isHrDocumentSourceVersionTimestamp, normalizeHrDocumentLibraryTimestamps } from '../worker/hrDocumentLibraryPayload'

describe('HR document library API timestamp normalization', () => {
  it('normalizes PostgreSQL zero-offset timestamps without losing microseconds', () => {
    const payload = normalizeHrDocumentLibraryTimestamps({
      items: [
        { code: 'GS-HR-001', updatedAt: '2026-10-01T18:45:12.345678+00:00' },
        { code: 'GS-HR-002', updatedAt: '2026-10-01T18:45:12.345678-00:00' },
        { code: 'GS-HR-003', updatedAt: '2026-10-01T14:45:12.345-04:00' },
        { code: 'GS-HR-004', updatedAt: '2026-10-01T18:45:12Z' },
      ],
    })

    expect(payload.items).toEqual([
      { code: 'GS-HR-001', updatedAt: '2026-10-01T18:45:12.345678Z' },
      { code: 'GS-HR-002', updatedAt: '2026-10-01T18:45:12.345678Z' },
      { code: 'GS-HR-003', updatedAt: '2026-10-01T14:45:12.345-04:00' },
      { code: 'GS-HR-004', updatedAt: '2026-10-01T18:45:12Z' },
    ])
  })

  it('removes null and malformed timestamps while preserving each library item', () => {
    const payload = normalizeHrDocumentLibraryTimestamps({
      items: [
        { code: 'GS-HR-001', updatedAt: null },
        { code: 'GS-HR-002', updatedAt: 'not-a-timestamp' },
        { code: 'GS-HR-003', updatedAt: '' },
        { code: 'GS-HR-004', updatedAt: '2026-10-01T18:45:12.345678' },
      ],
      requestId: '30000000-0000-4000-8000-000000000001',
    })

    expect(payload).toEqual({
      items: [
        { code: 'GS-HR-001' },
        { code: 'GS-HR-002' },
        { code: 'GS-HR-003' },
        { code: 'GS-HR-004' },
      ],
      requestId: '30000000-0000-4000-8000-000000000001',
    })
  })

  it('validates source-version timestamps without converting away PostgreSQL microseconds', () => {
    expect(isHrDocumentSourceVersionTimestamp('2026-10-01T18:45:12.345678Z')).toBe(true)
    expect(isHrDocumentSourceVersionTimestamp('2026-10-01T18:45:12.345678+00:00')).toBe(true)
    expect(isHrDocumentSourceVersionTimestamp('2026-10-01T14:45:12.345678-04:00')).toBe(true)
    expect(isHrDocumentSourceVersionTimestamp('2026-10-01T18:45:12.345678')).toBe(false)
    expect(isHrDocumentSourceVersionTimestamp('not-a-timestamp')).toBe(false)
  })
})

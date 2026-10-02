import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getHrDocumentLibrary } from './hrDocumentLibrary'

const documentApiRequest = vi.hoisted(() => vi.fn())

vi.mock('./hrDocuments', () => ({
  documentApiRequest,
  parseApiError: vi.fn(),
}))

const baseItem = {
  id: '10000000-0000-4000-8000-000000000001',
  code: 'GS-HR-001',
  title: 'Employee information form',
  category: 'Onboarding',
  section: 'HR/Onboarding',
  recordClass: 'employee_record',
  purpose: 'Collect employee information.',
  audience: 'hr_only',
  sensitivity: 'restricted',
  sourceFilename: 'GS-HR-001.pdf',
  sourceType: 'controlled_form',
  sourceSha256: 'a'.repeat(64),
  sourceDocumentId: '20000000-0000-4000-8000-000000000001',
  availability: 'available',
  documentKind: 'hr_source',
  lifecycleStatus: 'draft_for_adoption',
  guideCode: null,
  relatedModules: [],
  pageCount: 2,
} as const

function libraryResponse(updatedAtValues: unknown[]) {
  return {
    releaseState: 'released',
    libraryVersion: '2.1',
    permissions: {
      canSeeSupervisor: true,
      canSeeHr: true,
      canManage: true,
    },
    summary: {
      visibleCount: updatedAtValues.length,
      matchingCount: updatedAtValues.length,
      availableCount: updatedAtValues.length,
      categoryCount: 1,
    },
    categories: [{ name: 'Onboarding', count: updatedAtValues.length }],
    items: updatedAtValues.map((updatedAt, index) => ({
      ...baseItem,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      updatedAt,
    })),
    pagination: {
      page: 1,
      pageSize: 10,
      totalCount: updatedAtValues.length,
      totalPages: 1,
    },
    requestId: '30000000-0000-4000-8000-000000000001',
  }
}

describe('HR document library timestamp contract', () => {
  beforeEach(() => documentApiRequest.mockReset())

  it.each([
    ['2026-10-01T18:45:12.345678+00:00', '2026-10-01T18:45:12.345678Z'],
    ['2026-10-01T18:45:12.345678-00:00', '2026-10-01T18:45:12.345678Z'],
    ['2026-10-01T14:45:12.345-04:00', '2026-10-01T14:45:12.345-04:00'],
    ['2026-10-01T18:45:12Z', '2026-10-01T18:45:12Z'],
  ])('accepts the valid RFC 3339 timestamp %s without losing precision', async (updatedAt, expected) => {
    documentApiRequest.mockResolvedValueOnce(Response.json(libraryResponse([updatedAt])))

    const workspace = await getHrDocumentLibrary()

    expect(workspace.items[0]?.updatedAt).toBe(expected)
  })

  it('keeps the library available when optional update timestamps are null or malformed', async () => {
    documentApiRequest.mockResolvedValueOnce(Response.json(libraryResponse([
      null,
      'not-a-timestamp',
      '',
    ])))

    const workspace = await getHrDocumentLibrary()

    expect(workspace.items).toHaveLength(3)
    expect(workspace.items.map((item) => item.updatedAt)).toEqual([undefined, undefined, undefined])
    expect(workspace.items.map((item) => item.code)).toEqual(['GS-HR-001', 'GS-HR-001', 'GS-HR-001'])
  })
})

import { describe, expect, it } from 'vitest'
import { normalizedPackagePath, parseHrSystemCatalog } from './hrSystemImport'

function item(index: number) {
  const code = `T${String(index).padStart(3, '0')}`
  return {
    kind: 'training_module', code, title: `Training ${index}`, category: 'Core training', section: 'Modules',
    recordClass: 'Training library', purpose: 'Controlled employee training material.', audience: 'hr_only',
    sensitivity: 'confidential', vaultCode: 'hr-general', status: 'draft_for_adoption',
    sourceRelativePath: `TRAINING/02_MODULES/${code}.docx`, pdfRelativePath: `pdf/TRAINING/02_MODULES/${code}.pdf`,
    relatedModules: [], guideCode: null, pageCount: 2, sizeBytes: 100,
    sha256: 'a'.repeat(64), searchText: 'training searchable content',
  }
}

describe('HR System v2.1 rollout package', () => {
  it('accepts only the complete canonical 537-PDF catalog', () => {
    const catalog = parseHrSystemCatalog({
      package: 'Guardianship Security HR System v2.1 with Training', libraryVersion: '2.1',
      status: 'draft_for_company_adoption', canonicalPdfCount: 537, excluded: [],
      items: Array.from({ length: 537 }, (_, index) => item(index)),
    })
    expect(catalog.items).toHaveLength(537)
  })

  it('normalizes manifest and folder paths to the same PDF key', () => {
    expect(normalizedPackagePath('pdf\\TRAINING\\02_MODULES\\T100.pdf')).toBe('training/02_modules/t100.pdf')
    expect(normalizedPackagePath('TRAINING/02_MODULES/T100.pdf')).toBe('training/02_modules/t100.pdf')
  })
})

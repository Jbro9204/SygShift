/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dashboard = readFileSync('src/components/DocumentStudioDashboard.tsx', 'utf8')
const library = readFileSync('src/components/HrDocumentLibrary.tsx', 'utf8')
const libraryData = readFileSync('src/data/hrDocumentLibrary.ts', 'utf8')
const page = readFileSync('src/pages/HrisDocumentsPage.tsx', 'utf8')
const css = readFileSync('src/documentStudio.css', 'utf8')

describe('Document Center source and record usability', () => {
  it('separates reusable sources, reference material, and permanent records', () => {
    expect(dashboard).toContain("['forms', 'Forms & source catalog']")
    expect(dashboard).toContain("['learning', 'Guides, policies & training']")
    expect(page).toContain('Saved document records')
    expect(page).not.toContain('Completed and uploaded documents')
    expect(page).not.toContain('getHrDocumentLibrarySourceIndex')
    expect(libraryData).not.toContain('getHrDocumentLibrarySourceIndex')
    expect(page).toContain('document.sourceMetadata')
    expect(page).toContain('presentDocumentRecord(document, source)')
  })

  it('labels source type and status while exposing useful retrieval metadata', () => {
    expect(library).toContain('hr-template-library__kind')
    expect(library).toContain('Source file ready')
    expect(library).toContain('Retrieval and source details')
    expect(library).toContain('Controlled filename')
    expect(library).toContain('Related modules')
    expect(library).toContain('libraryAllowsWorkingCopy')
    expect(library).toContain("mode === 'training' ? 'training_module' : 'document_guide'")
    expect(library).toContain("item.lifecycleStatus === 'draft_for_adoption'")
    expect(library).toContain('aria-controls={detailsId}')
    expect(library).toContain('hidden={!expanded}')
    expect(library).toContain('id={detailsId}')
  })

  it('wraps long titles and metadata at desktop and compact widths', () => {
    expect(css).toMatch(/\.hr-template-library__identity strong\s*\{[^}]*overflow-wrap:\s*anywhere/s)
    expect(css).toMatch(/\.hr-document-row__identity > strong,[\s\S]*?white-space:\s*normal/s)
    expect(css).toMatch(/@media \(max-width:\s*480px\)[\s\S]*?\.hr-document-row__details dl\s*\{[^}]*grid-template-columns:\s*1fr/s)
  })
})

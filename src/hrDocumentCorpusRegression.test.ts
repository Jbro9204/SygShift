import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { StandardFontEmbedder, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { detectTemplateFields, MAX_DETECTED_TEMPLATE_FIELDS } from './components/DocumentWorkbench'

interface CatalogItem {
  code: string
  kind: string
  pdfRelativePath: string
  searchText: string
  section: string
  title: string
}

interface Catalog {
  items: CatalogItem[]
}

const rolloutPath = process.env.SYGSHIFT_HR_ROLLOUT_ZIP
const corpusDescribe = rolloutPath ? describe : describe.skip
const metricFont = StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as Parameters<typeof StandardFontEmbedder.for>[0])

function textSpanFractions(text: string, start: number, length: number) {
  const totalWidth = metricFont.widthOfTextAtSize(text, 100)
  return {
    startFraction: metricFont.widthOfTextAtSize(text.slice(0, start), 100) / totalWidth,
    widthFraction: metricFont.widthOfTextAtSize(text.slice(start, start + length), 100) / totalWidth,
  }
}

corpusDescribe('controlled HR PDF form corpus', () => {
  it('detects every placeholder without truncation, ambiguous generic cells, or row collisions', async () => {
    if (!rolloutPath) throw new Error('SYGSHIFT_HR_ROLLOUT_ZIP is required for the controlled document corpus test.')
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const archive = unzipSync(new Uint8Array(await readFile(rolloutPath)))
    const catalogBytes = archive['catalog.json']
    if (!catalogBytes) throw new Error('catalog.json was not found in the rollout ZIP.')
    const catalog = JSON.parse(strFromU8(catalogBytes)) as Catalog
    const forms = catalog.items.filter((item) => item.kind === 'hr_source' && item.searchText.includes('['))
    expect(forms).toHaveLength(212)

    const failures: string[] = []
    let detectedFieldCount = 0
    let placeholderCount = 0

    for (const form of forms) {
      const source = archive[form.pdfRelativePath]
      if (!source) {
        failures.push(`${form.code}: missing ${form.pdfRelativePath}`)
        continue
      }
      const pdf = await getDocument({ data: new Uint8Array(source) }).promise
      let expectedPlaceholders = 0
      const sourcePlaceholders: Array<{
        heightRatio: number
        label: string
        page: number
        widthRatio: number
        xRatio: number
        yRatio: number
      }> = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        for (const item of content.items) {
          if (!('str' in item) || !item.str.includes('[') || !Array.isArray(item.transform)) continue
          const itemWidth = Math.max(Number(item.width) || 0, 24)
          const itemHeight = Math.max(Math.abs(Number(item.height) || Number(item.transform[3]) || 0), 9)
          const [baselineX, baselineY] = viewport.convertToViewportPoint(Number(item.transform[4]) || 0, Number(item.transform[5]) || 0)
          for (const match of item.str.matchAll(/\[([^\]\r\n]{2,160})\]/g)) {
            const { startFraction, widthFraction } = textSpanFractions(item.str, match.index ?? 0, match[0].length)
            sourcePlaceholders.push({
              heightRatio: itemHeight / viewport.height,
              label: match[1].replace(/\s+/g, ' ').trim(),
              page: pageNumber,
              widthRatio: itemWidth * widthFraction / viewport.width,
              xRatio: (baselineX + itemWidth * startFraction) / viewport.width,
              yRatio: (baselineY - itemHeight * 1.08) / viewport.height,
            })
            expectedPlaceholders += 1
          }
        }
      }
      const detected = await detectTemplateFields(pdf)
      const destroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy
      if (destroy) await destroy.call(pdf)
      detectedFieldCount += detected.fields.length
      placeholderCount += expectedPlaceholders

      if (detected.truncated || detected.fields.length >= MAX_DETECTED_TEMPLATE_FIELDS) {
        failures.push(`${form.code}: field detection was truncated at ${detected.fields.length}`)
      }
      if (detected.fields.length < expectedPlaceholders) {
        failures.push(`${form.code}: detected ${detected.fields.length} fields for ${expectedPlaceholders} placeholders`)
      }
      const ambiguousGeneric = detected.fields.filter((field) => (
        /^(?:enter|enter\s*\/\s*sign)$/i.test(field.rawLabel) && field.mappingStatus !== 'mapped'
      ))
      if (ambiguousGeneric.length) {
        const sample = ambiguousGeneric.slice(0, 6).map((field) => (
          `${field.rawLabel}@p${field.page}(${field.xRatio.toFixed(3)},${field.yRatio.toFixed(3)})/${field.groupLabel}`
        )).join(', ')
        failures.push(`${form.code}: ${ambiguousGeneric.length} generic table/signature cells remain ambiguous [${sample}]`)
      }
      for (const field of detected.fields) {
        if (field.xRatio < 0 || field.yRatio < 0 || field.widthRatio <= 0 || field.boxHeightRatio <= 0
          || field.xRatio + field.widthRatio > 1.001 || field.yRatio + field.boxHeightRatio > 1.001) {
          failures.push(`${form.code}: ${field.label} has invalid page geometry`)
        }
        if (field.eraseWidthRatio > field.widthRatio + .001) {
          failures.push(`${form.code}: ${field.label} erases outside its verified field width`)
        }
        if (!field.nativeFieldName && !field.id.startsWith('checkbox:') && field.rawLabel) {
          const sourcePlaceholder = sourcePlaceholders.find((candidate) => (
            candidate.page === field.page
            && candidate.label.toLocaleLowerCase() === field.rawLabel.toLocaleLowerCase()
            && Math.abs(candidate.xRatio - field.xRatio) < .003
            && Math.abs(candidate.yRatio - field.yRatio) < .005
          ))
          if (!sourcePlaceholder) {
            failures.push(`${form.code}: ${field.label} could not be matched back to its source placeholder`)
          } else {
            if (field.eraseWidthRatio > sourcePlaceholder.widthRatio + .012) {
              failures.push(`${form.code}: ${field.label} uses a wider erase mask than its source placeholder`)
            }
            if (field.eraseHeightRatio > sourcePlaceholder.heightRatio + .006) {
              failures.push(`${form.code}: ${field.label} uses a taller erase mask than its source placeholder`)
            }
          }
        }
      }
      const lines = detected.fields
        .filter((field) => field.layout === 'field-box' && !field.nativeFieldName)
        .reduce((groups, field) => {
          const key = `${field.page}:${Math.round(field.yRatio * 500)}`
          const line = groups.get(key) ?? []
          line.push(field)
          groups.set(key, line)
          return groups
        }, new Map<string, typeof detected.fields>())
      for (const line of lines.values()) {
        const ordered = [...line].sort((left, right) => left.xRatio - right.xRatio)
        for (let index = 0; index < ordered.length - 1; index += 1) {
          const current = ordered[index]
          const next = ordered[index + 1]
          if (current.xRatio + current.widthRatio > next.xRatio + .001) {
            failures.push(`${form.code}: ${current.label} overlaps ${next.label} on page ${current.page}`)
          }
        }
      }
    }

    expect(detectedFieldCount).toBeGreaterThanOrEqual(placeholderCount)
    expect(failures).toEqual([])
  }, 120_000)
})

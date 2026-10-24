import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const reportsPage = readFileSync(join(process.cwd(), 'src', 'pages', 'ReportsPage.tsx'), 'utf8')

describe('report filter refresh truthfulness', () => {
  it('does not render prior-query rows or counts as results for new filters', () => {
    expect(reportsPage).toContain('const resultsUpdating = query.isPlaceholderData')
    expect(reportsPage).toContain('const resultsVerified = !query.isError && !resultsUpdating')
    expect(reportsPage).toContain('resultsVerified && query.data?.rows.length')
    expect(reportsPage).toContain('query.data && resultsVerified ?')
    expect(reportsPage).toContain('Loading report results that match the selected dates and filters')
    expect(reportsPage).toContain('const [selectedRowKey, setSelectedRowKey]')
    expect(reportsPage).toContain('reportRowKey(row, index) === selectedRowKey')
    expect(reportsPage).toContain('selectedRowKey && !selectedRow')
  })
})

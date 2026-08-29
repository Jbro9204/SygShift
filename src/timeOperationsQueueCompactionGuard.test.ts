/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const operationsPage = readFileSync(join(root, 'src', 'time', 'TimeOperationsPage.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src', 'App.css'), 'utf8')

describe('time operations exception queue compaction', () => {
  it('shows ten exceptions initially and reveals more only in controlled batches', () => {
    expect(operationsPage).toContain('const EXCEPTION_QUEUE_BATCH_SIZE = 10')
    expect(operationsPage).toContain('unresolved.slice(0, exceptionVisibleCount)')
    expect(operationsPage).toContain('Show next {Math.min(EXCEPTION_QUEUE_BATCH_SIZE, hiddenExceptionCount)}')
    expect(operationsPage).toContain('Show first 10')
    expect(operationsPage).not.toContain('unresolved.map((exception)')
  })

  it('uses a compact queue layout with responsive controls', () => {
    expect(styles).toContain('.time-operations-panel--compact-queue .time-workflow-row--compact')
    expect(styles).toContain('.time-operations-queue-controls')
    expect(styles).toContain('.time-operations-queue-controls .time-button')
  })
})

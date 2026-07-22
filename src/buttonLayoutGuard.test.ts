/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const availabilityPage = readFileSync(join(root, 'src', 'pages', 'AvailabilityPage.tsx'), 'utf8')

function blockFor(selector: string): string {
  const start = appCss.indexOf(selector)
  if (start === -1) return ''
  const open = appCss.indexOf('{', start)
  const close = appCss.indexOf('}', open)
  return appCss.slice(open + 1, close)
}

function blocksFor(selector: string): string[] {
  const blocks: string[] = []
  let start = appCss.indexOf(selector)
  while (start !== -1) {
    const open = appCss.indexOf('{', start)
    const close = appCss.indexOf('}', open)
    blocks.push(appCss.slice(open + 1, close))
    start = appCss.indexOf(selector, close)
  }
  return blocks
}

describe('button layout guardrails', () => {
  it('keeps shared buttons bounded without forcing every primary action full-width', () => {
    const baseButtonBlock = blockFor('.primary-action,\n.secondary-button,\n.icon-button')

    expect(baseButtonBlock).toContain('box-sizing: border-box')
    expect(baseButtonBlock).toContain('max-width: 100%')
    expect(baseButtonBlock).toContain('line-height: 1.2')
    expect(appCss).not.toMatch(/(^|\n)\s*\.primary-action\s*\{\s*width:\s*100%;\s*\}/)
  })

  it('keeps repeated action rows wrapped and shrink-safe', () => {
    expect(blockFor('.approval-actions')).toContain('flex-wrap: wrap')
    expect(blockFor('.history-row__actions')).toContain('flex-wrap: wrap')

    const approvalChildBlock = blockFor('.approval-actions > *')
    expect(approvalChildBlock).toContain('min-width: 0')
    expect(approvalChildBlock).toContain('width: auto')
  })

  it('keeps Availability approvals on a local page-specific action wrapper', () => {
    expect(availabilityPage).toContain('approval-actions availability-actions')
    expect(blocksFor('.availability-actions').some((block) => block.includes('flex-direction: column'))).toBe(true)
    expect(blocksFor('.availability-actions').some((block) => block.includes('flex-direction: row'))).toBe(true)
    expect(appCss).toContain('.availability-actions .primary-action')
    expect(appCss).toContain('.availability-actions .secondary-button')
  })
})

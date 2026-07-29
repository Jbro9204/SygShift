/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const accessControlPage = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const availabilityPage = readFileSync(join(root, 'src', 'pages', 'AvailabilityPage.tsx'), 'utf8')
const licensingCenterPage = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const userAdminPage = readFileSync(join(root, 'src', 'pages', 'UserAdminPage.tsx'), 'utf8')

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

function topLevelBlockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = appCss.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  return match?.[1] ?? ''
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
    expect(availabilityPage).toContain('className="availability-card__actions"')
    expect(availabilityPage).toContain('className="availability-form__actions"')
    expect(availabilityPage).not.toContain('approval-actions availability-actions')
    expect(availabilityPage).toMatch(
      /<div className="availability-form__actions">\s*<button className="primary-action" disabled=\{submitMutation\.isPending\} type="submit">/,
    )

    expect(blocksFor('.availability-card__actions').some((block) => block.includes('flex-direction: column'))).toBe(true)
    expect(blocksFor('.availability-card__actions').some((block) => block.includes('flex-direction: row'))).toBe(true)
    expect(appCss).toContain('.availability-card__actions .primary-action')
    expect(appCss).toContain('.availability-card__actions .secondary-button')
    expect(appCss).toContain('.availability-form__actions .primary-action')
  })

  it('keeps Availability form controls inside the narrow Add Availability card', () => {
    expect(availabilityPage).toContain('request-form-card availability-form-card')
    expect(availabilityPage).toContain('request-form availability-form')

    expect(blockFor('.availability-form .form-grid')).toContain('grid-template-columns: minmax(0, 1fr)')

    const availabilityControlsBlock = blockFor(
      '.availability-form input,\n.availability-form select,\n.availability-form textarea',
    )
    expect(availabilityControlsBlock).toContain('box-sizing: border-box')
    expect(availabilityControlsBlock).toContain('max-width: 100%')
    expect(availabilityControlsBlock).toContain('min-width: 0')
  })

  it('keeps Roles & Permissions actions on a local uniform button system', () => {
    expect(accessControlPage).not.toContain('className="primary-button"')
    expect(accessControlPage).not.toContain('className="secondary-button"')
    expect(accessControlPage).toContain('access-control-button access-control-button--primary')
    expect(accessControlPage).toContain('access-control-button access-control-button--secondary')
    expect(accessControlPage).toContain('access-save-status access-save-status--${saveStatusState}')
    expect(accessControlPage).toContain('Saving complete.')

    const accessButtonBlock = topLevelBlockFor('.access-control-button')
    expect(accessButtonBlock).toContain('box-sizing: border-box')
    expect(accessButtonBlock).toContain('width: auto')
    expect(accessButtonBlock).toContain('max-width: 100%')
    expect(accessButtonBlock).toContain('justify-content: center')

    expect(blockFor('.access-control-button--primary')).toContain('linear-gradient')
    expect(blockFor('.access-control-button--secondary')).toContain('background: #fffdfa')
    expect(blockFor('.access-save-status')).toContain('min-height: 42px')
    expect(blockFor('.access-save-status')).toContain('font-weight: 900')
  })

  it('keeps Licensing Center filters separated and actions icon-safe', () => {
    expect(licensingCenterPage).toContain('licensing-toolbar__filter--credential')
    expect(licensingCenterPage).toContain('licensing-toolbar__filter--employment')
    expect(licensingCenterPage).toContain('<X aria-hidden="true" size={17} />')
    expect(licensingCenterPage).toContain('<FolderOpen aria-hidden="true" size={15} />')
    expect(licensingCenterPage).toContain('<Pencil aria-hidden="true" size={15} />')

    const toolbarBlock = blockFor('.licensing-toolbar')
    expect(toolbarBlock).toContain('minmax(260px, 0.9fr)')
    expect(toolbarBlock).toContain('minmax(220px, 0.72fr)')
    expect(toolbarBlock).toContain('gap: 14px 16px')

    expect(blockFor('.licensing-toolbar .select-field')).toContain('min-width: 0')
    expect(blockFor('.licensing-toolbar .select-field span')).toContain('white-space: nowrap')

    const licensingButtonBlock = blockFor(
      '.page--licensing .primary-action,\n.page--licensing .secondary-button,\n.modal-dialog--licensing-profile .primary-action,\n.modal-dialog--licensing-profile .secondary-button,\n.licensing-form .primary-action,\n.licensing-form .secondary-button',
    )
    expect(licensingButtonBlock).toContain('gap: 8px')
    expect(licensingButtonBlock).toContain('min-width: 0')
    expect(licensingButtonBlock).toContain('white-space: normal')
    expect(licensingButtonBlock).not.toContain('min-width: max-content')
  })

  it('keeps recently deleted user retention compact and clearly labeled', () => {
    expect(userAdminPage).not.toContain('Admin retention')
    expect(userAdminPage).toContain('<p className="eyebrow">Audit</p>')
    expect(userAdminPage).toContain('14-day retention')
    expect(userAdminPage).toContain('recently-deleted-panel--users')
    expect(userAdminPage).toContain('recently-deleted-panel--empty')
    expect(userAdminPage).toContain('No recently deleted users')

    expect(blockFor('.recently-deleted-panel--users')).toContain('max-width: 760px')
    expect(blockFor('.recently-deleted-panel--empty')).toContain('max-width: 620px')
    expect(blockFor('.recently-deleted-panel__heading h2')).toContain('font-size: 18px')
    expect(blockFor('.recently-deleted-empty')).toContain('padding: 14px 16px 16px')
  })

  it('keeps Users & Access filters and actions separated in a real grid', () => {
    expect(userAdminPage).toContain('className="user-admin-toolbar"')
    expect(userAdminPage).toContain('<span role="columnheader">Account activity</span>')
    expect(userAdminPage).toContain('<AccountActivitySummary user={user} />')
    expect(userAdminPage).toContain('<AccountActivityPanel user={employee} />')

    const toolbarBlock = topLevelBlockFor('.user-admin-toolbar')
    expect(toolbarBlock).toContain('display: grid')
    expect(toolbarBlock).toContain('repeat(3, minmax(140px, 170px))')
    expect(toolbarBlock).toContain('auto auto')

    expect(blockFor('.user-admin-toolbar .select-field')).toContain('width: 100%')
    expect(blockFor('.user-admin-toolbar .select-field select')).toContain('min-width: 0')
    expect(blockFor('.user-admin-toolbar .primary-action,\n.user-admin-toolbar .secondary-button')).toContain('min-width: max-content')
    expect(blockFor('.account-activity-card dl div')).toContain('grid-template-columns')
  })

  it('keeps Employee Access modals purpose-sized and locally aligned', () => {
    expect(accessControlPage).toContain('access-modal access-modal--employee-menu')
    expect(accessControlPage).toContain('access-modal access-modal--employee-editor')
    expect(accessControlPage).toContain('modal-actions employee-access-menu-actions')

    expect(blockFor('.access-modal--employee-menu')).toContain('width: min(96vw, 820px)')
    expect(blockFor('.access-modal--employee-editor')).toContain('width: min(98vw, 1280px)')

    const menuActionsBlock = blockFor('.employee-access-menu-actions')
    expect(menuActionsBlock).toContain('justify-content: space-between')
    expect(menuActionsBlock).toContain('border-top: 1px solid var(--line)')

    expect(appCss).toContain('.employee-access-launcher {\n  gap: 18px;\n  padding: 22px;')
    expect(appCss).toContain('box-shadow: 0 14px 32px rgba(45, 32, 12, 0.08)')
  })
})

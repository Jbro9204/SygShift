/// <reference types="node" />

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const appCss = readFileSync(join(root, 'src', 'App.css'), 'utf8')
const accessControlPage = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const availabilityPage = readFileSync(join(root, 'src', 'pages', 'AvailabilityPage.tsx'), 'utf8')
const licensingCenterPage = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const navigation = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const employeeSelfScheduleScopeMigration = readFileSync(join(root, 'supabase', 'migrations', '20260729191000_employee_self_schedule_scope.sql'), 'utf8')
const scheduleSelfViewPermissionMigration = readFileSync(join(root, 'supabase', 'migrations', '20260824113000_schedule_self_view_permission.sql'), 'utf8')
const schedulerRemovalPersistenceMigration = readFileSync(join(root, 'supabase', 'migrations', '20260730183000_scheduler_removal_draft_persistence.sql'), 'utf8')
const supabaseClient = readFileSync(join(root, 'src', 'lib', 'supabase.ts'), 'utf8')
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
    expect(licensingCenterPage).toContain('<Pencil aria-hidden="true" size={17} />')
    expect(licensingCenterPage).toContain('Open credential profile')
    expect(licensingCenterPage).toContain('Credential worklist')
    expect(licensingCenterPage).not.toContain('Employee licensing list')
    expect(licensingCenterPage).toContain('Manage selected credential')
    expect(licensingCenterPage).toContain('credentialTemplateFromType')
    expect(licensingCenterPage).toContain('credentialChoices')
    expect(licensingCenterPage).toContain('Add credential / license')
    expect(licensingCenterPage).toContain('licensing-add-credential-panel')
    expect(licensingCenterPage).toContain('Open add/update form')
    expect(licensingCenterPage).toContain('Add this credential/license')
    expect(licensingCenterPage).toContain("title={credential.credentialId ? 'Manage credential/license' : 'Add credential/license'}")

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

    expect(appCss).not.toContain('.licensing-view-switch')
    expect(appCss).not.toContain('.licensing-employee-panel')
    expect(appCss).toContain('.licensing-add-credential-panel')
    expect(appCss).toContain('.licensing-credential-workspace')
    expect(appCss).toContain('.licensing-selected-credential__actions')

    expect(blockFor('.page--licensing')).toContain('max-width: 1760px')
    const addCredentialPanelBlocks = blocksFor('.licensing-add-credential-panel')
    expect(addCredentialPanelBlocks.some((block) => block.includes('grid-template-columns: minmax(0, 1fr) minmax(260px, 0.55fr) max-content'))).toBe(true)
    expect(addCredentialPanelBlocks.some((block) => block.includes('border-left: 4px solid #c9953d'))).toBe(true)
    expect(blocksFor('.licensing-profile-actions').some((block) => block.includes('justify-content: space-between'))).toBe(true)
    expect(blocksFor('.modal-dialog--licensing-profile').some((block) => block.includes('width: min(1280px, calc(100vw - 32px))'))).toBe(true)
    expect(blocksFor('.licensing-credential-workspace').some((block) => block.includes('grid-template-columns: minmax(360px, 0.42fr) minmax(0, 1fr)'))).toBe(true)
    expect(blockFor('.licensing-credential-picker-row')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(blockFor('.licensing-credential-picker-row > span')).not.toContain('overflow-wrap: anywhere')
    expect(blockFor('.licensing-credential-picker-row .licensing-status')).toContain('white-space: normal')
  })

  it('keeps multi-day shift creation sequential to avoid duplicate schedule revisions', () => {
    expect(schedulePage).toContain('for (const shiftDate of dates)')
    expect(schedulePage).not.toContain('Promise.all(dates.map((shiftDate) => createSupervisorOpenShift')
  })

  it('keeps multi-day assigned shift retries from failing on already-created dates', () => {
    expect(schedulePage).toContain('employeeAlreadyAssignedDateKeys(')
    expect(schedulePage).toContain('const latestScheduleResult = await scheduleQuery.refetch()')
    expect(schedulePage).toContain('const dates = requestedDates.filter((dateKey) => !skippedDateSet.has(dateKey))')
    expect(schedulePage).toContain('Already assigned dates skipped')
  })

  it('keeps destructive scheduler modal actions on the professional button system', () => {
    expect(schedulePage).toContain('className="primary-action danger-primary"')
    expect(schedulePage).toContain('Save removal to draft')
    expect(schedulePage).toContain('Open draft & save removal')

    const dangerBlock = blockFor('.danger-primary')
    expect(dangerBlock).toContain('display: inline-flex')
    expect(dangerBlock).toContain('min-height: 46px')
    expect(dangerBlock).toContain('border-radius: 8px')
    expect(dangerBlock).toContain('linear-gradient')
  })

  it('keeps scheduler workflow buttons and modals on the shared layout system', () => {
    expect(schedulePage).toContain('Copy week')
    expect(schedulePage).toContain('Notify employees')
    expect(schedulePage).toContain('modal-dialog--scheduler-workflow')
    expect(schedulePage).toContain('scheduler-workflow-modal')
    expect(schedulePage).toContain('scheduler-workflow-summary')

    const workspaceActionsBlock = blockFor(
      '.scheduler-workspace__actions .primary-action,\n.scheduler-workspace__actions .secondary-button',
    )
    expect(workspaceActionsBlock).toContain('min-height: 44px')
    expect(workspaceActionsBlock).toContain('gap: 8px')
    expect(workspaceActionsBlock).toContain('white-space: nowrap')

    expect(blockFor('.modal-dialog--scheduler-workflow')).toContain('width: min(920px, calc(100vw - 24px))')
    expect(blockFor('.scheduler-workflow-modal')).toContain('display: grid')
    expect(blockFor('.scheduler-workflow-summary')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(blockFor('.scheduler-workflow-modal .modal-actions .primary-action,\n.scheduler-workflow-modal .modal-actions .secondary-button')).toContain('min-height: 46px')
  })

  it('keeps scheduler removals in the same draft normalization pipeline as edit and publish', () => {
    expect(schedulerRemovalPersistenceMigration).toContain('private.remove_schedule_draft_shift_unmerged')
    expect(schedulerRemovalPersistenceMigration).toContain('perform private.normalize_schedule_duplicate_shift_blocks(result_schedule_id)')
    expect(schedulerRemovalPersistenceMigration).toContain('return public.get_weekly_schedule_payload(result_week)')
    expect(schedulePage).toContain('Removal saved to the working draft')
    expect(schedulePage).toContain("queryClient.invalidateQueries({ queryKey: ['weekly-schedule', weekKey] })")
    expect(schedulePage).toContain('removeDraftShiftMutation.reset()')
  })

  it('keeps employee self-schedule access visible but backend scoped', () => {
    expect(navigation).toContain("label: 'Schedule', path: '/schedule', icon: CalendarDays, permissions:")
    expect(schedulePage).toContain('const canViewTeamSchedule = sessionHasAnyPermission(sessionQuery.data, scheduleTeamViewPermissions)')
    expect(schedulePage).toContain("setScheduleView('employee')")
    expect(schedulePage).toContain("placeholder={canViewTeamSchedule ? 'Search sites or people' : 'Search your schedule'}")

    expect(employeeSelfScheduleScopeMigration).toContain('viewer_assignment.employee_id = viewer_employee_id')
    expect(employeeSelfScheduleScopeMigration).not.toContain('or not shift.requires_armed')
    expect(employeeSelfScheduleScopeMigration).toContain('Operations roles see team coverage')
    expect(scheduleSelfViewPermissionMigration).toContain("public.has_effective_permission('schedule.self.view')")
    expect(scheduleSelfViewPermissionMigration).toContain('viewer_assignment.employee_id = viewer_employee_id')
  })

  it('keeps trusted-device MFA headers attached without dropping Supabase auth headers', () => {
    expect(supabaseClient).toContain('export function attachTrustedDeviceHeader')
    expect(supabaseClient).toContain('new Headers(input instanceof Request ? input.headers : undefined)')
    expect(supabaseClient).toContain('new Headers(init?.headers).forEach((value, key) => {')
    expect(supabaseClient).toContain("headers.set('x-sygshift-trusted-device', trustedToken)")
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
    expect(toolbarBlock).toContain('repeat(4, minmax(140px, 1fr))')

    expect(userAdminPage).toContain('className="user-admin-toolbar__actions"')
    expect(blockFor('.user-admin-toolbar__actions')).toContain('display: flex')
    expect(blockFor('.user-admin-toolbar__actions')).toContain('flex-wrap: wrap')
    expect(blockFor('.user-admin-toolbar__actions')).toContain('grid-column: 1 / -1')
    expect(blockFor('.user-admin-toolbar .select-field')).toContain('width: 100%')
    expect(blockFor('.user-admin-toolbar .select-field select')).toContain('min-width: 0')
    expect(blockFor('.user-admin-toolbar .primary-action,\n.user-admin-toolbar .secondary-button')).toContain('min-width: max-content')
    expect(blockFor('.account-activity-card dl div')).toContain('grid-template-columns')
    expect(userAdminPage).toContain('Reset MFA setup')
    expect(userAdminPage).toContain('mfa-reset-confirmation__actions')
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

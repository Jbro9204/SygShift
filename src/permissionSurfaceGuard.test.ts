/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const navigationSource = readFileSync(join(root, 'src', 'app', 'navigation.ts'), 'utf8')
const accessPolicySource = readFileSync(join(root, 'src', 'app', 'accessPolicy.ts'), 'utf8')
const accessControlPage = readFileSync(join(root, 'src', 'pages', 'AccessControlPage.tsx'), 'utf8')
const appShell = readFileSync(join(root, 'src', 'components', 'AppShell.tsx'), 'utf8')
const peoplePage = readFileSync(join(root, 'src', 'pages', 'PeoplePage.tsx'), 'utf8')
const licensingCenterPage = readFileSync(join(root, 'src', 'pages', 'LicensingCenterPage.tsx'), 'utf8')
const schedulePage = readFileSync(join(root, 'src', 'pages', 'SchedulePage.tsx'), 'utf8')
const announcementsPage = readFileSync(join(root, 'src', 'pages', 'AnnouncementsPage.tsx'), 'utf8')
const announcementsData = readFileSync(join(root, 'src', 'data', 'announcements.ts'), 'utf8')
const permissionSweepMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260729111500_permission_surface_sweep_repair.sql'),
  'utf8',
)
const routeRpcRepairMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260729113000_permission_route_rpc_repair.sql'),
  'utf8',
)
const workspaceAlertMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260729124500_workspace_alert_banner_audience.sql'),
  'utf8',
)
const employeeAnnouncementLaneMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260731162000_employee_announcement_delivery_lane.sql'),
  'utf8',
)
const timeClockLockMigration = readFileSync(
  join(root, 'supabase', 'migrations', '20260730170000_time_clock_transaction_lock.sql'),
  'utf8',
)

describe('permission surface guardrails', () => {
  it('wires permission-backed navigation for every permission-controlled workspace', () => {
    for (const permission of [
      'operations.view',
      'schedule.self.view',
      'schedule.view',
      'scheduler.view',
      'events.view',
      'time.view',
      'directory.view',
      'licensing.view',
      'availability.view',
      'sites.view',
      'patrol.view',
      'requests.view',
      'notifications.view',
      'reports.view',
      'admin.users.view',
      'admin.roles.view',
    ]) {
      expect(`${navigationSource}\n${accessPolicySource}`).toContain(permission)
    }
  })

  it('keeps Directory profile and availability access wired without bringing credential editing back into the Directory', () => {
    expect(navigationSource).toContain("permissions: ['directory.view', 'directory.edit_basic', 'availability.manage']")
    expect(peoplePage).toContain("sessionHasPermission(session, 'directory.edit_basic')")
    expect(peoplePage).toContain("sessionHasPermission(session, 'availability.manage')")
    expect(peoplePage).toContain('DirectoryProfileSnapshot')
    expect(peoplePage).toContain('DirectoryAvailabilityManager')
    expect(peoplePage).toContain('modal-dialog--directory-profile')
    expect(peoplePage).not.toContain("sessionHasPermission(session, 'directory.edit_credentials')")
    expect(peoplePage).not.toContain('DirectoryCredentialEditor')
    expect(peoplePage).not.toContain('CredentialSummary')
    expect(peoplePage).not.toContain('upsertDirectoryCredential')
    expect(permissionSweepMigration).toContain("public.has_effective_permission('directory.view')")
    expect(permissionSweepMigration).toContain("public.has_effective_permission('directory.edit_basic')")
    expect(permissionSweepMigration).toContain("public.has_effective_permission('directory.edit_credentials')")
    expect(permissionSweepMigration).toContain('Directory permission is required.')
    expect(permissionSweepMigration).toContain('Credential editor permission with MFA is required.')
  })

  it('keeps Licensing Center as the credential workspace without duplicating the Directory', () => {
    expect(licensingCenterPage).not.toContain('licensingView')
    expect(licensingCenterPage).not.toContain('visibleEmployees')
    expect(licensingCenterPage).not.toContain('Employee licensing list')
    expect(licensingCenterPage).not.toContain('licensing-employee-panel')
    expect(licensingCenterPage).toContain('Credential worklist')
    expect(licensingCenterPage).toContain('Open credential profile')
    expect(licensingCenterPage).toContain('licensing-credential-workspace')
    expect(licensingCenterPage).toContain('Choose credential/license')
    expect(licensingCenterPage).toContain('Manage selected credential')
    expect(licensingCenterPage).toContain('upsertLicensingCredential')
  })

  it('keeps permission search available in role editing and individual overrides', () => {
    expect(accessControlPage).toContain('permissionMatchesSearch')
    expect(accessControlPage).toContain('filterPermissions(permissions, permissionSearch)')
    expect(accessControlPage).toContain('Search permissions, categories, codes, or MFA')
    expect(accessControlPage).toContain('permission-search--workspace')
    expect(accessControlPage).toContain('Search permission to grant or deny')
    expect(accessControlPage).toContain('overridePermissions.length === 0')
  })

  it('keeps guard search available in scheduler assignment flows', () => {
    expect(schedulePage).toContain('builderEmployeeMatchesSearch')
    expect(schedulePage).toContain('manualEmployeeSearch')
    expect(schedulePage).toContain('openShiftEmployeeSearch')
    expect(schedulePage).toContain('filterBuilderEmployees(employees, manualEmployeeSearch, manualEmployeeId)')
    expect(schedulePage).toContain("placeholder=\"Search name, role, employment, or armed status\"")
    expect(schedulePage).toContain('filterBuilderEmployees(builderOptionsQuery.data?.employees ?? [], openShiftEmployeeSearch, openShiftForm.employeeId)')
    expect(schedulePage).toContain('No active guards match that search.')
  })

  it('allows scheduler option reads through scheduler permissions without reopening stale RPC overloads', () => {
    expect(permissionSweepMigration).toContain('create or replace function public.get_schedule_builder_options()')
    expect(permissionSweepMigration).toContain('private.can_manage_schedule_drafts()')
    expect(permissionSweepMigration).toContain("public.has_effective_permission('scheduler.view')")
    expect(permissionSweepMigration).toContain("employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')")
    expect(permissionSweepMigration).not.toContain('drop function if exists public.scheduler_update_draft_shift')
  })

  it('keeps scheduler view access separate from edit actions', () => {
    expect(schedulePage).toContain('const canBuildSchedule =')
    expect(schedulePage).toContain('const canManageSchedule =')
    expect(schedulePage).toContain('const canUseScheduler = canBuildSchedule && isSchedulerHome')
    expect(schedulePage).toContain('const canEditScheduler = canManageSchedule && isSchedulerHome')
    expect(schedulePage).toContain('{canUseScheduler ? (')
    expect(schedulePage).toContain('{canEditScheduler && builderOpen ?')
    expect(schedulePage).toContain('canEdit={canEditScheduler && !isHistoricalSchedulerWeek}')
    expect(schedulePage).toContain('canResolve={canEditScheduler && !isHistoricalSchedulerWeek}')
  })

  it('keeps route RPCs permission-aware beyond hard-coded app roles', () => {
    for (const permission of [
      'availability.manage',
      'events.manage',
      'shift_pool.manage',
      'reports.view',
      'notifications.view',
      'notifications.manage',
      'patrol.manage',
      'requests.manage',
      'time.view',
      'time.manage',
      'time.export_payroll',
    ]) {
      expect(routeRpcRepairMigration).toContain(`public.has_effective_permission('${permission}')`)
    }

    expect(routeRpcRepairMigration).toContain('SECURITY DEFINER')
    expect(routeRpcRepairMigration).toContain('Expected permission repair fragment was not found')
  })

  it('keeps permission-specific frontend controls wired to backend capability flags', () => {
    const availabilityData = readFileSync(join(root, 'src', 'data', 'availability.ts'), 'utf8')
    const notificationsPage = readFileSync(join(root, 'src', 'pages', 'NotificationsPage.tsx'), 'utf8')
    const requestsPage = readFileSync(join(root, 'src', 'pages', 'RequestsPage.tsx'), 'utf8')
    const timePage = readFileSync(join(root, 'src', 'pages', 'TimePage.tsx'), 'utf8')

    expect(availabilityData).toContain('canManage: z.boolean()')
    expect(notificationsPage).toContain('canManageNotifications')
    expect(requestsPage).toContain('requestQuery.data?.permissions.canManage')
    expect(timePage).toContain('getOwnTimekeepingReview')
    expect(timePage).toContain('function MyTimeHistory')
    expect(timePage).toContain('sessionCanManageTime(session)')
    expect(timePage).toContain('sessionCanExportPayroll(session)')
    expect(timePage).toContain('canPunch={punchAllowed}')
    expect(timePage).toContain('canExportPayroll ?')
    expect(timePage).toContain('canManageTime ? <TimeMaintenanceWorkbench')
  })

  it('keeps self-service time clock writes permission-backed and race-safe', () => {
    expect(timeClockLockMigration).toContain("public.has_effective_permission('time.punch')")
    expect(timeClockLockMigration).toContain("public.has_effective_permission('time.manage')")
    expect(timeClockLockMigration).toContain('Time clock permission is required to record time.')
    expect(timeClockLockMigration).toContain('pg_advisory_xact_lock(hashtextextended(actor_employee_id::text, 0))')
    expect(timeClockLockMigration).toContain('Clock out before starting another time session.')
  })

  it('keeps workspace announcement banners multi-entry and audience-aware', () => {
    expect(appShell).toContain('getActiveAnnouncementBanners')
    expect(appShell).toContain('WORKSPACE_ALERT_ROTATE_MS')
    expect(appShell).toContain('WorkspaceAlertStrip')
    expect(appShell).toContain('payroll-export-reminder-')
    expect(workspaceAlertMigration).toContain('public.get_active_announcement_banners()')
    expect(workspaceAlertMigration).toContain('private.announcement_banner_visible_to_current_user')
    expect(workspaceAlertMigration).toContain("banner.audience = 'supervisors'")
    expect(workspaceAlertMigration).toContain('target_audience_roles public.app_role[]')
  })

  it('keeps employee announcements out of the creator workspace while publishing them to the front-page lane', () => {
    expect(navigationSource).toContain("permissions: ['announcements.send', 'announcements.banner.manage']")
    expect(navigationSource).not.toContain("permissions: ['announcements.view', 'announcements.send', 'announcements.banner.manage']")
    expect(announcementsPage).toContain('defaultAnnouncementExpirationLocal')
    expect(announcementsPage).toContain('Employee visibility')
    expect(announcementsPage).toContain('Visible until')
    expect(announcementsData).toContain('target_expires_at: options.expiresAt ?? null')
    expect(employeeAnnouncementLaneMigration).toContain('private.announcement_visible_to_current_user')
    expect(employeeAnnouncementLaneMigration).toContain('private.announcement_workspace_record')
    expect(employeeAnnouncementLaneMigration).toContain("coalesce(announcement.published_at, announcement.created_at) + interval '14 days'")
    expect(employeeAnnouncementLaneMigration).toContain("coalesce(announcement.template_key, '') <> 'welcome_to_sygshift'")
  })
})

import {
  BadgeCheck,
  BadgeDollarSign,
  BriefcaseBusiness,
  Bell,
  Building2,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  ListChecks,
  FileBarChart,
  Files,
  LayoutDashboard,
  MapPinned,
  Megaphone,
  Repeat2,
  ShieldCheck,
  Timer,
  Umbrella,
  HeartHandshake,
  GraduationCap,
  ShieldAlert,
  UserCog,
  UserRoundCheck,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { documentStudioAccessPermission, scheduleRoutePermissions } from './accessPolicy'
export interface NavigationItem {
  label: string
  path: string
  icon: LucideIcon
  permissions: string[]
}

export interface NavigationGroup {
  label: string
  items: NavigationItem[]
}

export const homeNavigationItem: NavigationItem = {
  label: 'Home',
  path: '/',
  icon: LayoutDashboard,
  permissions: ['operations.view'],
}

export const navigationGroups: NavigationGroup[] = [
  {
    label: 'Operations',
    items: [
      { label: 'Schedule', path: '/schedule', icon: CalendarDays, permissions: [...scheduleRoutePermissions] },
      { label: 'Scheduler', path: '/scheduler', icon: CalendarPlus, permissions: ['scheduler.view', 'scheduler.manage', 'schedule.manage'] },
      { label: 'Events & Openings', path: '/events', icon: CalendarClock, permissions: ['events.view', 'events.manage', 'shift_pool.view', 'shift_pool.manage'] },
      { label: 'Time & Attendance', path: '/time', icon: Timer, permissions: ['time.self.view', 'time.punch', 'time.view', 'time.manage', 'time.export_payroll'] },
      { label: 'Action Center', path: '/actions', icon: ListChecks, permissions: ['actions.self.view'] },
    ],
  },
  {
    label: 'Workforce',
    items: [
      { label: 'Directory', path: '/people', icon: UsersRound, permissions: ['directory.view', 'directory.edit_basic', 'availability.manage'] },
      { label: 'Licensing Center', path: '/licensing', icon: BadgeCheck, permissions: ['licensing.view', 'licensing.manage', 'licensing.configure', 'licensing.communicate', 'directory.edit_credentials'] },
      { label: 'My Documents', path: '/my-documents', icon: Files, permissions: [] },
      { label: 'Availability', path: '/availability', icon: CalendarCheck2, permissions: ['availability.view', 'availability.manage'] },
      { label: 'Sites & Posts', path: '/sites', icon: Building2, permissions: ['sites.view', 'sites.manage'] },
      { label: 'Client Directory', path: '/clients', icon: BriefcaseBusiness, permissions: ['clients.view', 'clients.manage'] },
      { label: 'Patrol', path: '/patrol', icon: MapPinned, permissions: ['patrol.self.view', 'patrol.view', 'patrol.manage', 'patrol.operations.view', 'patrol.routes.manage'] },
    ],
  },
  {
    label: 'HR & Finance',
    items: [
      {
        label: 'People & HR',
        path: '/hr',
        icon: UsersRound,
        permissions: ['hr.people.view', 'hr.people.manage'],
      },
      {
        label: 'Document Studio',
        path: '/hr/documents',
        icon: Files,
        permissions: [documentStudioAccessPermission],
      },
      {
        label: 'Recruiting',
        path: '/hr/recruiting',
        icon: BriefcaseBusiness,
        permissions: ['hr.recruiting.view'],
      },
      {
        label: 'Onboarding',
        path: '/hr/onboarding',
        icon: UserRoundCheck,
        permissions: ['hr.onboarding.view'],
      },
      {
        label: 'Leave Administration',
        path: '/hr/leave',
        icon: Umbrella,
        permissions: ['hr.leave.view'],
      },
      {
        label: 'Benefits',
        path: '/hr/benefits',
        icon: HeartHandshake,
        permissions: ['hr.benefits.view'],
      },
      {
        label: 'Compensation',
        path: '/hr/compensation',
        icon: BadgeDollarSign,
        permissions: ['hr.compensation.view'],
      },
      {
        label: 'Talent & Learning',
        path: '/hr/talent-learning',
        icon: GraduationCap,
        permissions: ['hr.talent.view', 'hr.learning.view'],
      },
      {
        label: 'Cases, Safety & Assets',
        path: '/hr/cases-compliance',
        icon: ShieldAlert,
        permissions: ['hr.cases.view', 'hr.safety.view', 'hr.assets.view'],
      },
      {
        label: 'Employee Lifecycle',
        path: '/hr/offboarding',
        icon: Repeat2,
        permissions: ['hr.offboarding.view'],
      },
      {
        label: 'HR Self-Service',
        path: '/hr/self-service',
        icon: UserCog,
        permissions: ['hr.self_service.view'],
      },
      {
        label: 'HR Reporting',
        path: '/hr/reporting',
        icon: FileBarChart,
        permissions: ['hr.reporting.view'],
      },
      {
        label: 'Payroll Integration',
        path: '/hr/payroll-integration',
        icon: ShieldCheck,
        permissions: ['hr.payroll_integration.view'],
      },
      {
        label: 'Time-Off Requests',
        path: '/requests',
        icon: ClipboardCheck,
        permissions: ['requests.view', 'requests.manage'],
      },
      {
        label: 'Payroll',
        path: '/payroll',
        icon: BadgeDollarSign,
        permissions: ['time.view', 'time.manage', 'time.export_payroll'],
      },
      {
        label: 'Employment Data Readiness',
        path: '/hr/identity-readiness',
        icon: UserRoundCheck,
        permissions: ['hr.people.manage'],
      },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Announcements', path: '/announcements', icon: Megaphone, permissions: ['announcements.send', 'announcements.banner.manage'] },
      { label: 'Notifications', path: '/notifications', icon: Bell, permissions: ['notifications.view', 'notifications.manage'] },
      { label: 'Reports', path: '/reports', icon: FileBarChart, permissions: ['reports.view', 'time.reports.view', 'clients.activity.view'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'Users & Roles',
        path: '/administration/access',
        icon: UserCog,
        permissions: ['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.invite', 'admin.users.password_reset', 'admin.users.separate', 'admin.users.delete', 'admin.roles.view', 'admin.roles.manage'],
      },
      {
        label: 'System Operations',
        path: '/system-operations',
        icon: Wrench,
        permissions: ['admin.maintenance.manage'],
      },
    ],
  },
]

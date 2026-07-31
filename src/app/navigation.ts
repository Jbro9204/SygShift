import {
  BadgeCheck,
  Bell,
  Building2,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  FileBarChart,
  LayoutDashboard,
  MapPinned,
  Megaphone,
  ShieldCheck,
  Timer,
  UserCog,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import type { AppRole } from '../data/session'

export const OPERATIONS_ROLES: AppRole[] = ['dispatcher', 'scheduler', 'supervisor', 'admin']
export const LICENSING_ROLES: AppRole[] = ['recruiting_licensing', 'admin']
export const ALL_EMPLOYEE_ROLES: AppRole[] = ['guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin']

export interface NavigationItem {
  label: string
  path: string
  icon: LucideIcon
  roles?: AppRole[]
  permission?: string
  permissions?: string[]
}

export interface NavigationGroup {
  label: string
  items: NavigationItem[]
}

export const navigationGroups: NavigationGroup[] = [
  {
    label: 'Operations',
    items: [
      { label: 'Overview', path: '/', icon: LayoutDashboard, permissions: ['operations.view'] },
      { label: 'Schedule', path: '/schedule', icon: CalendarDays, roles: ALL_EMPLOYEE_ROLES, permissions: ['schedule.view', 'schedule.manage', 'schedule.publish', 'schedule.delete_shift', 'schedule.override_warnings'] },
      { label: 'Scheduler', path: '/scheduler', icon: CalendarPlus, roles: OPERATIONS_ROLES, permissions: ['scheduler.view', 'scheduler.manage', 'schedule.manage'] },
      { label: 'Events & Openings', path: '/events', icon: CalendarClock, roles: ALL_EMPLOYEE_ROLES, permissions: ['events.view', 'events.manage', 'shift_pool.view', 'shift_pool.manage'] },
      { label: 'Time & Attendance', path: '/time', icon: Timer, roles: ALL_EMPLOYEE_ROLES, permissions: ['time.self.view', 'time.punch', 'time.view', 'time.manage', 'time.export_payroll'] },
    ],
  },
  {
    label: 'Workforce',
    items: [
      { label: 'Directory', path: '/people', icon: UsersRound, roles: OPERATIONS_ROLES, permissions: ['directory.view', 'directory.edit_basic', 'availability.manage'] },
      { label: 'Licensing Center', path: '/licensing', icon: BadgeCheck, roles: LICENSING_ROLES, permissions: ['licensing.view', 'licensing.manage', 'licensing.configure', 'licensing.communicate'] },
      { label: 'Availability', path: '/availability', icon: CalendarCheck2, permissions: ['availability.view', 'availability.manage'] },
      { label: 'Sites & Posts', path: '/sites', icon: Building2, roles: OPERATIONS_ROLES, permissions: ['sites.view', 'sites.manage'] },
      { label: 'Patrol', path: '/patrol', icon: MapPinned, permissions: ['patrol.view', 'patrol.manage'] },
      { label: 'Time-Off Requests', path: '/requests', icon: ClipboardCheck, roles: ALL_EMPLOYEE_ROLES, permissions: ['requests.view', 'requests.manage'] },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Announcements', path: '/announcements', icon: Megaphone, roles: OPERATIONS_ROLES, permissions: ['announcements.view', 'announcements.send', 'announcements.banner.manage'] },
      { label: 'Notifications', path: '/notifications', icon: Bell, roles: OPERATIONS_ROLES, permissions: ['notifications.view', 'notifications.manage'] },
      { label: 'Reports', path: '/reports', icon: FileBarChart, roles: OPERATIONS_ROLES, permissions: ['reports.view', 'reports.export'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'Users & Access',
        path: '/users',
        icon: UserCog,
        roles: ['admin'],
        permissions: ['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.separate', 'admin.users.delete'],
      },
      {
        label: 'Roles & Permissions',
        path: '/access-control',
        icon: ShieldCheck,
        roles: ['admin'],
        permissions: ['admin.roles.view', 'admin.roles.manage'],
      },
    ],
  },
]

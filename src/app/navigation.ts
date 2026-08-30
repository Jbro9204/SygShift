import {
  BadgeCheck,
  BadgeDollarSign,
  Bell,
  Building2,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  ListChecks,
  FileBarChart,
  LayoutDashboard,
  MapPinned,
  Megaphone,
  ShieldCheck,
  Timer,
  UserCog,
  UserRoundCheck,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { scheduleRoutePermissions } from './accessPolicy'
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
      { label: 'Availability', path: '/availability', icon: CalendarCheck2, permissions: ['availability.view', 'availability.manage'] },
      { label: 'Sites & Posts', path: '/sites', icon: Building2, permissions: ['sites.view', 'sites.manage'] },
      { label: 'Patrol', path: '/patrol', icon: MapPinned, permissions: ['patrol.view', 'patrol.manage'] },
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
      { label: 'Reports', path: '/reports', icon: FileBarChart, permissions: ['time.reports.view'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'User Accounts',
        path: '/users',
        icon: UserCog,
        permissions: ['admin.users.view', 'admin.users.basic', 'admin.users.manage', 'admin.users.invite', 'admin.users.separate', 'admin.users.delete'],
      },
      {
        label: 'Roles & Permissions',
        path: '/access-control',
        icon: ShieldCheck,
        permissions: ['admin.roles.view', 'admin.roles.manage'],
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

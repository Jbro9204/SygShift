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

export interface NavigationItem {
  label: string
  path: string
  icon: LucideIcon
  roles?: AppRole[]
  permission?: string
}

export interface NavigationGroup {
  label: string
  items: NavigationItem[]
}

export const navigationGroups: NavigationGroup[] = [
  {
    label: 'Operations',
    items: [
      { label: 'Overview', path: '/', icon: LayoutDashboard },
      { label: 'Schedule', path: '/schedule', icon: CalendarDays },
      { label: 'Scheduler', path: '/scheduler', icon: CalendarPlus, roles: OPERATIONS_ROLES },
      { label: 'Events & Openings', path: '/events', icon: CalendarClock },
      { label: 'Time & Attendance', path: '/time', icon: Timer },
    ],
  },
  {
    label: 'Workforce',
    items: [
      { label: 'Directory', path: '/people', icon: UsersRound, roles: OPERATIONS_ROLES },
      { label: 'Licensing Center', path: '/licensing', icon: BadgeCheck, roles: LICENSING_ROLES },
      { label: 'Availability', path: '/availability', icon: CalendarCheck2 },
      { label: 'Sites & Posts', path: '/sites', icon: Building2, roles: OPERATIONS_ROLES },
      { label: 'Patrol', path: '/patrol', icon: MapPinned },
      { label: 'Time-Off Requests', path: '/requests', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Announcements', path: '/announcements', icon: Megaphone, roles: OPERATIONS_ROLES },
      { label: 'Notifications', path: '/notifications', icon: Bell, roles: OPERATIONS_ROLES },
      { label: 'Reports', path: '/reports', icon: FileBarChart, roles: OPERATIONS_ROLES },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users & Access', path: '/users', icon: UserCog, roles: ['admin'], permission: 'admin.users.view' },
      { label: 'Roles & Permissions', path: '/access-control', icon: ShieldCheck, roles: ['admin'], permission: 'admin.roles.view' },
    ],
  },
]

import {
  Bell,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  ClipboardCheck,
  Database,
  FileBarChart,
  LayoutDashboard,
  ListChecks,
  MapPinned,
  Megaphone,
  Timer,
  UserCog,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import type { AppRole } from '../data/session'

export const OPERATIONS_ROLES: AppRole[] = ['dispatcher', 'supervisor', 'admin']

export interface NavigationItem {
  label: string
  path: string
  icon: LucideIcon
  roles?: AppRole[]
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
      { label: 'Master schedule', path: '/schedule', icon: CalendarDays },
      { label: 'Scheduler', path: '/scheduler', icon: CalendarPlus, roles: ['dispatcher', 'supervisor', 'admin'] },
      { label: 'Events & openings', path: '/events', icon: CalendarClock },
      { label: 'Time & attendance', path: '/time', icon: Timer },
    ],
  },
  {
    label: 'Workforce',
    items: [
      { label: 'People', path: '/people', icon: UsersRound, roles: OPERATIONS_ROLES },
      { label: 'Sites & posts', path: '/sites', icon: Building2, roles: OPERATIONS_ROLES },
      { label: 'Patrol', path: '/patrol', icon: MapPinned },
      { label: 'Requests', path: '/requests', icon: ClipboardCheck },
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
      { label: 'Users & access', path: '/users', icon: UserCog, roles: ['admin'] },
      { label: 'Import review', path: '/import-review', icon: Database, roles: ['admin'] },
      { label: 'Operational import', path: '/operational-import', icon: ListChecks, roles: ['admin'] },
    ],
  },
]

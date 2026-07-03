import {
  Bell,
  Building2,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  Database,
  FileBarChart,
  LayoutDashboard,
  ListChecks,
  MapPinned,
  Megaphone,
  Timer,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import type { AppRole } from '../data/session'

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
      { label: 'Events & openings', path: '/events', icon: CalendarClock },
      { label: 'Time & attendance', path: '/time', icon: Timer },
    ],
  },
  {
    label: 'Workforce',
    items: [
      { label: 'People', path: '/people', icon: UsersRound },
      { label: 'Sites & posts', path: '/sites', icon: Building2 },
      { label: 'Patrol', path: '/patrol', icon: MapPinned },
      { label: 'Requests', path: '/requests', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Communication',
    items: [
      { label: 'Announcements', path: '/announcements', icon: Megaphone },
      { label: 'Notifications', path: '/notifications', icon: Bell },
      { label: 'Reports', path: '/reports', icon: FileBarChart },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Import review', path: '/import-review', icon: Database, roles: ['admin'] },
      { label: 'Operational import', path: '/operational-import', icon: ListChecks, roles: ['admin'] },
    ],
  },
]

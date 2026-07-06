import { lazy, Suspense, type ReactNode } from 'react'

export const AccountSecurityPageRoute = lazy(() =>
  import('../pages/AccountSecurityPage').then((module) => ({ default: module.AccountSecurityPage })),
)
export const AnnouncementsPageRoute = lazy(() =>
  import('../pages/AnnouncementsPage').then((module) => ({ default: module.AnnouncementsPage })),
)
export const EventsPageRoute = lazy(() =>
  import('../pages/EventsPage').then((module) => ({ default: module.EventsPage })),
)
export const ImportReviewPageRoute = lazy(() =>
  import('../pages/ImportReviewPage').then((module) => ({ default: module.ImportReviewPage })),
)
export const LoginPageRoute = lazy(() =>
  import('../pages/LoginPage').then((module) => ({ default: module.LoginPage })),
)
export const OperationalImportPageRoute = lazy(() =>
  import('../pages/OperationalImportPage').then((module) => ({ default: module.OperationalImportPage })),
)
export const NotificationsPageRoute = lazy(() =>
  import('../pages/NotificationsPage').then((module) => ({ default: module.NotificationsPage })),
)
export const OverviewPageRoute = lazy(() =>
  import('../pages/OverviewPage').then((module) => ({ default: module.OverviewPage })),
)
export const PeoplePageRoute = lazy(() =>
  import('../pages/PeoplePage').then((module) => ({ default: module.PeoplePage })),
)
export const PatrolPageRoute = lazy(() =>
  import('../pages/PatrolPage').then((module) => ({ default: module.PatrolPage })),
)
export const RequestsPageRoute = lazy(() =>
  import('../pages/RequestsPage').then((module) => ({ default: module.RequestsPage })),
)
export const ReportsPageRoute = lazy(() =>
  import('../pages/ReportsPage').then((module) => ({ default: module.ReportsPage })),
)
export const SchedulePageRoute = lazy(() =>
  import('../pages/SchedulePage').then((module) => ({ default: module.SchedulePage })),
)
export const SchedulerPageRoute = lazy(() =>
  import('../pages/SchedulePage').then((module) => ({ default: module.SchedulerPage })),
)
export const SitesPageRoute = lazy(() =>
  import('../pages/SitesPage').then((module) => ({ default: module.SitesPage })),
)
export const TimePageRoute = lazy(() =>
  import('../pages/TimePage').then((module) => ({ default: module.TimePage })),
)
export const UserAdminPageRoute = lazy(() =>
  import('../pages/UserAdminPage').then((module) => ({ default: module.UserAdminPage })),
)

function RouteFallback() {
  return (
    <section aria-live="polite" className="route-loading" role="status">
      <p>Loading workspace…</p>
    </section>
  )
}

export function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>
}

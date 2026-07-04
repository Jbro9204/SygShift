import { lazy, Suspense, type ReactNode } from 'react'

export const AccountSecurityPageRoute = lazy(() =>
  import('../pages/AccountSecurityPage').then((module) => ({ default: module.AccountSecurityPage })),
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
export const OverviewPageRoute = lazy(() =>
  import('../pages/OverviewPage').then((module) => ({ default: module.OverviewPage })),
)
export const PeoplePageRoute = lazy(() =>
  import('../pages/PeoplePage').then((module) => ({ default: module.PeoplePage })),
)
export const RequestsPageRoute = lazy(() =>
  import('../pages/RequestsPage').then((module) => ({ default: module.RequestsPage })),
)
export const SchedulePageRoute = lazy(() =>
  import('../pages/SchedulePage').then((module) => ({ default: module.SchedulePage })),
)
export const SitesPageRoute = lazy(() =>
  import('../pages/SitesPage').then((module) => ({ default: module.SitesPage })),
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

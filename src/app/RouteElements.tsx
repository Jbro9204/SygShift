import { lazy, Suspense, type ReactNode } from 'react'

export const AccountSecurityPageRoute = lazy(() =>
  import('../pages/AccountSecurityPage').then((module) => ({ default: module.AccountSecurityPage })),
)
export const MyAccountPageRoute = lazy(() =>
  import('../pages/MyAccountPage').then((module) => ({ default: module.MyAccountPage })),
)
export const ActionCenterPageRoute = lazy(() =>
  import('../pages/ActionCenterPage').then((module) => ({ default: module.ActionCenterPage })),
)
export const AccessControlPageRoute = lazy(() =>
  import('../pages/AccessControlPage').then((module) => ({ default: module.AccessControlPage })),
)
export const AnnouncementsPageRoute = lazy(() =>
  import('../pages/AnnouncementsPage').then((module) => ({ default: module.AnnouncementsPage })),
)
export const AvailabilityPageRoute = lazy(() =>
  import('../pages/AvailabilityPage').then((module) => ({ default: module.AvailabilityPage })),
)
export const EventsPageRoute = lazy(() =>
  import('../pages/EventsPage').then((module) => ({ default: module.EventsPage })),
)
export const LoginPageRoute = lazy(() =>
  import('../pages/LoginPage').then((module) => ({ default: module.LoginPage })),
)
export const LicensingCenterPageRoute = lazy(() =>
  import('../pages/LicensingCenterPage').then((module) => ({ default: module.LicensingCenterPage })),
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
export const TimeWorkspaceRoute = lazy(() =>
  import('../time/TimeWorkspace').then((module) => ({ default: module.TimeWorkspace })),
)
export const TimeToolsPageRoute = lazy(() =>
  import('../time/TimeLegacyRedirects').then((module) => ({ default: module.LegacyTimeToolsRedirect })),
)
export const TimeMyTimePageRoute = lazy(() =>
  import('../time/MyTimePage').then((module) => ({ default: module.MyTimePage })),
)
export const TimeTeamPageRoute = lazy(() =>
  import('../time/TimeTeamAttendancePage').then((module) => ({ default: module.TimeTeamAttendancePage })),
)
export const TimeExceptionsPageRoute = lazy(() =>
  import('../time/TimeExceptionsPage').then((module) => ({ default: module.TimeExceptionsPage })),
)
export const TimeExceptionsLegacyRoute = lazy(() =>
  import('../time/TimeLegacyRedirects').then((module) => ({ default: module.LegacyTimeExceptionsRedirect })),
)
export const TimeOperationsPageRoute = lazy(() =>
  import('../time/TimeOperationsPage').then((module) => ({ default: module.TimeOperationsPage })),
)
export const TimeDailyAttendancePageRoute = lazy(() =>
  import('../time/DailyAttendanceReviewPage').then((module) => ({ default: module.DailyAttendanceReviewPage })),
)
export const TimeAccountabilityPageRoute = lazy(() =>
  import('../time/AccountabilityPage').then((module) => ({ default: module.AccountabilityPage })),
)
export const TimeTimecardsPageRoute = lazy(() =>
  import('../time/TimeLegacyRedirects').then((module) => ({ default: module.LegacyTimecardsRedirect })),
)
export const TimePayrollPageRoute = lazy(() =>
  import('../time/TimePayrollPage').then((module) => ({ default: module.TimePayrollPage })),
)
export const TimeRulesPageRoute = lazy(() =>
  import('../time/TimeCommandCenterPage').then((module) => ({
    default: () => <module.TimeFuturePage area="Time Rules" />,
  })),
)
export const UserAdminPageRoute = lazy(() =>
  import('../pages/UserAdminPage').then((module) => ({ default: module.UserAdminPage })),
)
export const SystemOperationsPageRoute = lazy(() =>
  import('../pages/SystemOperationsPage').then((module) => ({ default: module.SystemOperationsPage })),
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

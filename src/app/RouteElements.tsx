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
export const TimeOnDutyPageRoute = lazy(() =>
  import('../time/TimeOnDutyPage').then((module) => ({ default: module.TimeOnDutyPage })),
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
export const PayrollLegacyExportRoute = lazy(() =>
  import('../payroll/PayrollLegacyRedirects').then((module) => ({ default: module.PayrollLegacyExportRedirect })),
)
export const PayrollLegacyRulesRoute = lazy(() =>
  import('../payroll/PayrollLegacyRedirects').then((module) => ({ default: module.PayrollLegacyRulesRedirect })),
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
export const HrisIdentityReadinessPageRoute = lazy(() =>
  import('../pages/HrisIdentityReadinessPage').then((module) => ({ default: module.HrisIdentityReadinessPage })),
)
export const HrisPeopleWorkspacePageRoute = lazy(() =>
  import('../pages/HrisPeopleWorkspacePage').then((module) => ({ default: module.HrisPeopleWorkspacePage })),
)
export const HrisEmployeeFilePageRoute = lazy(() =>
  import('../pages/HrisEmployeeFilePage').then((module) => ({ default: module.HrisEmployeeFilePage })),
)
export const HrisDocumentsPageRoute = lazy(() =>
  import('../pages/HrisDocumentsPage').then((module) => ({ default: module.HrisDocumentsPage })),
)
export const HrisDocumentWorkflowsPageRoute = lazy(() =>
  import('../pages/HrisDocumentWorkflowsPage').then((module) => ({ default: module.HrisDocumentWorkflowsPage })),
)
export const HrisAutomationPageRoute = lazy(() =>
  import('../pages/HrisAutomationPage').then((module) => ({ default: module.HrisAutomationPage })),
)
export const HrisRecruitingPageRoute = lazy(() =>
  import('../pages/HrisRecruitingPage').then((module) => ({ default: module.HrisRecruitingPage })),
)
export const HrisOnboardingPageRoute = lazy(() =>
  import('../pages/HrisOnboardingPage').then((module) => ({ default: module.HrisOnboardingPage })),
)
export const HrisLeavePageRoute = lazy(() =>
  import('../pages/HrisStage7Page').then((module) => ({ default: module.HrisLeavePage })),
)
export const HrisBenefitsPageRoute = lazy(() =>
  import('../pages/HrisStage7Page').then((module) => ({ default: module.HrisBenefitsPage })),
)
export const HrisCompensationPageRoute = lazy(() =>
  import('../pages/HrisStage7Page').then((module) => ({ default: module.HrisCompensationPage })),
)
export const HrisTalentLearningPageRoute = lazy(() =>
  import('../pages/HrisStage8Page').then((module) => ({ default: module.HrisTalentLearningPage })),
)
export const HrisCasesCompliancePageRoute = lazy(() =>
  import('../pages/HrisStage8Page').then((module) => ({ default: module.HrisCasesCompliancePage })),
)
export const HrisOffboardingPageRoute = lazy(() =>
  import('../pages/HrisStage9Page').then((module) => ({ default: module.HrisOffboardingPage })),
)
export const HrisSelfServicePageRoute = lazy(() =>
  import('../pages/HrisStage9Page').then((module) => ({ default: module.HrisSelfServicePage })),
)
export const HrisReportingPageRoute = lazy(() =>
  import('../pages/HrisStage9Page').then((module) => ({ default: module.HrisReportingPage })),
)
export const HrisPayrollIntegrationPageRoute = lazy(() =>
  import('../pages/HrisPayrollIntegrationPage').then((module) => ({ default: module.HrisPayrollIntegrationPage })),
)
export const MyDocumentsPageRoute = lazy(() =>
  import('../pages/MyDocumentsPage').then((module) => ({ default: module.MyDocumentsPage })),
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

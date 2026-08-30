import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { RouteErrorPage } from '../pages/RouteErrorPage'
import {
  AccountSecurityPageRoute,
  MyAccountPageRoute,
  MyDocumentsPageRoute,
  ActionCenterPageRoute,
  AccessControlPageRoute,
  AnnouncementsPageRoute,
  AvailabilityPageRoute,
  EventsPageRoute,
  HrisIdentityReadinessPageRoute,
  HrisAutomationPageRoute,
  HrisRecruitingPageRoute,
  HrisOnboardingPageRoute,
  HrisLeavePageRoute,
  HrisBenefitsPageRoute,
  HrisCompensationPageRoute,
  HrisTalentLearningPageRoute,
  HrisCasesCompliancePageRoute,
  HrisDocumentsPageRoute,
  HrisDocumentWorkflowsPageRoute,
  HrisPeopleWorkspacePageRoute,
  HrisEmployeeFilePageRoute,
  LoginPageRoute,
  LicensingCenterPageRoute,
  NotificationsPageRoute,
  OverviewPageRoute,
  PeoplePageRoute,
  PatrolPageRoute,
  ReportsPageRoute,
  RequestsPageRoute,
  RouteSuspense,
  SchedulePageRoute,
  SchedulerPageRoute,
  SitesPageRoute,
  SystemOperationsPageRoute,
  TimeExceptionsPageRoute,
  TimeExceptionsLegacyRoute,
  TimeOperationsPageRoute,
  TimeDailyAttendancePageRoute,
  TimeAccountabilityPageRoute,
  TimeMyTimePageRoute,
  TimePageRoute,
  TimeWorkspaceRoute,
  TimePayrollPageRoute,
  PayrollLegacyExportRoute,
  PayrollLegacyRulesRoute,
  TimeTeamPageRoute,
  TimeTimecardsPageRoute,
  TimeToolsPageRoute,
  UserAdminPageRoute,
} from './RouteElements'

export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <RouteSuspense>
        <LoginPageRoute />
      </RouteSuspense>
    ),
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        index: true,
        element: (
          <RouteSuspense>
            <OverviewPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'actions',
        element: (
          <RouteSuspense>
            <ActionCenterPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'schedule',
        element: (
          <RouteSuspense>
            <SchedulePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'scheduler',
        element: (
          <RouteSuspense>
            <SchedulerPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'events',
        element: (
          <RouteSuspense>
            <EventsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time',
        element: (
          <RouteSuspense>
            <TimeWorkspaceRoute />
          </RouteSuspense>
        ),
        children: [
          { index: true, element: <RouteSuspense><TimePageRoute /></RouteSuspense> },
          { path: '/time/tools', element: <RouteSuspense><TimeToolsPageRoute /></RouteSuspense> },
          { path: '/time/my-time', element: <RouteSuspense><TimeMyTimePageRoute /></RouteSuspense> },
          { path: '/time/team', element: <RouteSuspense><TimeTeamPageRoute /></RouteSuspense> },
          { path: '/time/review', element: <RouteSuspense><TimeExceptionsPageRoute /></RouteSuspense> },
          { path: '/time/exceptions', element: <RouteSuspense><TimeExceptionsLegacyRoute /></RouteSuspense> },
          { path: '/time/operations', element: <RouteSuspense><TimeOperationsPageRoute /></RouteSuspense> },
          { path: '/time/daily-review', element: <RouteSuspense><TimeDailyAttendancePageRoute /></RouteSuspense> },
          { path: '/time/accountability', element: <RouteSuspense><TimeAccountabilityPageRoute /></RouteSuspense> },
        ],
      },
      {
        path: 'time/timecards',
        element: (
          <RouteSuspense>
            <TimeTimecardsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/payroll',
        element: (
          <RouteSuspense>
            <PayrollLegacyExportRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/rules',
        element: (
          <RouteSuspense>
            <PayrollLegacyRulesRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'payroll',
        element: (
          <RouteSuspense>
            <TimePayrollPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'payroll/review',
        element: (
          <RouteSuspense>
            <TimePayrollPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'payroll/employees',
        element: (
          <RouteSuspense>
            <TimePayrollPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'payroll/export',
        element: (
          <RouteSuspense>
            <TimePayrollPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'payroll/rules',
        element: (
          <RouteSuspense>
            <TimePayrollPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr',
        element: (
          <RouteSuspense>
            <HrisPeopleWorkspacePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/people',
        element: (
          <RouteSuspense>
            <HrisPeopleWorkspacePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/people/:employeeId',
        element: (
          <RouteSuspense>
            <HrisEmployeeFilePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/documents',
        element: (
          <RouteSuspense>
            <HrisDocumentsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/documents/workflows',
        element: (
          <RouteSuspense>
            <HrisDocumentWorkflowsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/automation',
        element: (
          <RouteSuspense>
            <HrisAutomationPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/recruiting',
        element: (
          <RouteSuspense>
            <HrisRecruitingPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/onboarding',
        element: (
          <RouteSuspense>
            <HrisOnboardingPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/leave',
        element: (
          <RouteSuspense>
            <HrisLeavePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/benefits',
        element: (
          <RouteSuspense>
            <HrisBenefitsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/compensation',
        element: (
          <RouteSuspense>
            <HrisCompensationPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/talent-learning',
        element: (
          <RouteSuspense>
            <HrisTalentLearningPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/cases-compliance',
        element: (
          <RouteSuspense>
            <HrisCasesCompliancePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'my-documents',
        element: (
          <RouteSuspense>
            <MyDocumentsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'hr/identity-readiness',
        element: (
          <RouteSuspense>
            <HrisIdentityReadinessPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'people',
        element: (
          <RouteSuspense>
            <PeoplePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'licensing',
        element: (
          <RouteSuspense>
            <LicensingCenterPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'sites',
        element: (
          <RouteSuspense>
            <SitesPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'availability',
        element: (
          <RouteSuspense>
            <AvailabilityPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'account',
        element: (
          <RouteSuspense>
            <MyAccountPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'account-security',
        element: (
          <RouteSuspense>
            <AccountSecurityPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'patrol',
        element: (
          <RouteSuspense>
            <PatrolPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'requests',
        element: (
          <RouteSuspense>
            <RequestsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'users',
        element: (
          <RouteSuspense>
            <UserAdminPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'access-control',
        element: (
          <RouteSuspense>
            <AccessControlPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'system-operations',
        element: (
          <RouteSuspense>
            <SystemOperationsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'announcements',
        element: (
          <RouteSuspense>
            <AnnouncementsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'notifications',
        element: (
          <RouteSuspense>
            <NotificationsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'reports',
        element: (
          <RouteSuspense>
            <ReportsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'reports/:reportKey',
        element: (
          <RouteSuspense>
            <ReportsPageRoute />
          </RouteSuspense>
        ),
      },
    ],
  },
])

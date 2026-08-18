import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { RouteErrorPage } from '../pages/RouteErrorPage'
import {
  AccountSecurityPageRoute,
  ActionCenterPageRoute,
  AccessControlPageRoute,
  AnnouncementsPageRoute,
  AvailabilityPageRoute,
  EventsPageRoute,
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
  TimeExceptionsPageRoute,
  TimeOperationsPageRoute,
  TimeDailyAttendancePageRoute,
  TimeMyTimePageRoute,
  TimePageRoute,
  TimePayrollPageRoute,
  TimeRulesPageRoute,
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
            <TimePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/tools',
        element: (
          <RouteSuspense>
            <TimeToolsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/my-time',
        element: (
          <RouteSuspense>
            <TimeMyTimePageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/team',
        element: (
          <RouteSuspense>
            <TimeTeamPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/exceptions',
        element: (
          <RouteSuspense>
            <TimeExceptionsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/operations',
        element: (
          <RouteSuspense>
            <TimeOperationsPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/daily-review',
        element: (
          <RouteSuspense>
            <TimeDailyAttendancePageRoute />
          </RouteSuspense>
        ),
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
            <TimePayrollPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'time/rules',
        element: (
          <RouteSuspense>
            <TimeRulesPageRoute />
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
    ],
  },
])

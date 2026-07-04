import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { ModulePage } from '../pages/ModulePage'
import { RouteErrorPage } from '../pages/RouteErrorPage'
import {
  AccountSecurityPageRoute,
  AnnouncementsPageRoute,
  EventsPageRoute,
  ImportReviewPageRoute,
  LoginPageRoute,
  OperationalImportPageRoute,
  OverviewPageRoute,
  PeoplePageRoute,
  RequestsPageRoute,
  RouteSuspense,
  SchedulePageRoute,
  SitesPageRoute,
  TimePageRoute,
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
        path: 'schedule',
        element: (
          <RouteSuspense>
            <SchedulePageRoute />
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
        path: 'people',
        element: (
          <RouteSuspense>
            <PeoplePageRoute />
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
          <ModulePage
            eyebrow="Workforce"
            title="Patrol"
            description="Plan patrol requirements and routes while preserving a clean history of assigned and completed visits."
          />
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
        path: 'import-review',
        element: (
          <RouteSuspense>
            <ImportReviewPageRoute />
          </RouteSuspense>
        ),
      },
      {
        path: 'operational-import',
        element: (
          <RouteSuspense>
            <OperationalImportPageRoute />
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
          <ModulePage
            eyebrow="Communication"
            title="Notifications"
            description="Track delivery of scheduling, approval, call-off, and overtime messages without exposing sensitive site details."
          />
        ),
      },
      {
        path: 'reports',
        element: (
          <ModulePage
            eyebrow="Communication"
            title="Reports"
            description="Create readable operational, timekeeping, payroll, compliance, and change-history reports."
          />
        ),
      },
    ],
  },
])

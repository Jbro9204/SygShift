import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { RouteErrorPage } from '../pages/RouteErrorPage'
import {
  AccountSecurityPageRoute,
  AnnouncementsPageRoute,
  AvailabilityPageRoute,
  EventsPageRoute,
  LoginPageRoute,
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

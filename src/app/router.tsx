import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { EventsPage } from '../pages/EventsPage'
import { ImportReviewPage } from '../pages/ImportReviewPage'
import { ModulePage } from '../pages/ModulePage'
import { OverviewPage } from '../pages/OverviewPage'
import { OperationalImportPage } from '../pages/OperationalImportPage'
import { PeoplePage } from '../pages/PeoplePage'
import { RequestsPage } from '../pages/RequestsPage'
import { RouteErrorPage } from '../pages/RouteErrorPage'
import { SchedulePage } from '../pages/SchedulePage'
import { SitesPage } from '../pages/SitesPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'schedule', element: <SchedulePage /> },
      { path: 'events', element: <EventsPage /> },
      {
        path: 'time',
        element: (
          <ModulePage
            eyebrow="Operations"
            title="Time & attendance"
            description="Schedule-linked punches, exceptions, approvals, locked pay periods, and traceable payroll exports will live here."
          />
        ),
      },
      { path: 'people', element: <PeoplePage /> },
      { path: 'sites', element: <SitesPage /> },
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
      { path: 'requests', element: <RequestsPage /> },
      { path: 'import-review', element: <ImportReviewPage /> },
      { path: 'operational-import', element: <OperationalImportPage /> },
      {
        path: 'announcements',
        element: (
          <ModulePage
            eyebrow="Communication"
            title="Announcements"
            description="Publish general updates, events, and approved shift opportunities to the right qualified employees."
          />
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

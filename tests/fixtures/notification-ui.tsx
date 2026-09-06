import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsPage } from '../../src/pages/NotificationsPage'
import '../../src/index.css'
import '../../src/theme.css'
import '../../src/App.css'

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/notifications?view=send']}><main><NotificationsPage /></main></MemoryRouter>
  </QueryClientProvider>,
)

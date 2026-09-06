import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { SupportTicketsPage } from '../../src/pages/SupportTicketsPage'
import { HeaderNotificationButton } from '../../src/components/HeaderNotificationButton'
import { LiveNotifications } from '../../src/components/LiveNotifications'
import { NotificationPreferences } from '../../src/components/NotificationPreferences'
import { beginLoginSound, completeLoginSound } from '../../src/lib/notificationSounds'
import { emitAlert, employeeId } from './live-data'
import '../../src/index.css'
import '../../src/theme.css'
import '../../src/App.css'
const admin = new URLSearchParams(location.search).has('admin')
const id = admin ? '10000000-0000-4000-8000-000000000002' : employeeId
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <MemoryRouter initialEntries={['/support']}><main>
    <button onClick={() => emitAlert()}>Incoming fixture alert</button>
    <button onClick={() => emitAlert('20000000-0000-4000-8000-000000000001')}>Repeat same alert</button>
    <button onClick={() => emitAlert(crypto.randomUUID(), new Date(Date.now() - 120_000).toISOString())}>Old fixture alert</button>
    <button onClick={() => { beginLoginSound('fixture'); void completeLoginSound('fixture') }}>Completed manual sign-in</button>
    <HeaderNotificationButton enabled /><LiveNotifications employeeId={id} username="fixture" />
    <SupportTicketsPage /><NotificationPreferences />
  </main></MemoryRouter>
</QueryClientProvider>)

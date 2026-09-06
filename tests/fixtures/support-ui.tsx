import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { SupportTicketForm } from '../../src/components/SupportTicketForm'
import { SupportTicketsPage } from '../../src/pages/SupportTicketsPage'
import '../../src/index.css'
import '../../src/theme.css'
import '../../src/App.css'

function Fixture() {
  const [open, setOpen] = useState(true)
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={['/support']}>
    {new URLSearchParams(location.search).has('workspace') ? <main><SupportTicketsPage /></main> : <main><h1>Support intake verification</h1><button onClick={() => setOpen(true)}>Need Help?</button>{open ? <SupportTicketForm onClose={() => setOpen(false)} /> : null}</main>}
  </MemoryRouter></QueryClientProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { UserAdminPage } from '../../src/pages/UserAdminPage'
import { inviteFixture } from './invite-data'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/theme.css'

declare global { interface Window { inviteFixture: typeof inviteFixture } }
window.inviteFixture = inviteFixture
document.documentElement.dataset.theme = 'light'
document.documentElement.style.colorScheme = 'light'
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: 3, retryDelay: 1 } } })
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><MemoryRouter>
    <main className="page-content" style={{ padding: 16 }} data-fixture="isolated-invite-controls"><UserAdminPage /></main>
  </MemoryRouter></QueryClientProvider>,
)

import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { RequestsPage } from '../../src/pages/RequestsPage'
import './time-off-ui.css'
import '../../src/index.css'
import '../../src/App.css'

const params = new URLSearchParams(location.search)
const deepLink = params.get('deep')
const path = params.get('alias') === 'legacy' ? '/requests' : '/time-off'
const routeParams = new URLSearchParams({ tab: 'time-off' })
if (deepLink) routeParams.set('request', deepLink)

document.documentElement.dataset.theme = params.get('theme') ?? 'dark'
document.documentElement.style.colorScheme = params.get('theme') ?? 'dark'

const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[`${path}?${routeParams}`]}>
      <main className="time-off-fixture-shell">
        <RequestsPage />
      </main>
    </MemoryRouter>
  </QueryClientProvider>,
)

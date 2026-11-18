import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PatrolPage } from '../../src/pages/PatrolPage'
import '../../src/index.css'
import '../../src/App.css'
import '../../src/theme.css'
import '../../src/styles/form-controls.css'

const parameters = new URLSearchParams(location.search)
const theme = parameters.get('theme') === 'light' ? 'light' : 'dark'
const tab = parameters.get('tab') === 'operations' ? 'operations' : 'routes'
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/patrol/${tab}`]}><main className="workspace" style={{ padding: 16 }}><p>LOCAL DEMO — SAMPLE DATA ONLY</p><Routes><Route path="/patrol/:patrolTab" element={<PatrolPage />} /></Routes></main></MemoryRouter></QueryClientProvider>)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import { OverviewPage } from '../../src/pages/OverviewPage'
import { TimeWorkspace } from '../../src/time/TimeWorkspace'
import '../../src/index.css'
import '../../src/App.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') ?? 'dark'
document.documentElement.style.colorScheme = params.get('theme') ?? 'dark'
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><MemoryRouter initialEntries={[params.get('surface') === 'workspace' ? '/time/my-time' : '/']}><main style={{ padding: 16 }}><nav><Link to="/">Home</Link> · <Link to="/time/my-time">My Time</Link></nav><output id="clock-fixture-records" aria-label="Test punch counts">0 attempts · 0 punches</output><Routes><Route path="/" element={<OverviewPage />} /><Route path="/time" element={<TimeWorkspace />}><Route path="my-time" element={<p>Pay-period history remains separate from live clock controls.</p>} /></Route></Routes></main></MemoryRouter></QueryClientProvider></StrictMode>)

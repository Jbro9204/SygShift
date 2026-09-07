import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { SphereWorkspace } from '../../src/pages/SygSpherePage'
import { SygSphereLauncher } from '../../src/components/SygSphereLauncher'
import { actor, conversationId, failNextSend, incoming } from './sphere-data'
import '../../src/index.css'
import '../../src/theme.css'
import '../../src/App.css'
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'light'
const sphere = <SphereWorkspace employeeId={actor} />
const fixtureBody = params.has('shell')
  ? <div className="app-shell"><div className="workspace" style={{ marginLeft: 0 }}><header className="topbar"><span>SygShift</span><span /><span /></header><main id="main-content">{sphere}</main></div></div>
  : <div style={{ padding: 14 }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}><button onClick={failNextSend}>Simulate one failed send</button><button onClick={incoming}>Receive fixture message</button><div className="sidebar" style={{ position: 'static', width: 265, minHeight: 0, padding: 0 }}><SygSphereLauncher employeeId={actor} /></div></div>{sphere}</div>
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[params.has('home') ? '/' : `/sygsphere?conversation=${conversationId}`]}>{fixtureBody}</MemoryRouter></QueryClientProvider>)

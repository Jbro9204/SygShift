import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { PDFDocument, rgb } from 'pdf-lib'
import { SecurePdfViewer } from '../../src/components/SecurePdfViewer'
import { SphereWorkspace } from '../../src/pages/SygSpherePage'
import { SygSphereLauncher } from '../../src/components/SygSphereLauncher'
import { OperationalTimeHeader } from '../../src/components/OperationalTimeHeader'
import { actor, conversationId, failNextSend, incoming } from './sphere-data'
import '../../src/index.css'
import '../../src/theme.css'
import '../../src/App.css'
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'light'
const sphere = <SphereWorkspace employeeId={actor} />
function PdfStabilityFixture() {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    let objectUrl = ''
    void (async () => {
      const document = await PDFDocument.create()
      const page = document.addPage([612, 792])
      page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(.84, .64, .25) })
      page.drawText('Stable SygSphere PDF preview', { x: 96, y: 396, size: 24, color: rgb(.05, .05, .05) })
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(await document.save())], { type: 'application/pdf' }))
      if (active) setUrl(objectUrl)
    })()
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [])
  return <main style={{ height: '100dvh', padding: 16 }}>{url ? <SecurePdfViewer title="Stable preview fixture" url={url} /> : <p>Preparing PDF fixture…</p>}</main>
}
const accountControls = <div className="user-menu"><div aria-label="Appearance" className="theme-switcher" role="group"><button aria-label="Use light mode" className="theme-switcher__button" type="button">☀</button><button aria-label="Use dark mode" className="theme-switcher__button" type="button">☾</button></div><span aria-hidden="true" className="user-menu__divider" /><a aria-label="Open notifications" className="header-notification" href="#notifications">!</a><span aria-hidden="true" className="user-menu__divider" /><a aria-label="Open My Account" className="user-profile-control" href="#account"><span className="user-menu__avatar">MC</span></a><button aria-label="Sign Out" className="user-menu__icon-button" type="button">↪</button></div>
const fixtureBody = params.has('pdf')
  ? <PdfStabilityFixture />
  : params.has('mobile-shell')
  ? <div className="app-shell app-shell--compact-navigation app-shell--sygsphere"><button aria-label="Open navigation" className="mobile-menu-button" type="button">☰</button><div className="workspace" style={{ marginLeft: 0 }}><OperationalTimeHeader accountControls={accountControls} /><section aria-label="Workspace alerts" className="workspace-alert-strip workspace-alert-strip--urgent"><div className="workspace-alert-strip__icon">!</div><div className="workspace-alert-strip__copy"><strong>Missing clock-in</strong><div className="workspace-alert-strip__ticker"><span>Employee · Assigned post</span></div></div><div className="workspace-alert-strip__position">1/2</div><button className="workspace-alert-strip__action" type="button">Review alert</button></section><main id="main-content">{sphere}</main></div></div>
  : params.has('shell')
  ? <div className="app-shell"><div className="workspace" style={{ marginLeft: 0 }}><header className="topbar"><span>SygShift</span><span /><span /></header><main id="main-content">{sphere}</main></div></div>
  : <div style={{ padding: 14 }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}><button onClick={failNextSend}>Simulate one failed send</button><button onClick={incoming}>Receive fixture message</button><div className="sidebar" style={{ position: 'static', width: 265, minHeight: 0, padding: 0 }}><SygSphereLauncher employeeId={actor} /></div></div>{sphere}</div>
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[params.has('home') ? '/' : `/sygsphere?conversation=${conversationId}`]}>{fixtureBody}</MemoryRouter></QueryClientProvider>)

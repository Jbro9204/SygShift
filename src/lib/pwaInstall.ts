type InstallChoice = {
  outcome: 'accepted' | 'dismissed'
  platform: string
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<InstallChoice>
}

export type PwaInstallState = {
  canPrompt: boolean
  installed: boolean
}

export type PwaInstallResult = 'installed' | 'dismissed' | 'unavailable'

const INSTALL_STATE_EVENT = 'sygshift:pwa-install-state'
let deferredPrompt: BeforeInstallPromptEvent | null = null
let initialized = false

function standalone(): boolean {
  if (typeof window === 'undefined') return false
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true
}

function announceState(): void {
  window.dispatchEvent(new Event(INSTALL_STATE_EVENT))
}

export async function ensureSygShiftServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) throw new Error('This browser does not support the SygShift app service.')
  return navigator.serviceWorker.register('/notification-sw.js', { scope: '/', updateViaCache: 'none' })
}

export function getPwaInstallState(): PwaInstallState {
  return { canPrompt: deferredPrompt !== null, installed: standalone() }
}

export function initializePwaExperience(): void {
  if (typeof window === 'undefined' || initialized) return
  initialized = true
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    announceState()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    announceState()
  })
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', announceState)
  if ('serviceWorker' in navigator) {
    void ensureSygShiftServiceWorker().catch(() => {
      // Installation and ordinary SygShift use remain available when registration is temporarily unavailable.
    })
  }
}

export function subscribePwaInstallState(listener: () => void): () => void {
  window.addEventListener(INSTALL_STATE_EVENT, listener)
  return () => window.removeEventListener(INSTALL_STATE_EVENT, listener)
}

export async function requestPwaInstall(): Promise<PwaInstallResult> {
  if (standalone()) return 'installed'
  const prompt = deferredPrompt
  if (!prompt) return 'unavailable'
  deferredPrompt = null
  await prompt.prompt()
  const choice = await prompt.userChoice
  announceState()
  return choice.outcome === 'accepted' ? 'installed' : 'dismissed'
}

export function pwaInstallInstructions(): string {
  if (typeof navigator === 'undefined') return 'Use your browser menu and choose Install app or Add to Home Screen.'
  const agent = navigator.userAgent
  if (/iPad|iPhone|iPod/i.test(agent)) {
    return 'In Safari, tap Share, then Add to Home Screen. Open SygShift from the new Home Screen icon.'
  }
  if (/Android/i.test(agent)) {
    return 'Open the browser menu, then choose Install app or Add to Home screen.'
  }
  return 'Open the browser menu or address-bar install control, then choose Install SygShift.'
}

/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf8')) as { display: string; icons: Array<{ purpose: string; sizes: string; src: string }> }
const index = readFileSync(join(root, 'index.html'), 'utf8')
const main = readFileSync(join(root, 'src', 'main.tsx'), 'utf8')
const install = readFileSync(join(root, 'src', 'lib', 'pwaInstall.ts'), 'utf8')
const serviceWorker = readFileSync(join(root, 'public', 'notification-sw.js'), 'utf8')
const preferences = readFileSync(join(root, 'src', 'components', 'NotificationPreferences.tsx'), 'utf8')

describe('installable SygShift experience', () => {
  it('ships complete local icons and initializes the one existing push-only worker', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512', '512x512'])
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
    for (const icon of manifest.icons) expect(existsSync(join(root, 'public', icon.src))).toBe(true)
    expect(index).toContain('apple-touch-icon')
    expect(main).toContain('initializePwaExperience()')
    expect(install).toContain("navigator.serviceWorker.register('/notification-sw.js'")
    expect(readFileSync(join(root, 'src', 'data', 'pushNotifications.ts'), 'utf8')).toContain('ensureSygShiftServiceWorker()')
    expect(serviceWorker).not.toContain("addEventListener('fetch'")
  })

  it('provides one device-local install control without changing authentication', () => {
    expect(install).toContain("window.addEventListener('beforeinstallprompt'")
    expect(install).toContain("window.addEventListener('appinstalled'")
    expect(preferences).toContain('Install SygShift on this device')
    expect(preferences).toContain('does not create another account, bypass sign-in, or store protected records for offline use')
  })
})

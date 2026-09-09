import { expect, test } from '@playwright/test'

test('serves a complete installable app shell and the existing push-only service worker', async ({ page, request }) => {
  await page.goto('/')
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(manifestHref).toBe('/manifest.webmanifest')
  const manifestResponse = await request.get(manifestHref!)
  expect(manifestResponse.ok()).toBe(true)
  const manifest = await manifestResponse.json() as { display: string; icons: Array<{ sizes: string; src: string }> }
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(['192x192', '512x512', '512x512'])
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('image/png')
  }
  const scriptUrl = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '')
  expect(scriptUrl).toContain('/notification-sw.js')
})

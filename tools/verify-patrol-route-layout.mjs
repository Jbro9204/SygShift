import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const origin = 'http://127.0.0.1:4281'
const output = resolve('.work/patrol-route-layout')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const results = []
try {
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    const page = await context.newPage()
    const errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      external.push(url.origin)
      return route.abort()
    })
    await page.goto(`${origin}/tests/fixtures/patrol-route-ui.html?theme=${theme}`)
    await page.getByText('LOCAL DEMO — SAMPLE DATA ONLY', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Build route', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Route name', { exact: true }).fill('Sample route')
    await dialog.getByLabel('Route code', { exact: true }).fill('sample-route')
    await dialog.getByRole('combobox', { name: /^Route status/ }).selectOption('active')
    await dialog.getByText('Stop 1', { exact: true }).click()
    await dialog.getByRole('combobox', { name: /^Property/ }).selectOption('10000000-0000-4000-8000-000000000010')
    assert.equal(await dialog.getByRole('combobox', { name: /^Post \(optional\)/ }).inputValue(), '')
    await dialog.getByRole('button', { name: 'Add requirement', exact: true }).click()
    await dialog.getByLabel('Change reason', { exact: true }).fill('Set the verified sample property and weekday requirement.')
    const geometry = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, right: element.getBoundingClientRect().right, viewport: innerWidth }))
    assert(geometry.scroll <= geometry.width + 1 && geometry.right <= geometry.viewport + 1)
    await dialog.getByRole('combobox', { name: /^Property/ }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(output, `${width}-${theme}.png`) })
    await dialog.getByRole('button', { name: 'Save route version', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const saved = await page.locator('body').getAttribute('data-saved-route')
    assert(saved)
    const payload = JSON.parse(saved)
    assert.equal(payload.stops[0].siteId, '10000000-0000-4000-8000-000000000010')
    assert.equal(payload.stops[0].postId, null)
    assert.equal(payload.stops[0].requirements.length, 1)
    assert.match(payload.idempotencyKey, /^[a-f0-9-]{36}$/i)
    assert.equal(payload.expectedVersionId, null)
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    results.push({ width, theme, passed: true, geometry, siteOnlySaveVerified: true })
    await context.close()
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ browser: browser.version(), results }, null, 2))
  console.log(JSON.stringify({ cases: results.length, passed: true, output }))
} finally { await browser.close() }

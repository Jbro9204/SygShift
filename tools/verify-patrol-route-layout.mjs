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
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) for (const tab of ['routes', 'operations']) {
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
    await page.goto(`${origin}/tests/fixtures/patrol-route-ui.html?theme=${theme}&scenario=readiness&tab=${tab}`)
    await page.getByText('LOCAL DEMO — SAMPLE DATA ONLY', { exact: true }).waitFor()
    if (tab === 'operations') {
      await page.getByRole('combobox', { name: 'Active route', exact: true }).selectOption('10000000-0000-4000-8000-000000000030')
      await page.getByRole('combobox', { name: 'Published assigned shift', exact: true }).selectOption({ label: 'Sample Guard · Sample schedule location · 2026-11-18T03:00:00.000Z' })
      await page.getByText('No patrol route is connected to this employee and shift.', { exact: true }).waitFor()
      await page.getByText(/Unchanged schedule revisions retain verified connections/).waitFor()
    }
    const notice = page.getByRole('status').filter({ has: page.getByText('Sample route: property setup incomplete', { exact: true }) })
    await notice.waitFor()
    await notice.getByText('Stop 1 — Unlinked sample property: Link an active property.', { exact: true }).waitFor()
    await notice.getByText('Stop 1 — Unlinked sample property: Add an active weekly hit requirement.', { exact: true }).waitFor()
    await notice.scrollIntoViewIfNeeded()
    const geometry = await notice.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: innerWidth }))
    assert(geometry.scroll <= geometry.width + 1 && geometry.left >= -1 && geometry.right <= geometry.viewport + 1)
    assert.equal(await page.locator('body').getAttribute('data-fixture-mutation-count'), '0')
    assert.equal(await page.locator('body').getAttribute('data-saved-route'), null)
    await page.screenshot({ path: resolve(output, `readiness-${tab}-${width}-${theme}.png`), fullPage: true })
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    results.push({ width, theme, tab, scenario: 'readiness', passed: true, geometry, mutationCount: 0 })
    await context.close()
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ browser: browser.version(), results }, null, 2))
  console.log(JSON.stringify({ cases: results.length, passed: true, output }))
} finally { await browser.close() }

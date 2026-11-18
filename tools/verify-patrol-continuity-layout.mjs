import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const origin = 'http://127.0.0.1:4281'
const output = resolve('.work/patrol-continuity-layout')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const results = []
let activePage = null
let activeCase = ''
let activeErrors = []
async function geometryFor(locator) {
  const geometry = await locator.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth,
    left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, viewport: innerWidth }))
  assert(geometry.scroll <= geometry.width + 1 && geometry.left >= -1 && geometry.right <= geometry.viewport + 1)
  return geometry
}
try {
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) for (const scenario of ['continuity', 'continuity-closed', 'guard-review']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.setDefaultNavigationTimeout(10_000)
    const errors = [], external = []
    activePage = page
    activeCase = `${scenario}-${width}-${theme}`
    activeErrors = errors
    console.log(JSON.stringify({ case: activeCase, stage: 'starting' }))
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      external.push(url.origin)
      return route.abort()
    })
    await page.goto(`${origin}/tests/fixtures/patrol-route-ui.html?theme=${theme}&scenario=${scenario}&tab=${scenario === 'guard-review' ? 'my-patrol' : 'operations'}`)
    await page.getByText('LOCAL DEMO — SAMPLE DATA ONLY', { exact: true }).waitFor()
    if (scenario === 'guard-review') {
      await page.getByText('Patrol schedule changes need review', { exact: true }).waitFor()
      await page.getByText('Retained completed property', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Record extra hit', exact: true }).click()
      await page.getByText(/The schedule changed. Operations must review this patrol connection/).waitFor()
      assert.equal(await page.getByRole('dialog').count(), 0)
      await page.getByRole('button', { name: 'Complete hit', exact: true }).click()
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.getByText('Retained completed property', { exact: true }).count(), 1)
      assert.equal(await page.getByRole('button', { name: 'Review connection', exact: true }).count(), 0)
      assert.equal(await page.locator('body').getAttribute('data-fixture-mutation-count'), '0')
      const geometry = await geometryFor(page.locator('.patrol-assignment-card'))
      await page.screenshot({ path: resolve(output, `${scenario}-${width}-${theme}.png`), fullPage: true })
      results.push({ scenario, width, theme, geometry, mutationCount: 0, historyRetained: true })
    } else {
      await page.getByRole('button', { name: 'Review connection', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Review patrol schedule change' })
      await dialog.waitFor()
      assert.equal(await page.locator('body').getAttribute('data-fixture-mutation-count'), '0')
      const submit = dialog.getByRole('button', { name: scenario === 'continuity' ? 'Confirm patrol reconnection' : 'Close unworked patrol', exact: true })
      assert.equal(await submit.isDisabled(), true)
      if (scenario === 'continuity') assert.equal(await dialog.getByRole('combobox', { name: /^Scheduled employee/ }).inputValue(), '10000000-0000-4000-8000-000000000060')
      else assert.equal(await dialog.getByRole('combobox', { name: /^Scheduled employee/ }).count(), 0)
      const reason = 'Reviewed the exact future shift and retained patrol history.'
      const reasonField = dialog.getByRole('textbox', { name: /^Review reason/ })
      await reasonField.fill(reason)
      await submit.click()
      await dialog.getByRole('alert').getByText('The review could not be confirmed. No saved work was changed.', { exact: true }).waitFor()
      assert.equal(await reasonField.inputValue(), reason)
      assert.equal(await page.locator('body').getAttribute('data-fixture-reconcile-count'), '1')
      assert.equal(await page.getByText(/Patrol reconnected to the reviewed current assignment/).count(), 0)
      const geometry = await geometryFor(dialog)
      await page.screenshot({ path: resolve(output, `${scenario}-${width}-${theme}-failure.png`), fullPage: true })
      const readsBefore = Number(await page.locator('body').getAttribute('data-fixture-workspace-read-count'))
      await submit.click()
      await dialog.getByRole('button', { name: 'Confirming...', exact: true }).waitFor()
      assert.equal(await dialog.getByRole('button', { name: 'Confirming...', exact: true }).isDisabled(), true)
      assert.equal(await reasonField.isDisabled(), true)
      assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true)
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-confirm-save')))
      await dialog.waitFor({ state: 'hidden' })
      await page.getByText(scenario === 'continuity'
        ? 'Patrol reconnected to the reviewed current assignment. Original records remain retained.'
        : 'Unworked patrol closed. Its original assignment and audit history remain retained.', { exact: true }).waitFor()
      await page.waitForFunction(before => Number(document.body.dataset.fixtureWorkspaceReadCount) > before, readsBefore)
      await page.getByRole('button', { name: 'Review connection', exact: true }).waitFor({ state: 'hidden' })
      assert.equal(await page.getByRole('button', { name: 'Review connection', exact: true }).count(), 0)
      assert.equal(await page.locator('body').getAttribute('data-fixture-mutation-count'), '2')
      const request = JSON.parse(await page.locator('body').getAttribute('data-fixture-reconcile-request'))
      assert.deepEqual(request, { continuityId: '10000000-0000-4000-8000-000000000070',
        employeeId: scenario === 'continuity' ? '10000000-0000-4000-8000-000000000060' : null, reason })
      await page.screenshot({ path: resolve(output, `${scenario}-${width}-${theme}-success.png`), fullPage: true })
      results.push({ scenario, width, theme, geometry, rejectedThenConfirmed: true, refetched: true, mutationCount: 2 })
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    assert.equal(await page.locator('body').getAttribute('data-saved-route'), null)
    console.log(JSON.stringify({ case: activeCase, stage: 'passed' }))
    await context.close()
    activePage = null
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ browser: browser.version(), results }, null, 2))
  console.log(JSON.stringify({ passed: true, cases: results.length, output }))
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(output, `${activeCase}-failed.png`), fullPage: true }).catch(() => {})
    await writeFile(resolve(output, `${activeCase}-failed.html`), await activePage.content()).catch(() => {})
  }
  console.error(JSON.stringify({ case: activeCase, errors: activeErrors, failure: String(error) }))
  throw error
} finally { await browser.close() }

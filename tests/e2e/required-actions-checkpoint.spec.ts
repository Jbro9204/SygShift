import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('required-actions checkpoint is guided, readable, and keeps urgent access visible', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root) => {
    const fixtureRoot = root.cloneNode(false) as HTMLElement
    root.replaceWith(fixtureRoot)
    fixtureRoot.innerHTML = `
      <main id="main-content">
        <section aria-labelledby="required-actions-title" class="required-actions-checkpoint">
          <header class="required-actions-checkpoint__header">
            <div class="required-actions-checkpoint__icon" aria-hidden="true">✓</div>
            <div><p class="eyebrow">REQUIRED BEFORE ENTERING THE WORKSPACE</p><h1 id="required-actions-title">Let’s finish your required actions</h1><p>SygShift keeps everything in one ordered list and saves each response against the exact assigned version.</p></div>
            <span class="required-actions-checkpoint__count">3 remaining</span>
          </header>
          <div class="required-actions-checkpoint__progress" aria-label="Action 1 of 3"><div><strong>Action 1 of 3</strong><span>Critical item first</span></div><div aria-hidden="true"><span style="width:33%"></span></div></div>
          <article class="required-actions-checkpoint__current required-actions-checkpoint__current--critical">
            <div class="required-actions-checkpoint__current-icon" aria-hidden="true">!</div>
            <div class="required-actions-checkpoint__current-copy"><span>Schedule · Schedule revision 4</span><h2>Schedule for week of 09/13/2026</h2><p>Review revision 4 and confirm the assigned shifts.</p><small>Confirmation records that you reviewed this exact published schedule revision.</small></div>
            <a class="primary-action" href="#review">Confirm schedule →</a>
          </article>
          <details class="required-actions-checkpoint__queue"><summary>View all 3 required actions</summary><ol><li><span aria-hidden="true">•</span><div><strong>Schedule for week of 09/13/2026</strong><span>Schedule · revision 4</span></div><a href="#open">Open</a></li></ol></details>
          <div class="required-actions-checkpoint__urgent"><div><span aria-hidden="true">!</span><span><strong>Urgent access always remains available.</strong> Required actions never stop you from clocking in/out or reporting a call-off.</span></div><nav aria-label="Urgent access"><a href="#clock">Clock in or out</a><a href="#calloff">Report sick / call-off</a></nav><details><summary>Emergency information</summary><p>For an immediate threat or medical emergency, call 911 and follow your established Dispatch emergency procedure.</p></details></div>
        </section>
      </main>`
  })

  await expect(page.getByRole('heading', { name: 'Let’s finish your required actions' })).toBeVisible()
  await expect(page.getByLabel('Action 1 of 3')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Clock in or out' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Report sick / call-off' })).toBeVisible()
  for (const link of await page.locator('.required-actions-checkpoint a').all()) {
    const box = await link.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.height).toBeGreaterThanOrEqual(38)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('required-actions-checkpoint.png'), fullPage: true })
})

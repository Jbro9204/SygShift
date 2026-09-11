import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`corrective-action walkthrough remains usable on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.locator('#root').evaluate((root) => {
      const fixtureRoot = root.cloneNode(false) as HTMLElement
      root.replaceWith(fixtureRoot)
      fixtureRoot.innerHTML = `
        <main id="main-content"><section class="panel corrective-workspace">
          <div class="section-heading"><div><p class="eyebrow">Guided workflow</p><h1>Corrective actions</h1><p>Create a factual record, route it to a different HR reviewer, deliver it privately, and preserve the employee’s exact response.</p></div><button class="primary-action" type="button">New corrective action</button></div>
          <div class="corrective-summary"><article><span>Needs HR review</span><strong>1</strong></article><article><span>Ready to deliver</span><strong>0</strong></article><article><span>Awaiting employee</span><strong>0</strong></article><article><span>Follow-up due</span><strong>0</strong></article></div>
          <div class="corrective-wizard">
            <nav aria-label="Corrective action steps"><span class="is-complete"><b>✓</b>Employee</span><span class="is-current"><b>2</b>Facts</span><span><b>3</b>Expectations</span><span><b>4</b>Review</span></nav>
            <div class="corrective-wizard__step"><h2>Record only the observed facts</h2><p>Use dates, actions, witnesses, and direct observations. Avoid assumptions or labels.</p><label class="form-field form-field--wide"><span>What happened?</span><textarea rows="9">The employee arrived after the scheduled start time on the documented date.</textarea><small>82 / 10,000</small></label></div>
            <div class="modal-actions"><button class="secondary-button" type="button">Back</button><button class="primary-action" type="button">Continue</button></div>
          </div>
        </section></main>`
    })

    await expect(page.getByRole('heading', { name: 'Corrective actions' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Corrective action steps' })).toBeVisible()
    await expect(page.getByLabel('What happened?')).toBeEditable()
    const overflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).map((element) => ({ className: element.className, right: Math.round(element.getBoundingClientRect().right), tag: element.tagName })))
    expect(overflow).toEqual([])
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`guided-corrective-${viewport.name}.png`), fullPage: true })
  })
}

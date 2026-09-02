import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installClientFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<main style="max-width:1440px;margin:0 auto;padding:24px"><div class="page page--clients">
      <header class="client-page-hero"><div><p class="eyebrow">Workforce &amp; Operations</p><h1>Client Files</h1><p>One controlled relationship record for client identity, locations, service history, contracts, evidence, and future portal delivery.</p></div><button class="primary-action" type="button">Add client</button></header>
      <section class="client-metrics" aria-label="Client File summary"><article><span>Active clients</span><strong>14</strong><small>Currently served</small></article><article><span>Prospects</span><strong>31</strong><small>Not yet operational</small></article><article><span>Renewals due</span><strong>3</strong><small>Next 90 days</small></article><article class="client-metric--attention"><span>Needs attention</span><strong>4</strong><small>Onboarding or no linked site</small></article></section>
      <section class="client-directory-panel"><div class="client-filters"><label class="search-field"><span class="sr-only">Search Client Files</span><input aria-label="Search Client Files" placeholder="Search client, number, city, or state" /></label><label><span>Status</span><select><option>All statuses</option></select></label></div><div class="client-directory-list" role="list" aria-label="Client directory"><div aria-hidden="true" class="client-directory-row client-directory-row--header"><span>Client</span><span>Status</span><span>Sites</span><span>Records</span><span>Manage</span></div>${Array.from({ length: 10 }, (_, index) => `<div class="client-directory-row" role="listitem"><div><strong>Sample Client ${index + 1}</strong><small>CLI-${String(1000 + index)} · Sample Client Legal LLC</small></div><span class="status-badge client-status--active">Active</span><div><strong>2</strong><small>Denver, CO</small></div><div><strong>3 contacts</strong><small>4 documents</small></div><button class="secondary-button secondary-button--small" type="button">Open file</button></div>`).join('')}</div><footer class="client-pagination"><span>Page 1 · 48 records</span><label>Rows <select><option>10</option></select></label><button class="secondary-button secondary-button--small" type="button">Previous</button><button class="secondary-button secondary-button--small" type="button">Next</button></footer></section>
    </div></main>`
  }, theme)
}

async function installClientFileFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    document.body.innerHTML = `<main style="max-width:1440px;margin:0 auto;padding:24px"><div class="page page--clients">
      <button class="back-link" type="button">Back to Client Files</button>
      <header class="client-file-hero"><div><p class="eyebrow">CLI-1000 · Active</p><h1>Sample Client</h1><p>Sample Client Legal LLC</p></div><div class="client-file-hero__actions"><button class="secondary-button" type="button">Edit client</button><button class="primary-action" type="button">Add service record</button></div></header>
      <nav class="client-tabs" aria-label="Client File sections"><button type="button">Overview</button><button type="button">Contacts (14)</button><button type="button">Sites &amp; Posts (12)</button><button class="is-active" aria-current="page" type="button">Documents (28)</button><button type="button">Activity</button></nav>
      <section class="client-card"><div class="client-section-heading"><div><p class="eyebrow">Private client vault</p><h2>Proposals, contracts &amp; records</h2><p>Contract and pricing files remain visible only to separately authorized employees.</p></div><button class="primary-action" type="button">Upload document</button></div>
      <div class="client-document-list">${Array.from({ length: 10 }, (_, index) => `<article><span aria-hidden="true">▣</span><div><strong>Document ${index + 1}</strong><span>contract · 1.2 MB · restricted</span><small>sample-${index + 1}.pdf · Added Sep 2, 2026</small></div><span class="client-portal-state">internal only</span><div><button class="secondary-button secondary-button--small" type="button">View</button><button class="secondary-button secondary-button--small" type="button">Download</button></div></article>`).join('')}</div>
      <footer class="client-pagination"><span>Page 1 · 28 documents</span><label>Rows <select><option>10</option></select></label><button class="secondary-button secondary-button--small" type="button">Previous</button><button class="secondary-button secondary-button--small" type="button">Next</button></footer></section>
    </div></main>`
  }, theme)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Client Files stays compact and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installClientFixture(page, theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await expect(page.locator('.client-directory-row').filter({ hasText: 'Sample Client' })).toHaveCount(10)
    for (const control of await page.locator('button, input, select').all()) {
      const box = await control.boundingBox(); expect(box).not.toBeNull(); expect(box!.height).toBeGreaterThanOrEqual(32)
    }
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`client-files-${theme}.png`), fullPage: true })
  })

  test(`Client File detail remains bounded and accessible in ${theme} mode`, async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installClientFileFixture(page, theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await expect(page.locator('.client-document-list article')).toHaveCount(10)
    await expect(page.locator('.client-pagination')).toContainText('28 documents')
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
  })
}

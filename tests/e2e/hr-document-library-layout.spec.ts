import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installLibraryFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    const forms = Array.from({ length: 10 }, (_, index) => {
      const code = `GS-HR-${String(100 + index).padStart(3, '0')}`
      return `<article class="hr-template-library__item">
        <button aria-controls="source-details-${index}" aria-expanded="${index === 0}" class="hr-template-library__summary" type="button"><span class="hr-template-library__code">${code}</span><span class="hr-template-library__identity"><strong>${index === 0 ? 'Employee Information and Emergency Contact Record With a Deliberately Long Controlled Title' : `Controlled employee form ${index + 1}`}</strong><small>Recruiting &amp; Onboarding / Confidential employee administration</small></span><span class="hr-template-library__badges"><span class="hr-template-library__kind is-controlled_form">Draft controlled form source</span><span class="hr-template-library__availability is-available">Source file ready</span><span class="hr-template-library__availability is-draft_for_adoption">Draft source</span></span><span aria-hidden="true">⌄</span></button>
        ${index === 0 ? '<div class="hr-template-library__details" id="source-details-0"><div><small>What this document is for</small><p>Captures current contact, communication, and emergency-contact information needed for employment administration.</p></div><dl class="hr-template-library__essential-details"><div><dt>Record class</dt><dd>Personnel File / Confidential Contact Information</dd></div><div><dt>Document type</dt><dd>HR source catalog</dd></div><div><dt>Source status</dt><dd>Draft source</dd></div><div><dt>Length</dt><dd>4 pages</dd></div></dl><details class="hr-template-library__technical-details" open><summary>Retrieval and source details</summary><dl><div><dt>Library code</dt><dd>GS-HR-105</dd></div><div><dt>Controlled filename</dt><dd>GS-HR-105_Employee_Information_and_Emergency_Contact_Record_With_A_Very_Long_Source_Filename.pdf</dd></div></dl></details><p class="hr-template-library__access-note">This draft is available to preview or download. It cannot start a working copy until it is formally adopted.</p><div class="hr-template-library__actions"><button class="primary-action" type="button">Preview draft source</button><button class="secondary-button" type="button">Download source file</button></div></div>' : ''}
      </article>`
    }).join('')
    document.body.innerHTML = `<main style="max-width:1440px;margin:0 auto;padding:24px"><h1>Document Studio</h1><section aria-label="Document Studio" class="document-studio"><div aria-label="Document Studio sections" class="document-studio__tabs" role="tablist"><button aria-selected="false" role="tab">Overview</button><button aria-selected="true" class="active" role="tab">Library</button><button aria-selected="false" role="tab">Templates</button><button aria-selected="false" role="tab">Signatures</button><button aria-selected="false" role="tab">Policies</button><button aria-selected="false" role="tab">Processing</button></div><section class="hr-template-library hr-template-library--studio">
      <header class="hr-template-library__header"><div><p class="eyebrow">Document Center</p><h2>HR forms &amp; source templates</h2><p>Start with the task or search in plain language. Each item shows whether it is an adopted form, a draft awaiting adoption, or reference material.</p></div><div class="hr-template-library__version"><span><strong>Guardianship index</strong><small>Version 1.0</small></span></div></header>
      <div class="hr-template-library__metrics"><article><span>HR source items</span><strong>56</strong></article><article><span>Categories</span><strong>8</strong></article><article><span>Files available</span><strong>43</strong></article></div>
      <div class="hr-template-library__notice"><div><strong>Controlled-source catalog</strong><span>Only formally adopted forms can start a working copy. Drafts and reference sources remain preview-only.</span></div></div>
      <div class="hr-template-library__filters"><form><label for="library-search">Search library</label><div><input id="library-search" placeholder="What do you need help with?" value="employee" /></div><button class="secondary-button" type="submit">Search</button></form><label>Category<select><option>All categories</option></select></label><label>Audience<select><option>Everything I can access</option></select></label><label>Rows<select><option>10</option></select></label><button class="secondary-button hr-template-library__clear" type="button">Clear</button></div>
      <div class="hr-template-library__result-summary"><span><strong>56</strong> matching HR source items</span><span>Page 1 of 6</span></div><div class="hr-template-library__list">${forms}</div><div class="hr-template-library__pagination"><button class="secondary-button" disabled type="button">Previous</button><span>1 of 6</span><button class="secondary-button" type="button">Next</button></div>
      </section></section></main>`
  }, theme)
}

async function expectLibraryLayoutUsable(page: import('@playwright/test').Page) {
  const geometry = await page.evaluate(() => {
    const summary = document.querySelector<HTMLElement>('.hr-template-library__summary')!
    const title = summary.querySelector<HTMLElement>('.hr-template-library__identity strong')!
    const badges = summary.querySelector<HTMLElement>('.hr-template-library__badges')!
    const details = document.querySelector<HTMLElement>('.hr-template-library__details')!
    const controls = Array.from(document.querySelectorAll<HTMLElement>([
      '.hr-template-library__summary',
      '.hr-template-library__filters button',
      '.hr-template-library__filters input',
      '.hr-template-library__filters select',
      '.hr-template-library__technical-details summary',
      '.hr-template-library__actions button',
      '.hr-template-library__pagination button',
    ].join(',')))
    const summaryBox = summary.getBoundingClientRect()
    const badgeBox = badges.getBoundingClientRect()
    const actions = Array.from(details.querySelectorAll<HTMLButtonElement>('.hr-template-library__actions button'), (button) => button.getBoundingClientRect())
    const actionsOverlap = actions.some((button, index) => actions.slice(index + 1).some((other) => (
      button.left < other.right
      && button.right > other.left
      && button.top < other.bottom
      && button.bottom > other.top
    )))
    return {
      actionsOverlap,
      badgesContained: badgeBox.left >= summaryBox.left - 1 && badgeBox.right <= summaryBox.right + 1,
      detailsContained: details.scrollWidth <= details.clientWidth + 1,
      minimumTargetHeight: Math.min(...controls.map((control) => control.getBoundingClientRect().height)),
      rootOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      summaryContained: summary.scrollWidth <= summary.clientWidth + 1,
      titleContained: title.scrollWidth <= title.clientWidth + 1 && getComputedStyle(title).whiteSpace === 'normal',
    }
  })
  expect(geometry.actionsOverlap).toBe(false)
  expect(geometry.badgesContained).toBe(true)
  expect(geometry.detailsContained).toBe(true)
  expect(geometry.minimumTargetHeight).toBeGreaterThanOrEqual(44)
  expect(geometry.rootOverflow).toBeLessThanOrEqual(1)
  expect(geometry.summaryContained).toBe(true)
  expect(geometry.titleContained).toBe(true)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Document Studio HR library stays compact and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installLibraryFixture(page, theme)
    await expect(page.locator('.hr-template-library__item')).toHaveCount(10)
    await expect(page.locator('.hr-template-library__details')).toHaveCount(1)
    await expectLibraryLayoutUsable(page)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`hr-document-library-${theme}.png`), fullPage: true })
  })
}

test('Document Library reflows at small-laptop, phone, and effective 200% zoom dimensions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium')
  const cases = [
    { height: 640, name: 'small-laptop', width: 1024 },
    // A 1280 × 720 desktop viewport exposes about 640 × 360 CSS pixels at 200% browser zoom.
    { height: 360, name: 'zoom-200', width: 640 },
    { height: 568, name: 'narrow-phone', width: 320 },
  ]
  for (const viewport of cases) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width })
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installLibraryFixture(page, 'light')
    await expectLibraryLayoutUsable(page)
    await page.screenshot({ path: testInfo.outputPath(`hr-document-library-${viewport.name}.png`), fullPage: true })
  }
})

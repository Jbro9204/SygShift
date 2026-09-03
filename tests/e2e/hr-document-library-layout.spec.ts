import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

async function installLibraryFixture(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme
    document.documentElement.style.colorScheme = selectedTheme
    const forms = Array.from({ length: 10 }, (_, index) => {
      const code = `GS-HR-${String(100 + index).padStart(3, '0')}`
      return `<article class="hr-template-library__item">
        <button aria-expanded="${index === 0}" class="hr-template-library__summary" type="button"><span class="hr-template-library__code">${code}</span><span class="hr-template-library__identity"><strong>${index === 0 ? 'Employee Information and Emergency Contact Record' : `Controlled employee form ${index + 1}`}</strong><small>Recruiting &amp; Onboarding</small></span><span class="hr-template-library__availability is-cataloged">Indexed</span><span aria-hidden="true">⌄</span></button>
        ${index === 0 ? '<div class="hr-template-library__details"><div><small>What this document is for</small><p>Captures current contact, communication, and emergency-contact information needed for employment administration.</p></div><dl><div><dt>Record class</dt><dd>Personnel File / Confidential Contact Information</dd></div><div><dt>Intended audience</dt><dd>Employee access</dd></div><div><dt>Handling</dt><dd>Restricted record</dd></div><div><dt>Controlled source</dt><dd>GS-HR-105_Employee_Information_and_Emergency_Contact_Record.docx</dd></div></dl><p class="hr-template-library__access-note">The form is indexed now. Its file will not be released until protected controls pass.</p></div>' : ''}
      </article>`
    }).join('')
    document.body.innerHTML = `<main style="max-width:1440px;margin:0 auto;padding:24px"><h1>Document Studio</h1><section aria-label="Document Studio" class="document-studio"><div aria-label="Document Studio sections" class="document-studio__tabs" role="tablist"><button aria-selected="false" role="tab">Overview</button><button aria-selected="true" class="active" role="tab">Library</button><button aria-selected="false" role="tab">Templates</button><button aria-selected="false" role="tab">Signatures</button><button aria-selected="false" role="tab">Policies</button><button aria-selected="false" role="tab">Processing</button></div><section class="hr-template-library hr-template-library--studio">
      <header class="hr-template-library__header"><div><p class="eyebrow">Controlled forms library</p><h2>Find the right document</h2><p>Search by form name, code, purpose, or everyday terms such as PTO, emergency contact, injury, complaint, or payroll correction.</p></div><div class="hr-template-library__version"><span><strong>Guardianship index</strong><small>Version 1.0</small></span></div></header>
      <div class="hr-template-library__metrics"><article><span>Forms you can find</span><strong>56</strong></article><article><span>Categories</span><strong>8</strong></article><article><span>Files released</span><strong>0</strong></article></div>
      <div class="hr-template-library__notice"><div><strong>One index, permission-aware results</strong><span>Blank-form discovery is separated from completed employee records.</span></div></div>
      <div class="hr-template-library__filters"><form><label for="library-search">Search library</label><div><input id="library-search" placeholder="What do you need help with?" /></div><button class="secondary-button" type="submit">Search</button></form><label>Category<select><option>All categories</option></select></label><label>Audience<select><option>Everything I can access</option></select></label><label>Rows<select><option>10</option></select></label></div>
      <div class="hr-template-library__result-summary"><span><strong>56</strong> matching forms</span><span>Page 1 of 6</span></div><div class="hr-template-library__list">${forms}</div><div class="hr-template-library__pagination"><button class="secondary-button" disabled type="button">Previous</button><span>1 of 6</span><button class="secondary-button" type="button">Next</button></div>
      </section></section></main>`
  }, theme)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Document Studio HR library stays compact and accessible in ${theme} mode`, async ({ page }, testInfo) => {
    await page.goto('/')
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().length > 0)
    await installLibraryFixture(page, theme)
    await expect(page.locator('.hr-template-library__item')).toHaveCount(10)
    await expect(page.locator('.hr-template-library__details')).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`hr-document-library-${theme}.png`), fullPage: true })
  })
}

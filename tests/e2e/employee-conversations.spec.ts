import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const viewport of [{ name: 'desktop', width: 1366, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Employee Conversations remains guided and usable on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await page.locator('#root').evaluate((root) => {
      const fixtureRoot = root.cloneNode(false) as HTMLElement
      root.replaceWith(fixtureRoot)
      fixtureRoot.innerHTML = `
        <main class="employee-conversations-page" id="main-content">
          <section class="employee-conversations-hero">
            <div><p class="eyebrow">Workforce · protected record</p><h1>Employee Conversations</h1><p>Record employee discussions and training in one guided, permanent timeline—without opening the rest of the confidential HR file.</p></div>
            <div class="employee-conversations-hero__rule"><span aria-hidden="true">✓</span><span><strong>Purpose-limited access</strong>Supervisors see assigned employees. HR and approved leaders can review the companywide record.</span></div>
          </section>
          <section aria-label="Employee conversation workflow" class="employee-conversations-guide">
            <div><span>1</span><strong>Choose employee</strong><small>Only people inside your scope appear.</small></div><div><span>2</span><strong>Record facts</strong><small>Use what was discussed or taught.</small></div><div><span>3</span><strong>Review</strong><small>Confirm the exact permanent record.</small></div><div><span>4</span><strong>Follow up</strong><small>Add progress without overwriting history.</small></div>
          </section>
          <section class="employee-conversations-person panel">
            <button class="employee-conversations-back" type="button">← Choose another employee</button>
            <div class="employee-conversations-person__main"><span aria-hidden="true" class="employee-conversations-avatar employee-conversations-avatar--large">AM</span><div><p class="eyebrow">Conversation record</p><h2>Alex Morgan</h2><p>SYG-1002 · Security Officer</p></div><div><span>Assigned supervisor</span><strong>Jordan Brown</strong></div><button class="primary-action" type="button">Record conversation</button></div>
          </section>
          <section aria-label="Conversation summary" class="employee-conversations-summary"><article><span>Current records</span><strong>3</strong></article><article><span>Follow-up open</span><strong>1</strong></article><article><span>Training records</span><strong>1</strong></article><article><span>Follow-up due</span><strong>0</strong></article></section>
          <section class="employee-conversations-notice"><span aria-hidden="true">✓</span><div><strong>Internal supervisory record</strong><p>This does not create discipline, attendance points, payroll changes, or an employee acknowledgment.</p></div><a href="#formal">Open formal HR workflow →</a></section>
          <section class="employee-conversations-worklist panel"><div class="section-heading"><div><p class="eyebrow">Permanent timeline</p><h2>Conversation history</h2><p>Nothing is silently overwritten.</p></div><div class="employee-conversations-filters"><label><span>Type</span><select><option>All types</option></select></label><label><span>Status</span><select><option>Current records</option></select></label></div></div><div class="employee-conversations-list"><article class="employee-conversation-card employee-conversation-card--open"><header><div><span class="employee-conversation-type">Training completed</span><h3>Radio procedure refresher</h3><p>09/17/2026 · Recorded by Jordan Brown</p></div><div><span class="employee-conversation-status">Follow-up open</span><button class="secondary-button secondary-button--small" type="button">View details</button></div></header><div class="employee-conversation-card__summary"><p>Reviewed the radio check-in steps and had the employee demonstrate the procedure correctly.</p><span class="employee-conversation-follow-up">Follow up 09/24/2026</span></div></article></div></section>
        </main>`
    })

    await expect(page.getByRole('heading', { name: 'Employee Conversations' })).toBeVisible()
    await expect(page.getByLabel('Employee conversation workflow')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Record conversation' })).toBeVisible()
    const overflow = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).map((element) => ({ className: String(element.className), right: Math.round(element.getBoundingClientRect().right), tag: element.tagName })))
    expect(overflow).toEqual([])
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`employee-conversations-${viewport.name}.png`), fullPage: true })
  })
}

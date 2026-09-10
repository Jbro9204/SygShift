import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
const fixture = `http://127.0.0.1:${4190 + Number(process.env.PLAYWRIGHT_PORT_OFFSET ?? 0)}/tests/fixtures/sphere-ui.html`
test('loads and decodes the exact SygSphere-only notification sound', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&home`)
  const asset = '/sounds/SygSphere_Notification_46421aca.mp3'
  const result = await page.evaluate(async (path) => {
    const response = await fetch(path)
    const bytes = await response.arrayBuffer()
    const context = new AudioContext()
    await context.decodeAudioData(bytes.slice(0))
    await context.close()
    return { bytes: Array.from(new Uint8Array(bytes)), contentType: response.headers.get('content-type'), ok: response.ok }
  }, asset)
  expect(result.ok).toBe(true)
  expect(result.contentType).toContain('audio/mpeg')
  expect(createHash('sha256').update(Uint8Array.from(result.bytes)).digest('hex')).toBe('46421aca65b0da122e826b43664ddd79cd40513149007da365b627069a99c059')
})
test('keeps a completed PDF frame visible while resize, zoom, and rotation renders settle', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 840 })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&pdf&theme=dark`)
  const viewer = page.getByRole('region', { name: 'PDF viewer for Stable preview fixture' })
  const canvas = page.getByLabel('Stable preview fixture, page 1')
  await expect(canvas).toBeVisible()
  await expect(viewer).toHaveAttribute('aria-busy', 'false')

  await canvas.evaluate((node) => {
    const target = node as HTMLCanvasElement
    const state = { blankFrames: 0, hiddenChanges: 0, samples: 0, stop: false }
    ;(window as typeof window & { pdfFrameAudit?: typeof state }).pdfFrameAudit = state
    new MutationObserver(() => { state.hiddenChanges += 1 }).observe(target, { attributeFilter: ['hidden'], attributes: true })
    const sample = () => {
      if (state.stop) return
      const context = target.getContext('2d')
      if (context && target.width && target.height) {
        const pixel = context.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data
        state.samples += 1
        if (pixel[3] === 0 || (pixel[0] > 245 && pixel[1] > 245 && pixel[2] > 245)) state.blankFrames += 1
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForTimeout(30)
  await page.getByRole('button', { name: 'Rotate clockwise' }).click()
  await page.setViewportSize({ width: 1040, height: 760 })
  await page.waitForTimeout(30)
  await page.setViewportSize({ width: 1120, height: 800 })
  await expect(viewer).toHaveAttribute('aria-busy', 'false')
  await page.waitForTimeout(100)

  const audit = await page.evaluate(() => {
    const state = (window as typeof window & { pdfFrameAudit?: { blankFrames: number; hiddenChanges: number; samples: number; stop: boolean } }).pdfFrameAudit!
    state.stop = true
    return state
  })
  expect(audit.samples).toBeGreaterThan(5)
  expect(audit.hiddenChanges).toBe(0)
  expect(audit.blankFrames).toBe(0)
})
test('creates a group using the real rounded form and sends a message', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByRole('button', { name: 'New message', exact: true }).click()
  await page.getByLabel('Conversation type').selectOption('group')
  await page.getByLabel('Group name').fill('Evening handoff')
  await page.getByRole('checkbox', { name: /Devon Ruiz/ }).check()
  await page.getByRole('button', { name: 'Create conversation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Evening handoff', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Write a message', exact: true }).fill('Ready for tonight’s handoff.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.sphere-message__body').filter({ hasText: 'Ready for tonight’s handoff.' })).toBeVisible()
})
test('sends with Enter and keeps Shift Enter as a new line in messages and replies', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  const message = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await message.fill('First line')
  await message.press('Shift+Enter')
  await message.type('Second line')
  await expect(message).toHaveValue('First line\nSecond line')
  await expect(page.locator('.sphere-message__body')).toHaveCount(0)
  await message.press('Enter')
  await expect(page.locator('.sphere-message__body').filter({ hasText: 'First line\nSecond line' })).toBeVisible()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  const reply = page.getByRole('textbox', { name: 'Write a thread reply', exact: true })
  await reply.fill('Thread reply')
  await reply.press('Enter')
  await expect(page.locator('.sphere-thread .sphere-message__body').filter({ hasText: 'Thread reply' })).toBeVisible()
})
test('inserts a validated participant mention and renders it as a highlighted identity', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByRole('button', { name: 'Mention a participant' }).click()
  await page.getByRole('button', { name: /Devon Ruiz/ }).click()
  const message = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await expect(message).toHaveValue('@Devon ')
  await message.press('Enter')
  await expect(page.locator('.sphere-mention').filter({ hasText: '@Devon' })).toBeVisible()
})
test('resolves a typed employee name without requiring a username', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  const message = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await message.fill('Please review this @devon')
  await expect(page.getByText('Matching “devon”')).toBeVisible()
  await message.press('Enter')
  await expect(page.locator('.sphere-mention').filter({ hasText: '@devon' })).toBeVisible()
})
test('sends a typed employee mention before ordinary sentence punctuation', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  const message = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await message.fill('Please review this @devon.')
  await message.press('Enter')
  await expect(page.locator('.sphere-mention').filter({ hasText: '@devon' })).toBeVisible()
  await expect(page.locator('.sphere-message__body').filter({ hasText: 'Please review this @devon.' })).toBeVisible()
})
test('lets each employee enlarge SygSphere text without scaling the rest of SygShift', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByLabel('Message text size').selectOption('large')
  await expect(page.locator('.sphere-workspace')).toHaveAttribute('data-text-size', 'large')
  await expect.poll(() => page.locator('.sphere-composer textarea').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(18)
})
test('keeps the identity, text-size, sound, and new-message controls usable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&theme=dark`)
  await expect(page.getByLabel('Message text size')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New message', exact: true })).toBeVisible()
  const overflow = await page.locator('.sphere-workspace').evaluate((node) => node.scrollWidth - node.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
test('fills the shell below the header without an empty page tail', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&shell`)
  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('#main-content')!
    const sphere = document.querySelector<HTMLElement>('.sphere-workspace')!
    return {
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
      mainBottom: Math.round(main.getBoundingClientRect().bottom),
      sphereBottom: Math.round(sphere.getBoundingClientRect().bottom),
      viewportBottom: window.innerHeight,
    }
  })
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
  expect(geometry.mainBottom).toBe(geometry.viewportBottom)
  expect(geometry.sphereBottom).toBe(geometry.viewportBottom)
  await page.screenshot({ path: testInfo.outputPath('sygsphere-shell.png'), fullPage: true })
})
test('keeps the mobile composer and Send control usable inside the full SygShift shell', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 412, height: 720 })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&mobile-shell&theme=dark`)
  const input = page.getByRole('textbox', { name: 'Write a message', exact: true })
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await input.evaluate((element) => element.blur())
  await expect(page.locator('.operational-clock')).toHaveCount(4)
  await expect(send).toBeInViewport()
  const initialClockClearance = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('.mobile-menu-button')!.getBoundingClientRect()
    const firstClock = document.querySelector<HTMLElement>('.operational-clock')!.getBoundingClientRect()
    return Math.round(firstClock.left - menu.right)
  })
  expect(initialClockClearance).toBeGreaterThanOrEqual(2)
  const clocksReachable = await page.locator('.operational-time-zone-strip').evaluate((strip) => {
    const lastClock = strip.querySelector<HTMLElement>('.operational-clock:last-child')!
    strip.scrollLeft = strip.scrollWidth
    const stripBox = strip.getBoundingClientRect()
    const clockBox = lastClock.getBoundingClientRect()
    const reachable = clockBox.left >= stripBox.left - 1 && clockBox.right <= stripBox.right + 1
    strip.scrollLeft = 0
    return reachable
  })
  expect(clocksReachable).toBe(true)
  await input.fill('Mobile send remains reachable')
  await expect(send).toBeVisible()
  const geometry = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.topbar')!
    const alert = document.querySelector<HTMLElement>('.workspace-alert-strip')!
    const sphere = document.querySelector<HTMLElement>('.sphere-workspace')!
    const composer = document.querySelector<HTMLElement>('.sphere-composer')!
    const sendButton = composer.querySelector<HTMLElement>('button[type="submit"]')!
    return {
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
      documentWidthOverflow: document.documentElement.scrollWidth - window.innerWidth,
      headerHeight: Math.round(header.getBoundingClientRect().height),
      alertHeight: Math.round(alert.getBoundingClientRect().height),
      sphereTop: Math.round(sphere.getBoundingClientRect().top),
      sphereBottom: Math.round(sphere.getBoundingClientRect().bottom),
      composerTop: Math.round(composer.getBoundingClientRect().top),
      composerBottom: Math.round(composer.getBoundingClientRect().bottom),
      sendBottom: Math.round(sendButton.getBoundingClientRect().bottom),
      viewportBottom: window.innerHeight,
    }
  })
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
  expect(geometry.documentWidthOverflow).toBeLessThanOrEqual(1)
  expect(geometry.headerHeight).toBeLessThanOrEqual(125)
  expect(geometry.alertHeight).toBeLessThanOrEqual(64)
  expect(geometry.sphereTop).toBeLessThanOrEqual(200)
  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.sphereBottom)
  expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.viewportBottom)
  await send.click()
  await expect(page.locator('.sphere-message__body').filter({ hasText: 'Mobile send remains reachable' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('sygsphere-mobile-shell.png'), fullPage: true })
})

for (const viewport of [
  { label: '14-inch-laptop', width: 1366, height: 768 },
  { label: 'scaled-laptop', width: 1280, height: 720 },
  { label: 'compact-laptop', width: 1024, height: 720 },
]) {
  test(`keeps SygSphere readable and actionable throughout the ${viewport.label} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto(`${fixture}?scope=${crypto.randomUUID()}&mobile-shell&theme=dark`)
    const input = page.getByRole('textbox', { name: 'Write a message', exact: true })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await input.evaluate((element) => element.blur())
    await expect(page.locator('.operational-clock')).toHaveCount(4)
    await expect(page.locator('.sphere-conversations')).toBeVisible()
    await expect(page.locator('.sphere-main')).toBeVisible()
    await expect(input).toBeVisible()
    await expect(send).toBeInViewport()

    const geometry = await page.evaluate(() => {
      const alert = document.querySelector<HTMLElement>('.workspace-alert-strip')!
      const composer = document.querySelector<HTMLElement>('.sphere-composer')!
      const sphere = document.querySelector<HTMLElement>('.sphere-workspace')!
      return {
        alertHeight: Math.round(alert.getBoundingClientRect().height),
        composerBottom: Math.round(composer.getBoundingClientRect().bottom),
        composerRight: Math.round(composer.getBoundingClientRect().right),
        documentHeightOverflow: document.documentElement.scrollHeight - window.innerHeight,
        documentWidthOverflow: document.documentElement.scrollWidth - window.innerWidth,
        sphereBottom: Math.round(sphere.getBoundingClientRect().bottom),
        sphereTop: Math.round(sphere.getBoundingClientRect().top),
      }
    })
    expect(geometry.documentHeightOverflow).toBeLessThanOrEqual(1)
    expect(geometry.documentWidthOverflow).toBeLessThanOrEqual(1)
    expect(geometry.alertHeight).toBeLessThanOrEqual(58)
    expect(geometry.sphereTop).toBeLessThanOrEqual(205)
    expect(geometry.sphereBottom).toBe(viewport.height)
    expect(geometry.composerBottom).toBeLessThanOrEqual(viewport.height)
    expect(geometry.composerRight).toBeLessThanOrEqual(viewport.width)

    await input.fill(`Message sent from the ${viewport.label} layout`)
    await send.click()
    await expect(page.locator('.sphere-message__body').filter({ hasText: `Message sent from the ${viewport.label} layout` })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`sygsphere-${viewport.label}.png`), fullPage: true })
  })
}
test('keeps Send above a mobile keyboard-sized viewport while composing', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 480 })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&mobile-shell&theme=dark`)
  const input = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await input.fill('Keyboard-safe message')
  await expect(page.locator('.operational-time-zone-strip')).toBeHidden()
  await expect(page.locator('.workspace-alert-strip')).toBeHidden()
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toBeInViewport()
  await send.click()
  await expect(page.locator('.sphere-message__body').filter({ hasText: 'Keyboard-safe message' })).toBeVisible()
  await input.evaluate((element) => element.blur())
  await expect(page.locator('.operational-time-zone-strip')).toBeVisible()
  await expect(page.locator('.workspace-alert-strip')).toBeVisible()
})
test('keeps the mobile composer compact and grows it only for multiline work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&mobile-shell&theme=dark`)
  const input = page.getByRole('textbox', { name: 'Write a message', exact: true })
  const initialHeight = await input.evaluate((element) => element.getBoundingClientRect().height)
  await input.fill('One\nTwo\nThree\nFour\nFive\nSix')
  await expect.poll(() => input.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initialHeight)
  const grownHeight = await input.evaluate((element) => element.getBoundingClientRect().height)
  expect(initialHeight).toBeLessThanOrEqual(48)
  expect(grownHeight).toBeLessThanOrEqual(106)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
})
test('shares an ordinary mobile attachment through the same-origin upload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  let uploadCount = 0
  await page.route('**/api/v1/sygsphere/files/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    uploadCount += 1
    const fileId = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: fileId, messageId: '30000000-0000-4000-8000-000000000002', state: 'clean' }) })
  })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&mobile-shell&theme=dark`)
  await page.locator('input[type="file"]').setInputFiles({ name: 'mobile-photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })
  await page.getByRole('button', { name: 'Share file', exact: true }).click()
  await expect(page.getByText('Your file has been shared.')).toBeVisible()
  expect(uploadCount).toBe(1)
})
test('transfers a normal desktop PDF through SygShift before reporting it shared', async ({ page }) => {
  let uploadedBytes: Buffer | null = null
  await page.route('**/api/v1/sygsphere/files/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    uploadedBytes = route.request().postDataBuffer()
    const fileId = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: fileId, messageId: '30000000-0000-4000-8000-000000000006', state: 'clean' }) })
  })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.locator('input[type="file"]').setInputFiles({ name: 'desktop-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n%%EOF') })
  await page.getByRole('button', { name: 'Share file', exact: true }).click()
  await expect(page.getByText('Your file has been shared.')).toBeVisible()
  expect(uploadedBytes?.toString()).toBe('%PDF-1.7\n%%EOF')
})
test('retries the retained mobile file when its first transfer does not reach storage', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  let uploadAttempts = 0
  await page.route('**/api/v1/sygsphere/files/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    uploadAttempts += 1
    const fileId = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill(uploadAttempts === 1
      ? { status: 503, contentType: 'application/json', headers: { 'x-request-id': '30000000-0000-4000-8000-000000000003' }, body: JSON.stringify({ detail: 'The file could not be stored.', error: 'sygsphere_file_error' }) }
      : { status: 200, contentType: 'application/json', body: JSON.stringify({ id: fileId, messageId: '30000000-0000-4000-8000-000000000004', state: 'clean' }) })
  })
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&mobile-shell&theme=dark`)
  await page.locator('input[type="file"]').setInputFiles({ name: 'mobile-resume.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) })
  await page.getByRole('button', { name: 'Share file', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click()
  await expect(page.getByText('Your file has been shared.')).toBeVisible()
  expect(uploadAttempts).toBe(2)
})
test('keeps drafts over reload, retains a failed send and retries successfully', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  const input = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await input.fill('Do not lose this handoff draft')
  await page.reload()
  await expect(input).toHaveValue('Do not lose this handoff draft')
  await page.getByRole('button', { name: 'Simulate one failed send' }).click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Connection interrupted')
  await expect(input).toHaveValue('Do not lose this handoff draft')
  await page.getByRole('button', { name: 'Retry send', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(page.locator('.sphere-message__body')).toHaveCount(1)
})
test('opens an actual thread, sends a reply, saves and searches it', async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByRole('textbox', { name: 'Write a message', exact: true }).fill('Please confirm coverage')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await page.getByRole('textbox', { name: 'Write a thread reply', exact: true }).fill('Coverage confirmed')
  await page.locator('.sphere-thread').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.sphere-thread .sphere-message__body').filter({ hasText: 'Coverage confirmed' })).toBeVisible()
  await page.locator('.sphere-thread article').filter({ hasText: 'Coverage confirmed' }).getByRole('button', { name: 'Save message', exact: true }).click()
  await page.getByRole('button', { name: 'Close thread' }).click()
  const back = page.getByRole('button', { name: 'Back to conversations' })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: 'Saved', exact: true }).click()
  await expect(page.locator('.sphere-result').filter({ hasText: 'Coverage confirmed' })).toBeVisible()
})
test('dismisses message action popovers without disrupting their controls', async ({ page }, testInfo) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}`)
  await page.getByRole('textbox', { name: 'Write a message', exact: true }).fill('Check message actions')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const message = page.locator('article').filter({ hasText: 'Check message actions' })
  const reaction = message.locator('summary[aria-label="Add reaction"]')
  const more = message.locator('summary[aria-label="More message actions"]')

  await reaction.click()
  await expect(reaction).toHaveAttribute('aria-expanded', 'true')
  await reaction.click()
  await expect(reaction).toHaveAttribute('aria-expanded', 'false')

  await reaction.click()
  await more.click()
  await expect(reaction).toHaveAttribute('aria-expanded', 'false')
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  const outside = page.locator('.sphere-chat-header h2')
  if (testInfo.project.name === 'mobile-chromium') await outside.tap()
  else await outside.click()
  await expect(more).toHaveAttribute('aria-expanded', 'false')

  await more.click()
  await more.press('Escape')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(more).toBeFocused()

  await reaction.click()
  const thumbsUp = message.getByRole('button', { name: 'React 👍' })
  await thumbsUp.focus()
  await thumbsUp.press('Enter')
  await expect(reaction).toHaveAttribute('aria-expanded', 'false')
  await expect(message.getByRole('button', { name: '👍 reaction, 1' })).toHaveAttribute('aria-pressed', 'true')

  const draft = page.getByRole('textbox', { name: 'Write a message', exact: true })
  await draft.fill('Keep this draft while using message actions')
  await more.click()
  const save = message.getByRole('button', { name: 'Save message', exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(message.getByRole('button', { name: 'Unsave message', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(draft).toHaveValue('Keep this draft while using message actions')

  await more.click()
  const pin = message.getByRole('button', { name: 'Pin message', exact: true })
  await pin.focus()
  await pin.press('Enter')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(message.getByText('📌 Pinned')).toBeVisible()
})
test('live message reaches the other account without refresh and has a separate launcher badge', async ({ context }) => {
  const scope = crypto.randomUUID(); const first = await context.newPage(); const second = await context.newPage()
  await first.goto(`${fixture}?scope=${scope}`); await second.goto(`${fixture}?scope=${scope}&second&home`)
  await expect(first.getByRole('textbox', { name: 'Write a message', exact: true })).toBeVisible()
  await first.getByRole('textbox', { name: 'Write a message', exact: true }).fill('Live two-account handoff')
  await first.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(second.locator('.sphere-launcher .sphere-badge')).toHaveText('1')
  await expect(second.locator('.sphere-toast')).toContainText('SygSphere')
  await second.locator('.sphere-toast a').click()
  await expect(second.locator('.sphere-message__body')).toContainText('Live two-account handoff')
})
test('a structured mention raises a targeted SygSphere notification for the selected employee', async ({ context }) => {
  const scope = crypto.randomUUID(); const sender = await context.newPage(); const recipient = await context.newPage()
  await sender.goto(`${fixture}?scope=${scope}`); await recipient.goto(`${fixture}?scope=${scope}&second&home`)
  await sender.getByRole('button', { name: 'Mention a participant' }).click()
  await sender.getByRole('button', { name: /Devon Ruiz/ }).click()
  await sender.getByRole('textbox', { name: 'Write a message', exact: true }).press('Enter')
  await expect(recipient.locator('.sphere-toast')).toContainText('You were mentioned')
  await recipient.locator('.sphere-toast a').click()
  await expect(recipient.locator('.sphere-mention--self')).toHaveText('@Devon')
})
for (const theme of ['light', 'dark']) test(`comfortable ${theme} controls and no horizontal overflow`, async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&theme=${theme}`)
  await expect(page.getByRole('textbox', { name: 'Write a message', exact: true })).toBeVisible()
  const result = await page.locator('.sphere-workspace').evaluate((node) => ({ overflow: node.scrollWidth - node.clientWidth, font: getComputedStyle(node.querySelector('textarea')!).fontFamily, radius: getComputedStyle(node.querySelector('textarea')!).borderRadius }))
  expect(result.overflow).toBeLessThanOrEqual(1); expect(result.font).not.toContain('monospace'); expect(parseFloat(result.radius)).toBeGreaterThanOrEqual(8)
  await page.screenshot({ path: `test-results/sygsphere-${theme}-${test.info().project.name}.png`, fullPage: true })
})

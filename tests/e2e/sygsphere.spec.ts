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
  await input.fill('Mobile send remains reachable')
  await expect(send).toBeVisible()
  const geometry = await page.evaluate(() => {
    const sphere = document.querySelector<HTMLElement>('.sphere-workspace')!
    const composer = document.querySelector<HTMLElement>('.sphere-composer')!
    const sendButton = composer.querySelector<HTMLElement>('button[type="submit"]')!
    return {
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
      sphereBottom: Math.round(sphere.getBoundingClientRect().bottom),
      composerBottom: Math.round(composer.getBoundingClientRect().bottom),
      sendBottom: Math.round(sendButton.getBoundingClientRect().bottom),
      viewportBottom: window.innerHeight,
    }
  })
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
  expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.sphereBottom)
  expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.viewportBottom)
  await send.click()
  await expect(page.locator('.sphere-message__body').filter({ hasText: 'Mobile send remains reachable' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('sygsphere-mobile-shell.png'), fullPage: true })
})
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
for (const theme of ['light', 'dark']) test(`comfortable ${theme} controls and no horizontal overflow`, async ({ page }) => {
  await page.goto(`${fixture}?scope=${crypto.randomUUID()}&theme=${theme}`)
  await expect(page.getByRole('textbox', { name: 'Write a message', exact: true })).toBeVisible()
  const result = await page.locator('.sphere-workspace').evaluate((node) => ({ overflow: node.scrollWidth - node.clientWidth, font: getComputedStyle(node.querySelector('textarea')!).fontFamily, radius: getComputedStyle(node.querySelector('textarea')!).borderRadius }))
  expect(result.overflow).toBeLessThanOrEqual(1); expect(result.font).not.toContain('monospace'); expect(parseFloat(result.radius)).toBeGreaterThanOrEqual(8)
  await page.screenshot({ path: `test-results/sygsphere-${theme}-${test.info().project.name}.png`, fullPage: true })
})

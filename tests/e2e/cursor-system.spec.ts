import { expect, test } from '@playwright/test'

const cursorNames = ['default', 'link', 'text', 'busy', 'move', 'blocked'] as const

test('authenticated fine pointers receive every semantic SygShift cursor', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root) => {
    document.documentElement.setAttribute('data-sygshift-cursors', 'active')
    root.innerHTML = `
      <main class="app-shell" style="display:grid;gap:16px;padding:24px">
        <p id="default-surface">Ordinary application surface</p>
        <button id="action" type="button">Action</button>
        <input id="text" type="text" value="Editable text" />
        <button id="blocked" disabled type="button">Blocked</button>
        <div id="busy" aria-busy="true"><button type="button">Processing</button></div>
        <div id="move" data-sygshift-drag-handle="true">Drag handle</div>
        <input id="date" type="date" />
      </main>`
  })

  const cursors = await page.locator('#root').evaluate(() => Object.fromEntries(
    ['default-surface', 'action', 'text', 'blocked', 'busy', 'move', 'date'].map((id) => [id, getComputedStyle(document.getElementById(id)!).cursor]),
  )) as Record<string, string>

  if (testInfo.project.name.includes('mobile')) {
    for (const cursor of Object.values(cursors)) expect(cursor).not.toContain('/cursors/sygshift-')
    return
  }

  expect(cursors['default-surface']).toContain('sygshift-default.svg')
  expect(cursors['action']).toContain('sygshift-link.svg')
  expect(cursors['text']).toContain('sygshift-text.svg')
  expect(cursors['blocked']).toContain('sygshift-blocked.svg')
  expect(cursors['busy']).toContain('sygshift-busy.svg')
  expect(cursors['move']).toContain('sygshift-move.svg')
  expect(cursors['date']).toContain('sygshift-link.svg')

  await page.emulateMedia({ forcedColors: 'active' })
  const accessibleCursors = await page.locator('#root').evaluate(() => Object.fromEntries(
    ['default-surface', 'action', 'text', 'blocked', 'busy', 'move'].map((id) => [id, getComputedStyle(document.getElementById(id)!).cursor]),
  )) as Record<string, string>
  for (const cursor of Object.values(accessibleCursors)) expect(cursor).not.toContain('/cursors/sygshift-')
  expect(accessibleCursors['action']).toBe('pointer')
  expect(accessibleCursors['text']).toBe('text')
  expect(accessibleCursors['blocked']).toBe('not-allowed')
  expect(accessibleCursors['busy']).toBe('progress')
  expect(accessibleCursors['move']).toBe('move')
})

test('all cursor artwork remains at actual approved size on light and dark surfaces', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.locator('#root').evaluate((root, names) => {
    root.innerHTML = `
      <main style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));min-height:100vh">
        ${['#fffdf7', '#101317'].map((background) => `
          <section style="align-content:start;background:${background};display:grid;gap:18px;padding:30px">
            ${names.map((name) => `<figure style="align-items:center;color:${background === '#101317' ? '#f5f1e8' : '#1b1b19'};display:flex;gap:14px;margin:0"><img alt="${name} cursor" height="26" src="/cursors/sygshift-${name}.svg" width="24"><figcaption>${name}</figcaption></figure>`).join('')}
          </section>`).join('')}
      </main>`
  }, cursorNames)

  for (const name of cursorNames) {
    const images = page.getByAltText(`${name} cursor`)
    await expect(images).toHaveCount(2)
    for (const image of await images.all()) {
      await expect(image).toHaveJSProperty('naturalWidth', 24)
      await expect(image).toHaveJSProperty('naturalHeight', 26)
      const box = await image.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBe(24)
      expect(box!.height).toBe(26)
    }
  }

  await page.screenshot({ path: testInfo.outputPath('sygshift-cursors-actual-size.png'), fullPage: true })
})

test('cursor mappings remain stable at common display scales and browser zoom', async ({ browser }) => {
  for (const deviceScaleFactor of [1, 1.25, 1.5]) {
    const context = await browser.newContext({
      deviceScaleFactor,
      hasTouch: false,
      viewport: { height: 720, width: 1280 },
    })
    const page = await context.newPage()
    await page.goto('/')
    await page.locator('#root').evaluate((root) => {
      document.documentElement.setAttribute('data-sygshift-cursors', 'active')
      root.innerHTML = '<main><button id="scale-action" type="button">Scaled action</button><input id="scale-text" type="text" value="Text"></main>'
    })

    for (const zoom of ['100%', '125%', '150%']) {
      await page.locator('body').evaluate((body, value) => { body.style.zoom = value }, zoom)
      const cursors = await page.locator('#root').evaluate(() => ({
        action: getComputedStyle(document.getElementById('scale-action')!).cursor,
        text: getComputedStyle(document.getElementById('scale-text')!).cursor,
      }))
      expect(cursors.action).toContain('sygshift-link.svg')
      expect(cursors.text).toContain('sygshift-text.svg')
    }

    await context.close()
  }
})

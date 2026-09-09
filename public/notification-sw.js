/* Push only: no fetch handler, offline cache, or interception of application requests. */
const SETTINGS = 'sygshift-push-settings-v1'
const OWNER = '/__sygshift_push_owner'
let processing = Promise.resolve()
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (!['sygshift:push-owner','sygshift:push-presented','sygshift:push-sound'].includes(event.data?.type)) return
  processing = processing.catch(() => {}).then(async () => {
    const cache = await caches.open(SETTINGS)
    const owner = await (await cache.match(OWNER))?.json() || {}
    if (event.data.type === 'sygshift:push-owner') {
      await cache.put(OWNER, new Response(JSON.stringify({ employeeId: event.data.employeeId || null, muted: event.data.muted === true })))
    } else if (event.data.type === 'sygshift:push-sound') {
      await cache.put(OWNER, new Response(JSON.stringify({ ...owner, muted: event.data.muted === true })))
    } else if (owner.employeeId === event.data.employeeId && typeof event.data.id === 'string') {
      const seen = await (await cache.match('/__sygshift_push_seen'))?.json() || []
      await cache.put('/__sygshift_push_seen', new Response(JSON.stringify([...new Set([...seen, event.data.id])].slice(-250))))
    }
    event.ports[0]?.postMessage({ saved: true })
  })
  event.waitUntil(processing)
})
self.addEventListener('push', (event) => {
  processing = processing.catch(() => {}).then(async () => {
    let payload
    try { payload = event.data?.json() } catch { return }
    if (!payload || typeof payload.id !== 'string' || typeof payload.employeeId !== 'string') return
    const cache = await caches.open(SETTINGS)
    const owner = await (await cache.match(OWNER))?.json()
    if (owner?.employeeId !== payload.employeeId) return
    const seenKey = '/__sygshift_push_seen'
    const seen = await (await cache.match(seenKey))?.json() || []
    if (seen.includes(payload.id)) return
    await cache.put(seenKey, new Response(JSON.stringify([...seen, payload.id].slice(-250))))
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const visible = clients.filter((client) => client.visibilityState === 'visible')
    if (visible.length) {
      visible.forEach((client) => client.postMessage({ type: 'sygshift:notification', id: payload.id }))
      return
    }
    const path = typeof payload.path === 'string' && payload.path.startsWith('/') && !payload.path.startsWith('//') && !/[\\\r\n]/.test(payload.path) ? payload.path : '/notifications'
    await self.registration.showNotification('SygShift update', {
      body: 'You have a new update. Open SygShift to review it securely.',
      icon: '/pwa/sygshift-192.png', tag: `sygshift-${payload.id}`, renotify: false,
      silent: owner.muted === true,
      data: { path, employeeId: payload.employeeId },
    })
  })
  event.waitUntil(processing)
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const owner = await (await (await caches.open(SETTINGS)).match(OWNER))?.json()
    const requested = owner?.employeeId === event.notification.data?.employeeId ? event.notification.data?.path : '/notifications'
    const url = new URL(requested || '/notifications', self.location.origin)
    if (url.origin !== self.location.origin) return
    // Opening a destination never marks a required notification acknowledged.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const matching = windows.find((client) => client.url === url.href)
    if (matching) await matching.focus()
    else await self.clients.openWindow(url.href)
  })())
})

const channelName = 'sygshift-shared-identity-v1'
const messageType = 'sygshift-shared-session'

export type SharedIdentityBrowserEvent = 'cleared' | 'updated'

export function publishSharedIdentityBrowserEvent(action: SharedIdentityBrowserEvent): void {
  if (typeof globalThis.BroadcastChannel !== 'function') return
  try {
    const channel = new BroadcastChannel(channelName)
    channel.postMessage({ action, type: messageType, version: 1 })
    channel.close()
  } catch {
    // Cross-tab coordination cannot block a valid sign-in or sign-out.
  }
}

export function subscribeToSharedIdentityBrowserEvents(
  listener: (action: SharedIdentityBrowserEvent) => void,
): () => void {
  if (typeof globalThis.BroadcastChannel !== 'function') return () => undefined
  try {
    const channel = new BroadcastChannel(channelName)
    const handleMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { action?: unknown, type?: unknown, version?: unknown } | null
      if (
        message?.type !== messageType
        || message.version !== 1
        || (message.action !== 'cleared' && message.action !== 'updated')
      ) return
      listener(message.action)
    }
    channel.addEventListener('message', handleMessage)
    return () => {
      channel.removeEventListener('message', handleMessage)
      channel.close()
    }
  } catch {
    return () => undefined
  }
}

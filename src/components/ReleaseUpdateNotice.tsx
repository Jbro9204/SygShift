import { RefreshCw } from 'lucide-react'
import { useIsMutating } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { releaseAssetFromHtml } from '../lib/releaseUpdate'

const RELEASE_CHECK_INTERVAL_MS = 2 * 60 * 1000

function currentReleaseAsset() {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null
}

export function ReleaseUpdateNotice() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const activeSaves = useIsMutating()
  const saveInProgress = activeSaves > 0

  useEffect(() => {
    const loadedAsset = currentReleaseAsset()
    if (!loadedAsset) return undefined

    let active = true
    let updateDetected = false

    const checkForUpdate = async () => {
      if (!active || updateDetected) return

      try {
        const checkUrl = new URL('/', window.location.origin)
        checkUrl.searchParams.set('release_check', Date.now().toString())
        const response = await fetch(checkUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'text/html' },
        })
        if (!response.ok || !active) return

        const latestAsset = releaseAssetFromHtml(await response.text())
        if (!latestAsset || !active) return

        const latestAssetUrl = new URL(latestAsset, window.location.origin).href
        if (latestAssetUrl !== loadedAsset) {
          updateDetected = true
          setUpdateAvailable(true)
        }
      } catch {
        // A temporary network failure should never interrupt the active workspace.
      }
    }

    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void checkForUpdate()
    }

    const intervalId = window.setInterval(() => void checkForUpdate(), RELEASE_CHECK_INTERVAL_MS)
    window.addEventListener('focus', checkForUpdate)
    document.addEventListener('visibilitychange', checkWhenVisible)
    void checkForUpdate()

    return () => {
      active = false
      window.clearInterval(intervalId)
      window.removeEventListener('focus', checkForUpdate)
      document.removeEventListener('visibilitychange', checkWhenVisible)
    }
  }, [])

  if (!updateAvailable) return null

  return (
    <aside aria-live="polite" className="release-update-notice" role="status">
      <RefreshCw aria-hidden="true" size={22} />
      <div>
        <strong>A SygShift update is ready</strong>
        <span>
          {saveInProgress
            ? 'Finish the current save, then refresh to load the update.'
            : 'Refresh once to load the latest forms and fixes.'}
        </span>
      </div>
      <button
        className="release-update-notice__action"
        disabled={saveInProgress}
        onClick={() => window.location.reload()}
        type="button"
      >
        Refresh SygShift
      </button>
    </aside>
  )
}

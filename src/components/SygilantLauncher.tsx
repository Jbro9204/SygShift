import { useState } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { launchSygilantPlatform } from '../data/platformLaunch'

type SygilantLauncherProps = {
  launch?: () => Promise<string>
  navigate?: (url: string) => void
}

export function SygilantLauncher({
  launch = launchSygilantPlatform,
  navigate = (url) => window.location.assign(url),
}: SygilantLauncherProps) {
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLaunch() {
    if (launching) return
    setLaunching(true)
    setError(null)

    try {
      const launchUrl = await launch()
      navigate(launchUrl)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sygilant could not be opened securely. Please try again.')
      setLaunching(false)
    }
  }

  return (
    <div className="platform-launcher-shell">
      <button
        aria-label={launching ? 'Opening Sygilant main platform' : 'Open Sygilant main platform'}
        aria-describedby={error ? 'sygilant-launch-error' : undefined}
        className="platform-launcher platform-launcher--sygilant"
        disabled={launching}
        onClick={() => void handleLaunch()}
        title="Open Sygilant main platform"
        type="button"
      >
        <span aria-hidden="true" className="platform-launcher__emblem">
          <img src="/branding/sygilant-horizontal.png" alt="" />
        </span>
        <span aria-hidden="true" className="platform-launcher__brand">
          <img src="/branding/sygilant-horizontal.png" alt="" />
          <small>MAIN PLATFORM</small>
        </span>
        {launching ? <LoaderCircle aria-hidden="true" className="platform-launcher__spinner" size={18} /> : null}
      </button>
      {error ? (
        <p className="platform-launcher__error" id="sygilant-launch-error" role="alert">
          <TriangleAlert aria-hidden="true" size={15} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

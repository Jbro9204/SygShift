import { useState } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import {
  launchSygilantPlatform,
  submitSygilantPlatformLaunch,
  type SygilantPlatformLaunch,
} from '../data/platformLaunch'

type SygilantLauncherProps = {
  launch?: () => Promise<SygilantPlatformLaunch>
  submit?: (launch: SygilantPlatformLaunch) => void
}

export function SygilantLauncher({
  launch = launchSygilantPlatform,
  submit = submitSygilantPlatformLaunch,
}: SygilantLauncherProps) {
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLaunch() {
    if (launching) return
    setLaunching(true)
    setError(null)

    try {
      const handoff = await launch()
      submit(handoff)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sygilant could not be opened securely. Please try again.')
      setLaunching(false)
    }
  }

  return (
    <div className="syg-launcher-shell platform-launcher-shell">
      <button
        aria-label={launching ? 'Opening Sygilant main platform' : 'Open Sygilant main platform'}
        aria-describedby={error ? 'sygilant-launch-error' : undefined}
        className="syg-launcher syg-launcher--sygilant platform-launcher platform-launcher--sygilant"
        disabled={launching}
        onClick={() => void handleLaunch()}
        title="Sygilant — Main Platform"
        type="button"
      >
        <span aria-hidden="true" className="syg-launcher__emblem platform-launcher__emblem">
          <img src="/branding/sygilant-horizontal-transparent.png" alt="" />
        </span>
        <span aria-hidden="true" className="syg-launcher__brand platform-launcher__brand">
          <img src="/branding/sygilant-horizontal-transparent.png" alt="" />
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

import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { ClipboardCheck, FileClock, ListChecks } from 'lucide-react'

const reviewDestinations = [
  {
    description: 'Payroll-impacting time records that need a decision or correction.',
    icon: ListChecks,
    label: 'Exceptions',
    path: '/time/review',
  },
  {
    description: 'Employee-submitted time changes waiting for authorized review.',
    icon: FileClock,
    label: 'Correction Requests',
    path: '/time/review?show=pending_correction',
  },
  {
    description: 'Schedule, punch, and call-off differences after shifts end.',
    icon: ClipboardCheck,
    label: 'Daily Reconciliation',
    path: '/time/daily-review',
  },
] as const

export function TimeReviewQueueNavigation({
  canAccessDailyReview,
  canAccessExceptions,
}: {
  canAccessDailyReview: boolean
  canAccessExceptions: boolean
}) {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const correctionRequestsActive = location.pathname === '/time/review' && searchParams.get('show') === 'pending_correction'
  const visibleDestinations = reviewDestinations.filter((destination) => (
    destination.label === 'Daily Reconciliation' ? canAccessDailyReview : canAccessExceptions
  ))

  return (
    <nav aria-label="Review Queue views" className="time-review-queue-navigation">
      {visibleDestinations.map((destination) => {
        const Icon = destination.icon
        const active = destination.label === 'Daily Reconciliation'
          ? location.pathname === '/time/daily-review'
          : destination.label === 'Correction Requests'
            ? correctionRequestsActive
            : location.pathname === '/time/review' && !correctionRequestsActive

        return (
          <NavLink
            className={active ? 'time-review-queue-navigation__item is-active' : 'time-review-queue-navigation__item'}
            key={destination.label}
            to={destination.path}
          >
            <Icon aria-hidden="true" size={19} />
            <span>
              <strong>{destination.label}</strong>
              <small>{destination.description}</small>
            </span>
          </NavLink>
        )
      })}
    </nav>
  )
}

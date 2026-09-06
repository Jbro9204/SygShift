import { useQuery } from '@tanstack/react-query'
import { Bell, BellRing } from 'lucide-react'
import { Link } from 'react-router-dom'
import { getMyNotificationBadge } from '../data/notifications'
import { isSupabaseConfigured } from '../lib/supabase'

export function HeaderNotificationButton({ enabled }: { enabled: boolean }) {
  const badgeQuery = useQuery({
    enabled: enabled && isSupabaseConfigured,
    queryFn: getMyNotificationBadge,
    queryKey: ['my-notifications', 'badge'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const unread = badgeQuery.data?.unread ?? 0
  const urgent = (badgeQuery.data?.urgent ?? 0) > 0
  const requiresAction = (badgeQuery.data?.requiresAction ?? 0) > 0
  const BellIcon = unread > 0 ? BellRing : Bell
  const label = unread > 0
    ? `Open notifications: ${unread} unread${requiresAction ? ', action required' : ''}`
    : 'Open notifications'

  return <Link aria-label={label} className={`header-notification${unread ? ' header-notification--unread' : ''}${urgent ? ' header-notification--urgent' : ''}`} title={label} to="/notifications">
    <BellIcon aria-hidden="true" size={21} />
    {unread > 0 ? <span aria-hidden="true" className="header-notification__badge">{unread > 99 ? '99+' : unread}</span> : null}
  </Link>
}

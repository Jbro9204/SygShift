import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ShieldCheck, UserCog } from 'lucide-react'
import { Link } from 'react-router-dom'
import { canAccessRoute } from '../app/accessPolicy'
import { DataStatePanel } from '../components/DataStatePanel'
import { getSessionContext } from '../data/auth'
import { isSupabaseConfigured } from '../lib/supabase'

export function AdministrationAccessPage() {
  const sessionQuery = useQuery({
    enabled: isSupabaseConfigured,
    queryFn: getSessionContext,
    queryKey: ['session-context'],
  })

  if (!isSupabaseConfigured) {
    return <main className="page administration-access-page"><DataStatePanel icon={ShieldCheck} title="Users & Roles needs the secure connection" tone="setup"><p>Administration becomes available after the protected data connection is restored.</p></DataStatePanel></main>
  }

  if (sessionQuery.isPending) {
    return <main className="page administration-access-page"><DataStatePanel icon={ShieldCheck} title="Loading users and roles"><p>Checking your account and role-management access.</p></DataStatePanel></main>
  }

  if (sessionQuery.isError) {
    return <main className="page administration-access-page"><DataStatePanel icon={ShieldCheck} title="Users & Roles unavailable" tone="error"><p>{sessionQuery.error.message}</p></DataStatePanel></main>
  }

  const canViewUsers = canAccessRoute('/users', sessionQuery.data)
  const canViewRoles = canAccessRoute('/access-control', sessionQuery.data)

  return (
    <main className="page administration-access-page">
      <section className="page-intro administration-access-hero">
        <div><p className="eyebrow">Administration</p><h1>Users & Roles</h1><p className="page-summary">One place to manage sign-in accounts, role membership, and permission design without combining their protected authority.</p></div>
      </section>
      <section aria-label="User and role administration" className="administration-access-grid">
        {canViewUsers ? <Link className="administration-access-card" to="/users"><UserCog aria-hidden="true" /><span><strong>User Accounts</strong><small>Employee logins, account status, onboarding, MFA, and recovery.</small></span><ArrowRight aria-hidden="true" /></Link> : null}
        {canViewRoles ? <Link className="administration-access-card" to="/access-control"><ShieldCheck aria-hidden="true" /><span><strong>Roles & Permissions</strong><small>Role definitions, group permissions, memberships, and individual access.</small></span><ArrowRight aria-hidden="true" /></Link> : null}
      </section>
    </main>
  )
}

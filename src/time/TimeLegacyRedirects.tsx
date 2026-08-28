import { Navigate, useLocation } from 'react-router-dom'

function LegacyTimeRedirect({ destination }: { destination: string }) {
  const location = useLocation()
  return <Navigate replace to={`${destination}${location.search}${location.hash}`} />
}

export function LegacyTimeToolsRedirect() {
  return <LegacyTimeRedirect destination="/time/my-time" />
}

export function LegacyTimecardsRedirect() {
  return <LegacyTimeRedirect destination="/time/team" />
}

export function LegacyTimeExceptionsRedirect() {
  return <LegacyTimeRedirect destination="/time/review" />
}

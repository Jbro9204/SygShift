import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'

export function RouteErrorPage() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error) && error.status === 404
    ? 'That page could not be found.'
    : 'The page could not be opened.'

  return (
    <main className="route-error">
      <img src="/brand/sygshift-logo.png" alt="SygShift" />
      <h1>{message}</h1>
      <p>No schedule or employee information was changed.</p>
      <Link className="primary-action" to="/">
        Return to overview
      </Link>
    </main>
  )
}

import { Navigate, useLocation } from 'react-router-dom'

function PayrollRedirect({ pathname }: { pathname: string }) {
  const location = useLocation()
  return <Navigate replace to={{ pathname, search: location.search }} />
}

export function PayrollLegacyExportRedirect() {
  return <PayrollRedirect pathname="/payroll/export" />
}

export function PayrollLegacyRulesRedirect() {
  return <PayrollRedirect pathname="/payroll/rules" />
}

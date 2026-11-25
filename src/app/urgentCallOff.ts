export function isUrgentCallOffLocation(pathname: string, search: string): boolean {
  return pathname === '/time/my-time' && new URLSearchParams(search).get('report') === 'call-off'
}

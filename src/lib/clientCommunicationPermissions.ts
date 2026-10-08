export const clientFilesViewPermission = 'clients.view'
export const clientFilesManagePermission = 'clients.manage'
export const clientCommunicationsViewPermission = 'clients.communications.view'
export const clientCommunicationsManagePermission = 'clients.communications.manage'

function dependenciesForPermission(code: string): string[] {
  if (code === clientCommunicationsManagePermission) {
    return [
      clientCommunicationsViewPermission,
      clientFilesManagePermission,
      clientFilesViewPermission,
    ]
  }
  if (code === clientCommunicationsViewPermission) return [clientFilesViewPermission]
  return []
}

export function clientCommunicationPermissionBlockedBy(
  code: string,
  deniedCodes: ReadonlySet<string>,
): string[] {
  return [code, ...dependenciesForPermission(code)].filter((permissionCode) => deniedCodes.has(permissionCode))
}

export function addClientCommunicationDependencies(
  current: Set<string>,
  deniedCodes: ReadonlySet<string> = new Set(),
): Set<string> {
  const next = new Set(current)
  if (next.has(clientCommunicationsManagePermission)) {
    dependenciesForPermission(clientCommunicationsManagePermission).forEach((permissionCode) => {
      if (!deniedCodes.has(permissionCode)) next.add(permissionCode)
    })
  }
  if (next.has(clientCommunicationsViewPermission) && !deniedCodes.has(clientFilesViewPermission)) {
    next.add(clientFilesViewPermission)
  }
  return next
}

export function effectiveClientCommunicationPermissions(
  current: Set<string>,
  deniedCodes: ReadonlySet<string>,
): Set<string> {
  const next = new Set([...current].filter((code) => !deniedCodes.has(code)))
  if (!next.has(clientFilesViewPermission)) {
    next.delete(clientCommunicationsViewPermission)
    next.delete(clientCommunicationsManagePermission)
  }
  if (!next.has(clientFilesManagePermission) || !next.has(clientCommunicationsViewPermission)) {
    next.delete(clientCommunicationsManagePermission)
  }
  return next
}

export function toggleClientCommunicationPermission(
  current: Set<string>,
  code: string,
  deniedCodes: ReadonlySet<string> = new Set(),
): Set<string> {
  const next = new Set(current)
  if (next.has(code)) {
    next.delete(code)
    if (code === clientFilesViewPermission) {
      next.delete(clientCommunicationsViewPermission)
      next.delete(clientCommunicationsManagePermission)
    }
    if (code === clientFilesManagePermission || code === clientCommunicationsViewPermission) {
      next.delete(clientCommunicationsManagePermission)
    }
  } else {
    if (clientCommunicationPermissionBlockedBy(code, deniedCodes).length > 0) return next
    next.add(code)
    dependenciesForPermission(code).forEach((permissionCode) => {
      if (!deniedCodes.has(permissionCode)) next.add(permissionCode)
    })
  }
  return next
}

export function setClientCommunicationPermissionCategory(
  current: Set<string>,
  codes: string[],
  selected: boolean,
  deniedCodes: ReadonlySet<string> = new Set(),
): Set<string> {
  const next = new Set(current)
  codes.forEach((code) => {
    if (!selected) {
      next.delete(code)
      return
    }
    if (clientCommunicationPermissionBlockedBy(code, deniedCodes).length > 0) return
    next.add(code)
    dependenciesForPermission(code).forEach((permissionCode) => {
      if (!deniedCodes.has(permissionCode)) next.add(permissionCode)
    })
  })
  if (!selected) {
    if (codes.includes(clientFilesViewPermission)) {
      next.delete(clientCommunicationsViewPermission)
      next.delete(clientCommunicationsManagePermission)
    }
    if (codes.includes(clientFilesManagePermission) || codes.includes(clientCommunicationsViewPermission)) {
      next.delete(clientCommunicationsManagePermission)
    }
  }
  return next
}

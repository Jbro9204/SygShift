export function applyPermissionCategorySelection(
  current: ReadonlySet<string>,
  permissionCodes: readonly string[],
  selected: boolean,
): Set<string> {
  const next = new Set(current)

  permissionCodes.forEach((code) => {
    if (selected) next.add(code)
    else next.delete(code)
  })

  return next
}

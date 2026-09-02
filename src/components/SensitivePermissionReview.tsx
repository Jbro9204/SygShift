import { ChevronDown, ShieldAlert } from 'lucide-react'
import type { PermissionDefinition } from '../data/accessControl'

interface SensitivePermissionReviewProps {
  permissionCodes: string[]
  permissions: PermissionDefinition[]
}

export function SensitivePermissionReview({
  permissionCodes,
  permissions,
}: SensitivePermissionReviewProps) {
  const permissionByCode = new Map(permissions.map((permission) => [permission.code, permission]))
  const grouped = permissionCodes.reduce<Map<string, PermissionDefinition[]>>((groups, code) => {
    const permission = permissionByCode.get(code)
    if (!permission) return groups
    const categoryPermissions = groups.get(permission.category) ?? []
    categoryPermissions.push(permission)
    groups.set(permission.category, categoryPermissions)
    return groups
  }, new Map())
  const categories = [...grouped.entries()]

  return (
    <div className="access-confirmation-review">
      <div className="access-confirmation-summary">
        <ShieldAlert aria-hidden="true" size={20} />
        <span>
          <strong>{permissionCodes.length} sensitive permission{permissionCodes.length === 1 ? '' : 's'} will be added</strong>
          <small>
            Grouped into {categories.length} section{categories.length === 1 ? '' : 's'}. Open a section only when you need to review its details.
          </small>
        </span>
      </div>

      <div aria-label="Sensitive permission groups" className="access-confirmation-groups">
        {categories.map(([category, categoryPermissions]) => (
          <details className="access-confirmation-group" key={category}>
            <summary>
              <span>
                <strong>{category}</strong>
                <small>{categoryPermissions.length} permission{categoryPermissions.length === 1 ? '' : 's'}</small>
              </span>
              <ChevronDown aria-hidden="true" size={18} />
            </summary>
            <div className="access-confirmation-items">
              {categoryPermissions.map((permission) => (
                <div className="access-confirmation-item" key={permission.code}>
                  <ShieldAlert aria-hidden="true" size={16} />
                  <span>
                    <strong>{permission.name}</strong>
                    {permission.description ? <small>{permission.description}</small> : null}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

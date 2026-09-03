export interface ShiftDisplayTitleInput {
  eventName?: string | null
  locationName?: string | null
  postName?: string | null
  requiresArmed: boolean
}

const genericRequirementPrefix = /^(?:unarmed|armed)(?=$|\s+(?:coverage|guard|position|post|security|shift)\b)/i
const requirementSuffix = /(\s(?:-|\u2013|\u2014|\/)\s*)(?:unarmed|armed)$/i

export function shiftRequirementLabel(requiresArmed: boolean): 'Armed' | 'Unarmed' {
  return requiresArmed ? 'Armed' : 'Unarmed'
}

export function alignPostNameWithShiftRequirement(postName: string, requiresArmed: boolean): string {
  const requirement = shiftRequirementLabel(requiresArmed)

  if (genericRequirementPrefix.test(postName)) {
    return postName.replace(genericRequirementPrefix, requirement)
  }

  if (requirementSuffix.test(postName)) {
    return postName.replace(requirementSuffix, (_, separator: string) => `${separator}${requirement}`)
  }

  return postName
}

export function shiftDisplayTitle(
  shift: ShiftDisplayTitleInput,
  fallback = 'Assigned shift',
): string {
  if (shift.postName) {
    return alignPostNameWithShiftRequirement(shift.postName, shift.requiresArmed)
  }

  return shift.eventName ?? shift.locationName ?? fallback
}

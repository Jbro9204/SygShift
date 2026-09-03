export interface ScheduledOvertimePreviewState {
  isPending: boolean
  isError: boolean
}

/**
 * Overtime validation applies only when a draft shift is being assigned to an
 * employee. TanStack Query reports a disabled query with no cached data as
 * pending, so an intentionally open shift must not be blocked by that state.
 */
export function scheduledOvertimePreviewBlocksSave(
  employeeId: string | null | undefined,
  previewState: ScheduledOvertimePreviewState,
): boolean {
  return Boolean(employeeId) && (previewState.isPending || previewState.isError)
}

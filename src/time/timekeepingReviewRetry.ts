type DatabaseErrorLike = {
  code?: unknown
  message?: unknown
}

export function isStatementTimeoutError(error: unknown): boolean {
  const candidate = error as DatabaseErrorLike | null | undefined
  return candidate?.code === '57014'
    || (typeof candidate?.message === 'string'
      && /canceling statement due to statement timeout/i.test(candidate.message))
}

export function shouldRetryTimekeepingReview(failureCount: number, error: unknown): boolean {
  if (isStatementTimeoutError(error)) return false
  return failureCount < 1
}

export function timekeepingReviewErrorMessage(error: unknown): string {
  if (isStatementTimeoutError(error)) {
    return 'The exception review took too long to load and was safely canceled. No payroll exception was approved or changed. Try again after other database work has finished.'
  }
  return error instanceof Error ? error.message : 'Exception review could not be loaded.'
}

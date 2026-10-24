export type QueryVerificationState = {
  isError: boolean
  isRefetchError?: boolean
}

export function queryVerificationFailed(state: QueryVerificationState): boolean {
  return state.isError || state.isRefetchError === true
}

export function verifiedQueryData<T>(data: T | undefined, state: QueryVerificationState): T | undefined {
  return queryVerificationFailed(state) ? undefined : data
}

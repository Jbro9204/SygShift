# SygShift Change Log — Compact Operational Exception Queue

**Date:** 08/28/2026  
**Status:** Released to production  
**Production URL:** https://app.sygilant.us  
**Cloudflare version:** `a29553a8-3ebd-4ce6-9891-8110499eb265`  
**Implementation commit:** `18b71cc`

## Outcome

The Operational Time Exceptions queue no longer renders every open record into one extremely long page. It now starts with a compact, readable set of 10 records and reveals additional records only when an authorized user asks for them.

## User experience changes

- The queue displays the first 10 unresolved exceptions by default.
- **Show next 10** adds one controlled batch at a time.
- **Show first 10** immediately collapses an expanded queue.
- **Showing X of Y** makes the current position and total queue size clear.
- Employee name, exception type, Site/Post, scheduled start/end, and Review action remain visible.
- Rows are slightly denser while preserving the existing readable font sizes and action-button dimensions.
- Changing the From or Through dates returns the queue to its compact first-10 state.
- On narrow screens, the queue controls stack cleanly and use the full available width.

## Data and security impact

- No time records, punches, exceptions, schedules, payroll calculations, permissions, or audit records were changed.
- The full exception collection remains available to authorized users; only the number rendered at one time changed.
- Existing server-side access and exception-resolution rules remain authoritative.

## Quality controls

- Added `src/timeOperationsQueueCompactionGuard.test.ts` to prevent an unbounded `unresolved.map(...)` list from returning.
- Full validation passed:
  - TypeScript type checking
  - Linting with warnings denied
  - 96 test files / 487 tests
  - Production build
- Post-deployment checks passed:
  - `/api/v1/health`: `ok`
  - `/api/v1/ready`: `ready`

## Rollback

The implementation can be reverted from Git commit `18b71cc`. No database rollback is required because this release contains no schema or data changes.

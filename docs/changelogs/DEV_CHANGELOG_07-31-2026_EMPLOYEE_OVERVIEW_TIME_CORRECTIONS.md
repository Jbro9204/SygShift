# SygShift Change Log — 07/31/2026

## Employee Overview, Break Controls, and Time-Card Correction Requests

### What changed

- Reworked the employee Overview landing page so guards and hourly employees no longer see unnecessary company-wide operations metrics.
- Kept operations metrics available for Admins, Supervisors, Schedulers, Dispatchers, and anyone with team time visibility.
- Added a cleaner employee dashboard with:
  - Next shift
  - My time card
  - Time-card help
- Added break controls directly beside the clock action:
  - `Clock out` + `Start break` while working
  - `End break` while on break
- Added employee time-card correction requests from My Time:
  - Employees can request a correction from a recent punch.
  - Employees can request correction review from a time-card row when a related punch exists.
  - Original punch data remains unchanged until the request is reviewed.
  - Correction requests feed into the existing protected time-correction workflow.

### Why it matters

- Employees now land on information that applies to them instead of seeing operational numbers they do not need.
- Breaks are easier to find and use from the main page.
- Time-card issues now have an employee-facing request path instead of relying only on verbal or text-message follow-up.

### Quality checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` — 32 files / 142 tests passing
- `pnpm build`

### Production notes

- This update is frontend and workflow focused.
- No database schema changes were required.
- Time-card correction requests use the existing time correction review infrastructure.
- Production deployment completed to `https://app.sygilant.us`.
- Cloudflare Worker version: `928240b6-4279-42f7-aa62-e84d7074ca2e`.

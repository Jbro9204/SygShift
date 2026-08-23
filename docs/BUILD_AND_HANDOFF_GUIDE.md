# SygShift Build and Handoff Guide

Last reviewed: 08/03/2026

This is the operational source of truth for maintaining SygShift. It is written so a qualified maintainer can open the repository on a different workstation, recover the current state, make a production-safe change, and hand the system back without relying on prior conversation history.

## 1. Mission and quality standard

SygShift is the active workforce-operations system for Guardianship Security. It covers employee access, scheduling, qualifications and licensing, availability, open coverage, events, time off, timekeeping, announcements, and payroll preparation.

The original dispatch workbook was migration source material. It is not the ongoing source of truth and product language must not call it “the Bible.” The live SygShift database and versioned application workflows are now authoritative.

The operating standard is:

- Correctness before speed.
- Complete workflow fixes instead of surface patches.
- Clear, readable, professional interfaces on desktop and mobile.
- Database-enforced security and auditability.
- No unexplained data loss, silent overwrites, or invented operational data.
- No claim of completion until the affected workflow has been verified.

## 2. Canonical systems

| Concern | Canonical location |
| --- | --- |
| Git repository | `https://github.com/Jbro9204/SygShift.git` |
| Primary workstation checkout | `C:\Users\Jordan\Projects\SygShift` |
| Production application | `https://app.sygilant.us` |
| Production API health | `https://app.sygilant.us/api/v1/health` |
| Production readiness | `https://app.sygilant.us/api/v1/ready` |
| Cloudflare Worker | `sygshift` |
| Supabase project reference | `eqkdfrbwtioiqtjsyglg` |
| Git changelog archive | `docs/changelogs/` |
| Active future plan | `docs/future-items/FUTURE_ITEMS.md` |
| Desktop changelog backup | `C:\Users\Jordan\Desktop\Changelog` or the documented current Desktop changelog folder |

Never assume the shell's starting directory is the application repository. The old `DayZ Shirt` workspace is unrelated. Confirm the repository before every work session.

## 3. Authority and source order

When sources disagree, use this order:

1. The current explicit request from the product owner.
2. `AGENTS.md` and this guide.
3. Current production data and the newest applied migration behavior.
4. `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.
5. The newest relevant changelog.
6. `DEVLOG.md` and older historical documentation.

Historical changelogs explain why a change happened; they do not override newer code, migrations, or requirements.

## 4. Mandatory session preflight

Run this before changing anything:

```powershell
Set-Location C:\Users\Jordan\Projects\SygShift
git remote -v
git status --short --branch
git fetch origin
git log -8 --oneline --decorate
```

Verify:

- `origin` points to `https://github.com/Jbro9204/SygShift.git`.
- The intended branch is `main` unless a different branch was explicitly requested.
- Local `main` is not behind `origin/main`.
- Every dirty or untracked file is understood before editing.
- No other workstation or maintainer is actively changing the same files or database functions.

If local work exists, do not reset, overwrite, or discard it. Determine whether it is valid unfinished SygShift work, unrelated clutter, or a completed change that was never committed.

Then read, in order:

```text
AGENTS.md
docs/BUILD_AND_HANDOFF_GUIDE.md
docs/ARCHITECTURE.md
docs/SECURITY.md
docs/future-items/FUTURE_ITEMS.md
DEVLOG.md
the newest relevant files in docs/changelogs/
```

For production or rollout work, also read:

```text
docs/PRODUCTION_CUTOVER.md
docs/PILOT_TEST_PLAN.md
docs/PAYROLL_EXPORT_VALIDATION.md
```

## 5. New-workstation setup

Requirements:

- Git
- Node.js 22 or later
- pnpm 10 or later
- Access to the correct GitHub repository
- Authorized Supabase and Cloudflare access when the task requires production operations

Setup:

```powershell
git clone https://github.com/Jbro9204/SygShift.git
Set-Location SygShift
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm check
```

Populate `.env.local` only from an approved secret source. Never copy secrets into chat, documentation, source files, screenshots, or Git. Browser variables may contain only browser-safe publishable values. Service-role keys and provider credentials are server-only.

If database or deployment access is unavailable, application code and local tests may still be reviewed, but production migration or deployment status must be reported as unverified.

## 6. Repository map

| Path | Purpose |
| --- | --- |
| `src/app/` | Router, navigation, route loading, application-level wiring |
| `src/components/` | Shared interface and shell components |
| `src/pages/` | Product pages and workflow modals |
| `src/data/` | Validated browser data-access functions and schemas |
| `src/lib/` | Supabase client, shared utilities, authorization helpers |
| `src/time/` | Time and attendance domain modules |
| `src/App.css` | Established application design system and responsive layouts |
| `worker/` | Cloudflare Worker and protected `/api/v1` endpoints |
| `supabase/migrations/` | Ordered, forward-only production database changes |
| `supabase/tests/` | SQL regression and database behavior tests |
| `tests/` and `src/*.test.*` | Browser, behavior, layout, security, and regression tests |
| `docs/changelogs/` | Canonical dated record of completed updates |
| `docs/future-items/` | Approved future work not yet complete |
| `tools/` | Controlled bootstrap and data tooling |
| `public/` | Production static assets |
| `tmp/`, `outputs/`, `.wrangler/` | Local/generated artifacts; never treat as product source |

Do not place unrelated projects, source spreadsheets, private exports, screenshots, or local package stores inside the repository.

## 7. Runtime and trust boundaries

SygShift uses:

- React 19 and TypeScript for the browser application.
- React Router for routes.
- TanStack Query for server state, mutation lifecycle, invalidation, and refetching.
- Zod to validate external data at the browser and Worker boundaries.
- Cloudflare Workers for same-origin APIs, protected integrations, email, and server-only secrets.
- Supabase PostgreSQL, Auth, Storage, row-level security, and database functions.

Trust model:

1. The browser is untrusted. Hiding a button is not authorization.
2. The Worker validates protected API requests and owns server-only credentials.
3. PostgreSQL is the final authorization boundary for operational data.
4. Sensitive mutations require an active employee account, effective permission, and MFA where specified.
5. Material changes must be auditable.

## 8. Core product rules

### People and access

- The employee directory is the source of truth for names, employee numbers, roles, employment type, status, titles, usernames, and contact records.
- Active, separated, and terminated employees must remain distinguishable.
- Separated employees do not appear in active operational pickers or the Licensing Center.
- Deletion is controlled. Preserve payroll, schedule, incident, and audit history unless an explicitly authorized cleanup workflow safely removes a test-only record.
- Permanent usernames are unique and are not silently reused.
- Privileged access must use effective permissions and MFA, not cosmetic role labels alone.

### Scheduling

- Operations run seven days per week. Every weekly view must include Sunday through Saturday.
- Payroll and employee schedule weeks begin Sunday.
- Published schedules are versioned history and are not overwritten.
- Draft edits, removals, assignments, and copy-week operations must persist to the active working revision.
- Historical weeks remain visible but do not count as current open coverage.
- Guards see their own schedules; authorized operations roles see the broader schedule according to effective permissions.
- Assignment conflict checks must evaluate actual overlapping active assignments and return the conflicting employee, site/post, date, time, and revision. They must ignore the same block being edited and superseded revisions.
- Armed-post qualification is enforced, with the approved audited override workflow available to authorized staff.
- A coverage request does not remove the original employee until a qualified replacement is approved.

### Time and payroll

- Authoritative punch time comes from the server and is stored in UTC.
- Colorado display and payroll interpretation use `America/Denver`.
- Pay weeks run Sunday 12:00 AM through Saturday 11:59 PM.
- Payroll is biweekly on Friday; the configured pay-period rules and current HR direction govern exact export windows.
- The payroll-week boundary is Sunday at 12:00 AM in `America/Denver`. Do not introduce an operational-day cutoff such as 6:00 AM into payroll batching.
- Keep every linked overnight shift in the payroll week containing the scheduled shift start. Replacement assignments and linked manual entries inherit the parent shift; standalone manual entries use manual clock-in; unscheduled work uses actual clock-in.
- Treat payroll-batch grouping and overtime allocation as separate policies. Changes to one require separate review and version metadata for the other.
- `src/time/payrollBoundary.ts` is the browser-side reference implementation and `private.get_payroll_batch_week(...)` is the database authority. Both must remain covered by boundary and daylight-saving tests.
- Open assignment recalculation must be idempotent and must skip locked payroll. Any authorized correction requires `time.override_payroll_assignment`, MFA, a Sunday date, a reason, and append-only audit history.
- Hourly payroll uses worked time recorded through punches and approved corrections, not scheduled hours.
- Scheduled hours may appear for comparison and discrepancy reporting but are not silently converted into worked hours.
- Breaks are unpaid; the usual expected break is 30 minutes.
- Overtime rules include more than 12 hours in one day or more than 40 hours in one week.
- An active clock-in is not a missing punch merely because the scheduled end passed. The current long-session guardrail is designed around 12-hour shifts and flags at 14 hours.
- Original punch evidence is not silently rewritten. Corrections record original value, replacement value, reason, actor, and time.
- Payroll exports must open without repair in supported Excel and Google Sheets workflows, contain readable summaries, and reconcile to source time records.

### Dates and times

- Production dates display as two-digit month, two-digit day, and four-digit year: `MM/DD/YYYY`.
- Where operationally useful, time displays civilian and military formats together, such as `2:00 PM (14:00)`.
- Never derive authoritative state from the viewer's local clock when server time or the operating time zone is required.

### Notifications and announcements

- Queued, attempted, delivered, and failed are different states. Never label a queued email as sent.
- Prefer a valid personal employee email for every delivery. Until the company-domain block is formally removed, do not send to `@guardianshipsecurity.net`; enforce this in recipient selection and again at the Worker provider boundary.
- Login-instruction delivery eligibility must be checked before creating an account or resetting a temporary password.
- Onboarding uses two separate messages: one Welcome email and exactly one Login Instructions email. The login message is either standard or MFA setup—not both.
- MFA onboarding language must use the same effective-access calculation as the authenticated session: base system role, assigned access roles, and person-specific MFA-sensitive permission grants.
- Employees whose effective access does not require MFA must not receive authenticator setup language. Employees whose access does require MFA must be told to install Microsoft Authenticator or Google Authenticator and that codes are generated in the app, not sent by email or text.
- Employee announcements appear through the approved front-page/banner lane and honor audience and expiration.
- Publication notifications are deliberate; schedule editing must not automatically create repeated employee email blasts.
- Sensitive site instructions do not belong in announcement or email bodies.

## 9. Implementation discipline

### Before coding

1. Reproduce the issue or inspect the full current workflow.
2. Trace it through the page, data layer, Worker if present, database function, policies, and resulting data.
3. Identify the real invariant that is broken.
4. Search for equivalent workflows so the fix is consistent across the product.
5. Define the test that would fail before the fix and pass after it.

Do not add a client-side wrapper around a database error and call the workflow fixed. Resolve the layer that violates the business rule.

### TypeScript and React

- Keep strict TypeScript behavior; do not introduce `any` to bypass a contract.
- Validate external payloads with Zod.
- Use the established `src/data/` boundary for database and API calls.
- Use TanStack Query for server state. Do not create a second unsynchronized copy of server data in component state.
- Every mutation must provide:
  - a visible pending/loading state;
  - disabled duplicate submission;
  - a clear success or error result;
  - precise invalidation/refetch of every affected view;
  - immediate refreshed content;
  - modal close or reset behavior that matches the workflow.
- Clear stale mutation errors when a modal closes, changes record, or starts a new action.
- Preserve keyboard navigation, focus management, semantic labels, and adequate touch targets.

### Database

- Never edit an applied migration. Create a new timestamped migration.
- Prefer transactional database functions for multi-record operational changes.
- Make retries safe with idempotency or deterministic conflict handling.
- Fully qualify ambiguous columns and table aliases.
- `SECURITY DEFINER` functions require a controlled `search_path`, explicit authorization, minimal grants, and regression tests.
- Public Data API tables require reviewed row-level security.
- Private schema access must remain restricted.
- Do not delete audit, payroll, punch, notification, or schedule history to make a screen look clean.
- For production data repair, first run a read-only diagnostic and record expected row counts. Use a transaction or reversible function, verify after-state, and document the result.

### Worker

- Version APIs under `/api/v1`.
- Keep secrets in Worker secrets/bindings, never `vars` if the value is confidential.
- Validate method, authentication, MFA, authorization, and request payload.
- Return useful, non-sensitive error messages and preserve the request ID.
- Do not log passwords, tokens, full private payloads, employee private data, or site secrets.

## 10. Interface and design standard

SygShift should feel like one designed product, not a collection of forms.

Required standards:

- Reuse established typography, spacing, colors, borders, radii, shadows, inputs, status chips, modals, and button classes.
- Use page-specific layout wrappers when local width or alignment is needed. Do not globally force all buttons to full width.
- Buttons in one action group must share height, baseline, padding, icon treatment, and visual hierarchy.
- Long labels wrap intentionally; controls never overlap, clip, or create a box-inside-a-box appearance.
- Forms use readable labels above controls and logical grouping. Optional fields are identified consistently.
- Modals are purpose-sized, centered, scroll safely, preserve access to their actions, and fit both desktop and mobile.
- Tables need reasonable side padding, readable columns, and responsive alternatives when a table cannot fit.
- Weekly schedules must show all seven days. On narrow screens, use a deliberate responsive view or a persistent, reachable scrolling mechanism.
- Employee pages show employee-relevant information; company-wide staffing totals stay in authorized operations views.
- Empty states explain what the user can do next.
- Error messages use plain operational language instead of raw SQL, Zod, or provider errors.
- Minimum normal body text should remain comfortably readable; do not solve density by shrinking fonts.

Before accepting a UI change, inspect at minimum:

- wide desktop;
- common laptop width;
- narrow phone width;
- modal open and closed states;
- empty, loading, success, validation-error, permission-denied, and long-content states.

Existing layout guard tests in `src/buttonLayoutGuard.test.ts` and permission guard tests in `src/permissionSurfaceGuard.test.ts` are intentional regression protection. Extend them when a newly fixed class of issue could recur.

## 11. Permissions and MFA

The long-term model is Active Directory-style effective permissions:

- Roles provide default permission bundles.
- Person-specific grants and denials may adjust those defaults.
- Navigation, direct routes, reads, writes, Worker endpoints, RPCs, and database functions must reach the same authorization answer.
- A removed permission must not remain available through a hard-coded role fallback.
- An added permission must enable the full intended workflow without a code change.
- MFA-sensitive permissions require verified MFA at the protected boundary.

The full permission enforcement audit remains a critical future initiative in `docs/future-items/FUTURE_ITEMS.md`. Until it is complete, inspect both permission checks and any legacy role fallback before changing access. Never remove a fallback without first preserving intended production access and testing an Admin recovery path.

## 12. Test strategy

Minimum automated release gate:

```powershell
pnpm check
```

This runs type checking, linting, unit/regression tests, and the production build.

Use additional checks according to risk:

| Change | Required additional verification |
| --- | --- |
| Visual/layout | Targeted component test plus rendered desktop and mobile inspection |
| Modal/mutation | Pending, success, error, close, reopen, and immediate-refresh checks |
| Permission | Allowed and denied roles, direct URL, API/RPC call, MFA, disabled/separated account |
| Schedule | Draft, publish, edit, removal, copy, overlap, historical week, employee view, all seven days |
| Timekeeping | Clock in, break, clock out, duplicate punch prevention, active session, 14-hour guardrail, correction audit |
| Payroll | Exact date range, worked-time reconciliation, overtime, breaks, sick hours, exceptions, workbook open/repair check |
| Migration | Local/branch database test, production-safe diagnostic, grants/RLS review, post-apply verification |
| Worker/API | Unit test, authorization failure, validation failure, health/readiness, live response after deploy |

Run Playwright when the affected flow is represented or when a full browser interaction is materially important:

```powershell
pnpm test:e2e
```

A passing build alone does not prove a database-backed workflow works.

## 13. Production database procedure

For any database change:

1. Inspect current migrations and live function signatures.
2. Write a new forward-only migration.
3. Include authorization, grants, RLS implications, audit behavior, and idempotency.
4. Add or update SQL and application regression tests.
5. Test against a local or isolated branch database where practical.
6. Capture a read-only before-state for affected production records.
7. Apply the migration using the approved Supabase access path.
8. Verify the migration appears in applied history.
9. Run post-migration queries and the exact user workflow.
10. Record the migration and verification in the changelog.

Never use a production write to “see what happens.” Never invent missing employee, license, schedule, or payroll facts.

## 14. Git and cross-computer workflow

One source of truth prevents quality drift between computers.

### Starting work

```powershell
git fetch origin
git status --short --branch
git pull --ff-only origin main
```

Do not begin if the other workstation has unpushed work in the same area. Push the first workstation's completed unit or intentionally hand off the dirty diff before continuing elsewhere.

### Completing work

```powershell
git diff --check
git status --short
pnpm check
git diff --stat
git diff
git add <intentional-files-only>
git commit -m "<clear production-oriented summary>"
git push origin main
```

Review the staged diff before committing. Do not commit `.env*`, workbooks, exports, screenshots, test videos, caches, database dumps, or unrelated project material.

Commit messages should state the product outcome, for example:

```text
fix: preserve historical schedule visibility
fix: make week copy atomic and complete
feat: add employee-scoped schedule publication
docs: add production build and handoff guide
```

## 15. Cloudflare deployment

Use the repository configuration in `wrangler.jsonc`.

Production deployment:

```powershell
pnpm check
pnpm deploy
```

After deployment, verify:

```powershell
Invoke-RestMethod https://app.sygilant.us/api/v1/health
Invoke-RestMethod https://app.sygilant.us/api/v1/ready
```

Then verify the changed live workflow with the appropriate role. A successful Wrangler upload is not the same as a verified release.

Do not deploy unrelated dirty files. Do not claim that a migration is live merely because the frontend deployed.

## 16. Changelog and handoff record

Every meaningful completed update gets one Markdown file in `docs/changelogs/`. Use a clear date-first filename such as:

```text
CHANGELOG_08-03-2026_SCHEDULER_HISTORICAL_WEEK_VISIBILITY.md
```

The changelog must include:

- Date in `MM/DD/YYYY`.
- Problem and user impact.
- Root cause.
- Files and migrations changed.
- Functional behavior after the change.
- Tests and exact results.
- Database migration status.
- Git commit and push status.
- Cloudflare deployment and live health/readiness status.
- Any remaining limitation or follow-up.

Copy the same file to the configured Desktop changelog backup when available. Do not mark a future item complete until it is actually implemented, verified, logged, and removed from the active future list.

## 17. Incident and regression workflow

For a reported production bug:

1. Preserve the user's exact steps, role, employee, site/post, date, time, and screenshot/video evidence.
2. Inspect current production state before changing it.
3. Reproduce the failure as closely as possible.
4. Trace the full call path and identify the root cause.
5. Check whether the same pattern affects other pages, roles, records, or functions.
6. Add a regression test that represents the real failure.
7. Fix the authoritative layer and any stale interface state.
8. Run the full relevant matrix, not only the original happy path.
9. Deploy, verify live, and document the result.

Raw database/provider errors must be converted to clear user-facing messages, but the underlying bug must still be fixed.

## 18. Definition of done

A change is done only when all applicable statements are true:

- The requested behavior works end to end.
- Existing production data and history are preserved.
- Authorization is correct at both interface and protected boundaries.
- Loading, success, error, refresh, and modal states are correct.
- Desktop and mobile layouts are readable and uniform.
- Targeted regression tests exist and pass.
- `pnpm check` passes.
- Database migrations are applied and verified when required.
- The intended commit is pushed to `origin/main`.
- Cloudflare is deployed and live endpoints/workflow are verified when deployment is in scope.
- The Git and Desktop changelogs are updated.
- Remaining limitations are stated plainly instead of hidden.

## 19. Required end-of-session handoff

Before leaving work for another workstation or maintainer, record:

```text
Objective:
Completed:
Files changed:
Migrations added/applied:
Tests run and results:
Commit:
Pushed:
Deployed version:
Live verification:
Current Git status:
Remaining work:
Known risks or decisions needed:
```

If work is incomplete, do not describe it as complete. Either commit a coherent safe unit or provide the exact dirty-file state and next command. Never leave the next maintainer to infer whether production, Git, and the local workstation match.

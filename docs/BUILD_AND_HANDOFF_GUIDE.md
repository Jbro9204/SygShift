# SygShift Build and Handoff Guide

Last reviewed: 10/20/2026

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
| Desktop changelog copy | `C:\Users\Jordan\Desktop\SygShift Changelogs` (owner-confirmed 09/06/2026) |

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
- Node.js 24.19.0 exactly (pinned in `.node-version`)
- pnpm 11.25.0 exactly (pinned in `packageManager`)
- Access to the correct GitHub repository
- Authorized Supabase and Cloudflare access when the task requires production operations

Setup:

```powershell
git clone https://github.com/Jbro9204/SygShift.git
Set-Location SygShift
node --version # must be v24.19.0
pnpm --version # must be 11.25.0
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm setup:git-hooks
git config --get core.hooksPath # must print .githooks
git ls-files --stage .githooks/pre-push # must show mode 100755
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
- Keep every linked overnight shift, punch chain, correction, and timecard as one canonical operational occurrence on the day it starts. Do not split or rewrite the source occurrence.
- Build payroll as a derived allocation view. Divide exact paid intervals at Sunday 12:00 AM in `America/Denver`; breaks belong to the interval in which they occurred. Employee payroll totals, weekly overtime, preview and locked exports, and downstream payroll integrations use only the resulting allocation slices that overlap the selected range.
- Treat operational occurrence ownership, payroll-week allocation, and overtime allocation as separately versioned policies. Changes require reconciliation tests showing that whole-occurrence paid time equals the sum of all payroll allocations and that category and overtime totals do not double count.
- `src/time/payrollBoundary.ts` is the browser-side reference implementation and the database payroll-review functions are authoritative. Both must remain covered by cross-week, cross-pay-period, break, category, overtime, and daylight-saving tests.
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
- Use the employee profile time zone for employee-facing Schedule, Home, Time & Attendance, and early-clock warnings. Use the browser/device system time zone only for the informational global header clock, SygSphere message/read-receipt/search timestamps, and SygSphere-linked Client Communications timestamps.
- Interpret one-person employee-specific schedule entry in the employee profile zone. Interpret open, multi-person, and physical Site/Post coverage in the Site/Post zone. Label the basis and show both conversions when employee and site zones differ.
- Require an explicit supported employee time zone in interactive onboarding and User Accounts creation. Do not silently substitute `America/Denver` for an omitted user choice.
- When correcting a profile or shift-zone label, preserve the authoritative UTC `starts_at`/`ends_at` values unless an authorized scheduler explicitly chooses and confirms a wall-clock reinterpretation.
- Calendar files retain UTC `DTSTART`/`DTEND` values so the receiving calendar can localize the same instant; include the recorded Employee/Site time-basis label rather than silently rebasing the event.

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

The full permission enforcement audit and Guard access hardening were completed in August 2026. Permission changes must preserve the effective-access model across navigation, direct routes, reads, writes, Worker endpoints, RPCs, and database functions. The remaining access item in `docs/future-items/FUTURE_ITEMS.md` is a usability redesign of the employee-access workspace; it does not authorize weakening the enforced permission model. Always preserve intended production access and test an Admin recovery path.

## 12. Test strategy

Minimum development-quality gate:

```powershell
pnpm check
```

This runs exact-toolchain validation, type checking, linting, unit/regression tests, release-control tests, and the production build.

Vitest runs through a repository-controlled per-run runtime wrapper so Windows temporary-directory behavior cannot make every suite fail before tests execute. The wrapper uses only `.work/test-runtime/<unique-run>` and refuses to remove anything outside that controlled per-run path.

The mandatory `main` release-candidate gate adds the Time Clock browser workflow and a final fresh production build. The focused workflow owns one temporary loopback fixture, verifies its known fixture marker, and always runs the desktop and mobile Chromium projects; it does not inherit the broad Playwright `webServer` matrix:

```powershell
pnpm release:verify
```

Do not substitute a passing build, a partial browser run, or a rerun of an older commit for this gate.

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
git diff --stat
git diff
git add <intentional-files-only>
git commit -m "<clear production-oriented summary>"
pnpm setup:git-hooks
git push origin main
```

Review the staged diff before committing. Do not commit `.env*`, workbooks, exports, screenshots, test videos, caches, database dumps, or unrelated project material.

The versioned pre-push gate builds a clean detached worktree at the exact candidate SHA, installs locked dependencies, audits production dependencies, runs `pnpm release:verify`, then rechecks the local SHA, remote tip, cleanliness, and fast-forward relationship before it allows a `main` update. The focused browser step creates and tears down only its one loopback fixture; it fails closed if that process or its cleanup cannot be confirmed. The hook blocks while an earlier `main` **push** quality run for `security.yml` is active. Workflow concurrency separately serializes push, scheduled, and manual runs for the same ref. Do not use `--no-verify`. If it reports a retained candidate or lock after an interrupted verification, inspect the recorded path and confirm the process stopped before manual recovery; do not blindly delete it.

### Interrupted release-gate recovery

The release gate fails closed when it cannot confirm process termination or cleanup. Keep the complete terminal error: it identifies the retained lock, candidate worktree, and/or controlled temporary root. Do not retry the push or bypass the hook.

1. Inspect the recorded lock metadata and its PID/token; confirm that no matching gate, package-manager, test, or browser process remains.
2. Run `git worktree list` and confirm whether the recorded candidate worktree is still attached.
3. Only after confirming the process is gone, manually remove the specific token-owned lock(s) and the exact recorded `sygshift-main-release-*` temporary root. Never delete a broad temp directory, `.git`, a shared lock directory, or an unlisted worktree.
4. Run `pnpm setup:git-hooks`, verify the hook path and `100755` mode again, then rerun the candidate gate normally.

Candidate command environment isolation reduces accidental credential exposure: the gate passes an explicit toolchain/OS allowlist and an isolated temporary home to candidate commands. It is not a security sandbox—candidate code can still read files that the invoking user can read, including shared Git metadata. Use server-enforced checks and isolated CI runners as the adversarial boundary.

After the push, open the GitHub Actions run for the exact pushed SHA and wait for both required jobs—**Exact candidate quality gate** and **CodeQL JavaScript and TypeScript**—to finish green before any production deployment or completion report. Do not push another main update while that run is queued or running. If it fails, diagnose the failure from that SHA's logs and make one correction candidate; do not blindly rerun or treat a scheduled/manual/older run as proof.

GitHub branch protection remains required for server-side enforcement: block force-push and deletion, prevent bypass/direct main updates, require the current quality checks, and require the branch to be current before merge. The local gate is intentional defense in depth, not a replacement for branch protection.

Commit messages should state the product outcome, for example:

```text
fix: preserve historical schedule visibility
fix: make week copy atomic and complete
feat: add employee-scoped schedule publication
docs: add production build and handoff guide
```

## 15. Cloudflare deployment

Use the repository configuration in `wrangler.jsonc`.

For a release that requires employee communication or protected access, follow `docs/operations/MAINTENANCE_RELEASE_RUNBOOK.md`. Maintenance is controlled from **Administration → System Operations** and remains inactive unless an authorized System Admin explicitly schedules a window. Use notice-only mode when writes do not need to pause. When protection is necessary, select only the affected features and keep the employee Time Clock available whenever safely possible.

Before a normal production release:

- confirm the release does not add or change a Durable Object class, binding, migration, cron trigger, or other `wrangler.jsonc` lifecycle configuration;
- configure the dedicated read-only release canary when available; and
- choose a safe release tag containing only letters, numbers, periods, underscores, or hyphens.

Normal production deployment with the release canary configured in the operator environment:

```powershell
pnpm deploy -- --tag=<release-tag> --message="<release summary>" --rollback-safe
```

Supply `SYGSHIFT_RELEASE_CANARY_EMAIL` and `SYGSHIFT_RELEASE_CANARY_PASSWORD` from the approved operator secret source; `SYGSHIFT_RELEASE_CANARY_USERNAME` may bind verification to the expected account. Never record the values in source, documentation, screenshots, logs, or the client bundle.

Without a configured canary, the operator must explicitly accept the weaker anonymous boundary probe:

```powershell
pnpm deploy -- --tag=<release-tag> --message="<release summary>" --rollback-safe --allow-boundary-probe
```

The command verifies existing production and upstream availability, requires a clean `HEAD` that exactly matches `origin/main`, runs `pnpm check`, runs the mandatory Time Clock browser workflow, rebuilds production after Playwright, records the current Worker version, uploads one candidate, rechecks the exact source immediately before promotion, and promotes that exact candidate. It runs candidate Worker checks when Cloudflare exposes a Version URL and always performs repeated post-promotion production/upstream checks.

If the promoted Worker remains unhealthy while upstream services are repeatedly healthy, the command rolls back and verifies the exact recorded prior version. If upstream services are unhealthy, it stops and reports a provider outage instead of pretending that a Worker rollback will repair the provider. A missing candidate Version URL must be reported as unavailable, not passed.

After any release, independently verify:

```powershell
Invoke-WebRequest https://app.sygilant.us/
Invoke-WebRequest https://app.sygilant.us/login
Invoke-RestMethod https://app.sygilant.us/api/v1/health
Invoke-RestMethod https://app.sygilant.us/api/v1/ready
```

Then verify the changed live workflow with the appropriate role. A successful Wrangler upload is not the same as a verified release.

### Durable Object and configuration lifecycle releases

Do not use the normal candidate/promotion path to introduce a new Durable Object class, binding, migration, cron trigger, or another Worker lifecycle/configuration change. Cloudflare version upload does not replace the lifecycle work performed by a reviewed `wrangler deploy`, and rolling back across a newly applied Durable Object migration may be unsafe.

Use two committed releases:

1. **Infrastructure bootstrap:** add only the class export, binding/migration/configuration, generated types, isolated tests, and the reviewed lifecycle gate when it is not already present. Keep dependent runtime behavior disabled. Push the bootstrap commit, then use the lifecycle gate to run the complete quality checks and apply one atomic deployment tagged with the exact 40-character source commit:

   ```powershell
   pnpm deploy:lifecycle-bootstrap -- --confirm-lifecycle-bootstrap --message="Bootstrap scheduled runtime coordinator"
   ```

   The command fetches `origin/main`, requires a completely clean worktree and exact `HEAD == origin/main`, runs `pnpm check`, the mandatory Time Clock browser workflow, and a fresh production build, then repeats the fetch, clean-worktree check, and exact commit comparison immediately before Wrangler. Only then does one strict `wrangler deploy` apply the lifecycle configuration and matching Worker source with the mandatory `source-<40-character SHA>` tag and `SYGSHIFT_SOURCE_COMMIT` value. Use `--dry-run` with the same command to validate Wrangler without applying the deployment.

   Never deploy Step A while Step B remains as unstaged or untracked files in the same checkout. The normal release gate reads the deployed source tag and refuses to promote later code if `wrangler.jsonc` changed anywhere after that lifecycle baseline. Do not bypass this script with a hand-written Wrangler command.
2. **Operational behavior:** after the bootstrap version is healthy, commit and push the behavior that consumes it. Use the normal release gate above. The verified bootstrap version is the rollback floor for this second release.

Never use the raw lifecycle deployment path as a routine shortcut. Record its exact commit, Cloudflare version/deployment, configuration change, and live verification. The complete scheduler-specific procedure is in `docs/runbooks/SCHEDULED_RUNTIME_RECOVERY.md`.

Before and after a protected release, confirm the maintenance status endpoint reports the intended active, upcoming, and recently completed states. Every window must have an automatic end time; never rely only on a person remembering to restore access.

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

Copy the same file to `C:\Users\Jordan\Desktop\SygShift Changelogs`. This is the owner-designated Desktop destination; retain the repository copy in `docs/changelogs/` and do not substitute `Desktop\Changelog` or another folder. Do not overwrite a differing existing Desktop file without reconciling its contents. Do not mark a future item complete until it is actually implemented, verified, logged, and removed from the active future list.

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

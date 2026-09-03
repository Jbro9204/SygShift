# SygShift Primary Task Handoff

## Purpose

This document onboards a fresh Codex task into the established SygShift production project without relying on the oversized historical conversation. It is operating context, not authorization to change production. The user's current request determines whether the task should discuss, diagnose, implement, deploy, or wait.

## Canonical workspace and production services

- Canonical local repository: `C:\Users\Jordan\Projects\SygShift`
- Git remote: `https://github.com/Jbro9204/SygShift.git`
- Production application: `https://app.sygilant.us`
- Cloudflare fallback: `https://sygshift.sygilant.workers.dev`
- Production database and authentication: the Supabase project already linked from the canonical repository
- Cloudflare and Supabase credentials must remain in their existing secure local stores. Never copy, print, commit, or place secret values into a prompt, changelog, test output, or documentation.

## Required startup audit

Before changing any file, database object, or external service:

1. Work from the canonical repository above and confirm the expected Git remote, branch, status, and recent commits.
2. Read `AGENTS.md`, `DEVLOG.md`, `docs/future-items/FUTURE_ITEMS.md`, the newest relevant changelogs, and this handoff.
3. Confirm Node/pnpm and repository checks are available.
4. Confirm Cloudflare authentication and the configured Worker without exposing credentials.
5. Confirm the linked Supabase project and read-only database connectivity without exposing credentials.
6. Confirm the primary and fallback `/api/v1/health` and `/api/v1/ready` endpoints.
7. Report a concise readiness summary and the current agenda to Jordan. Do not implement a new feature during the onboarding check.

If any access check fails, stop and report the exact missing capability. Do not fabricate access, substitute a different project, or create new infrastructure.

## Jordan's working expectations

- Security is the first priority. Preserve authentication, MFA/FIDO2, permissions, RLS, audit history, and least-privilege boundaries.
- Treat SygShift as a real enterprise workforce, HR, scheduling, timekeeping, licensing, patrol, client-file, and protected-document platform—not a mockup.
- When Jordan says **discussion**, do not implement. When Jordan says **fix**, **build**, **push**, or **run it**, complete the in-scope work, verify it proportionally, and report the actual outcome.
- Communicate conversationally and concisely. Avoid enormous lists unless Jordan explicitly requests a complete specification or prompt.
- Lead with what changed or what is wrong. Be candid about incomplete work, assumptions, failures, and remaining decisions.
- Never claim production is fixed merely because code compiles. Verify the relevant user workflow, database behavior, deployed asset, and health endpoints.
- Do not leave placeholder, staged, disabled, mock, or duplicate experiences presented as complete.
- Remove completed work from the active Future Items list and record it in the changelog/DEVLOG instead.
- Preserve unrelated user changes in a dirty worktree. Never use destructive Git recovery commands without explicit authorization.

## Product and visual standards

- All screens, cards, dialogs, forms, tables, and buttons must be consistent, professional, responsive, and fully usable in light and dark modes.
- Maintain even padding (Jordan calls this “cushion”), deliberate spacing, readable type, rounded controls, clear hierarchy, and accessible contrast.
- A shared visual defect is a site-wide component-system issue until proven otherwise. Fix common tokens/components rather than patching screenshots one page at a time.
- Test desktop and narrow/mobile layouts. Do not allow modal content, buttons, tables, or long permission lists to become cramped, clipped, or needlessly difficult to operate.
- Avoid duplicated records and duplicated workflows. Employee, client, site, post, shift, patrol, licensing, and document information must link to canonical records.

## Data and security standards

- Supabase changes require migrations, preservation checks, least-privilege grants, RLS review, and allow/deny testing.
- Published schedules, employee records, punches, payroll history, audit evidence, and protected documents must not be silently rewritten or deleted.
- Client-side hiding is never a security boundary. Enforce permissions in navigation, routes, Worker endpoints, database functions/policies, and storage access.
- Do not store SSNs, payroll-vault information, or unnecessary PHI in SygShift. Salary and compensation access stays restricted to explicitly authorized roles.
- Protected documents must support secure browser preview and authorized download with audited access. Do not use browser-blocked cross-origin iframe previews.
- Time and schedule decisions must use authoritative server/UTC data while presenting employee-facing times in the correct supported US time zone.

## Implementation and release standard

1. Inspect the existing architecture and reuse established patterns.
2. Diagnose the actual root cause before editing.
3. Make the smallest complete change that solves the full workflow.
4. Add focused regression and security-boundary tests.
5. Run TypeScript, zero-warning lint, relevant tests, full tests when risk warrants it, and production builds.
6. Apply and reconcile database migrations carefully. Do not blindly repair migration history.
7. Commit and push only the intended changes.
8. Deploy only when Jordan has authorized a production push or the active request clearly requires it.
9. Verify production bundles and both primary/fallback health and readiness endpoints.
10. Update `DEVLOG.md`, add a dated changelog, update Future Items, and sync the established Desktop copies when applicable.

Avoid long-running commands with uncontrolled output. Split verification, build, migration, and deployment into bounded steps with limited output so Jordan can stop the task and the Codex interface remains responsive.

## Current release context

- The scheduler's **Leave open / unassigned** regression was repaired and released on 09/03/2026.
- Concurrent **Dispatch Phone Coverage** was released on 09/03/2026. It may overlap one normal Site/Post responsibility, remains visibly separate, and does not create duplicate punches, missing-clock alerts, scheduled hours, or overtime. Ordinary physical-shift overlaps remain blocked.
- Implementation details, commit identifiers, migration identifiers, verification results, and Worker versions are in the 09/03 DEVLOG and changelogs.
- The active agenda must be read from `docs/future-items/FUTURE_ITEMS.md`; completed items must not be reintroduced as unfinished work.

## Handoff acceptance

The new task is ready only after it confirms:

- correct repository and production endpoints;
- Cloudflare access;
- linked Supabase access;
- authoritative project documentation read;
- clean understanding of Jordan's standards;
- current agenda summarized accurately;
- no production or source mutation performed during onboarding.

Keep the prior task available until Jordan accepts this readiness report.

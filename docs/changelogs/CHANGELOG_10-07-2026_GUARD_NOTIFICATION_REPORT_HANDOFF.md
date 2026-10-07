# Guard Notification Report Handoff

Date: 10/07/2026
Status: Released to production; final Guard-device workflow acceptance remains open

## Outcome

This production release enables SygShift notifications to open the exact related Sygilant dispatch call or report
for an authorized employee. Notification read and acknowledgment states remain separate from the operational action,
so opening the related item does not falsely complete required work.

## Root cause

- Notification action paths were treated as SygShift-local navigation even when the action belonged to a Sygilant
  dispatch call or report.
- The shared Sygilant launch contract allowed only the dashboard, so it could not securely carry an exact dispatch
  or report destination through employee sign-in.
- Push-notification clicks reopened the notification inbox but did not prepare the protected handoff to the related
  Sygilant item.
- The interface did not have one reusable control that could validate notification category, matching record
  reference, destination, read-state synchronization, and clear employee recovery.

## Released repair

- Adds one notification-action resolver for SygShift-local actions and allowlisted Sygilant dispatch/report actions.
- Requires the notification category, record reference, and exact action destination to agree before a Sygilant
  handoff is offered. Invalid or mismatched actions fail closed.
- Extends the protected shared launch to accept only the dashboard, an exact dispatch call, or an exact supported
  report destination. The returned launch must match the requested destination.
- Uses the same action control in the notification inbox and live notification surface, with disabled, pending,
  error, and recovery states that do not expose protected record details.
- Routes supported push clicks through the notification workspace, marks a valid notification read independently,
  and then prepares the protected Sygilant handoff.
- Keeps acknowledgment and required-action completion independent from navigation. Opening a related item never
  substitutes for the required response.

## Security and data contract

- The handoff is available only from the official SygShift application address and an active protected employee
  session with existing Sygilant access.
- The database launch function rejects unsupported fields, invalid destinations, expired requests, invalid session
  context, missing access, and assurance levels outside the established policy.
- Dispatch and report actions are bound to supported notification categories and the same matching record reference.
  An arbitrary path or copied reference cannot become a handoff.
- Sygilant remains responsible for authorization after the handoff. SygShift does not grant report, dispatch,
  client, site, review, or publication authority.
- The release changes no employee role, permission, assignment, notification acknowledgment, dispatch record,
  report content, or report decision by itself.

## Files and database change

- Notification action resolution and controls:
  `src/data/notificationActions.ts`, `src/components/NotificationActionControl.tsx`, and
  `src/components/NotificationPushHandoff.tsx`.
- Inbox, live-notification, and push handling:
  `src/pages/NotificationsPage.tsx`, `src/components/LiveNotifications.tsx`, and
  `public/notification-sw.js`.
- Protected launch contract:
  `src/data/platformLaunch.ts`, `worker/sygilantSharedIdentity.ts`, and migration
  `20261007124840_sygilant_dispatch_deep_link_launch.sql`.
- The coordinated production ledger contains the following exact migrations and SHA-256 hashes:
  - `20261007124840` — `30afb5ed6417533a9748e012253de485e5e497242f2efe760149e080de21768e`
  - `20261007124843` — `35e45115186a430e476e30a7c3d18801765f68f1322a508ce2d883dc999f73a6`
  - `20261007153000` — `37af1412da4bdf4d1135602494172c0bc40f95eaa7d7675d5dae2fb9bc23aae5`
  - `20261007154500` — `4abe3ca7083fd284b17fe13f6d6d824471767f2c45001808fab5619494ef5fc0`
- All four migrations and their coordinated postflights passed. The ownership repair classified seven reports:
  five `untouched_dispatch_scaffold` and two `edited_attested_dispatch_draft`. All seven retain immutable
  `author_reassigned` decisions.

## Verification

- The complete SygShift gate passed **362 passing test files / 1 skipped** and
  **2,020 passing tests / 1 skipped**.
- Strict TypeScript, zero-warning lint, the production build, and the static-asset contract passed.
- Focused coverage includes local versus Sygilant action resolution, category/reference mismatch denial, exact
  destination requests and responses, official-address enforcement, notification read-state independence,
  live-notification actions, service-worker click handling, and accessible failure recovery.
- The mandatory Time Clock actual-component desktop/mobile suite was previously verified at **42/42**. That result
  remains the accepted baseline and is not represented as a new 10/07 execution.
- Source `945f7500a00624a9cde64e26498928789df40df8` was promoted to `main`. The canonical `pnpm deploy` path completed
  a fresh production build and static-asset verification, then released Worker
  `d903f14a-be46-4d4c-813c-e5a4789e2b8f` on `app.sygilant.us`.
- GitHub **Security and release checks** run `37631489278` completed successfully for the released source.
- Production `/api/v1/health` returned HTTP 200 with `ok`; `/api/v1/ready` returned HTTP 200 with `ready` and all
  nine readiness checks true. The live HTML entry-asset references exactly matched the fresh local build, and all
  six referenced entry assets returned HTTP 200 to `HEAD` requests.
- A valid-origin anonymous launch reached the protected boundary and returned HTTP 401
  `authentication_required`; an invalid-origin launch returned HTTP 403.
- The responder-ownership rollback canary completed with the exact terminal result
  `dispatch_incident_responder_ownership_rollback_canary_passed`. A separate read-only residue check returned
  `dispatch_canary_residue=0` and `report_canary_residue=0`.
- Authenticated verification with Jordan Admin completed the SygShift-to-Sygilant handoff to the dashboard, the
  Market dispatch call, and its linked incident-report draft. This was an Admin smoke test, not a Guard-device or
  report-lifecycle acceptance ceremony.
- The companion Sygilant Pages source and deployment evidence was supplied for the coordinated Sygilant release
  record.

## Release status

The coordinated source, database, SygShift Worker, production perimeter, and authenticated Admin handoff are live
and verified. Rollback tag `rollback/pre-guard-notification-report-handoff-20261007` preserves source
`dd708cb01fb9473a4f37196d3179151a82727d59`. Final operational acceptance still requires a real Guard device to
open the notification, save and submit the related report, and complete the reviewer accept-or-reject cycle.

## Known narrow limitations

- Only allowlisted dispatch and supported report destinations are eligible. Other notification actions remain local
  or unavailable.
- Final Sygilant-hosted cutover remains open and is not authorized by this release.
- Final Guard-device notification, report submission, and reviewer acceptance remain open; the Admin smoke test
  does not substitute for that ceremony.
- If protected handoff preparation fails, the employee receives recovery guidance and can reopen the related work
  from the normal authorized workspace; the notification is not falsely acknowledged or completed.

# Guard Notification Report Handoff

Date: 10/07/2026
Status: Release candidate; database migration, Worker deployment, and authenticated acceptance are pending

## Outcome

This release candidate prepares SygShift notifications to open the exact related Sygilant dispatch call or report
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

## Candidate repair

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
- The candidate changes no employee role, permission, assignment, notification acknowledgment, dispatch record,
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
- The migration is prepared but is not recorded as applied in this release-candidate entry.

## Verification

- The complete SygShift gate passed **362 passing test files / 1 skipped** and
  **2,020 passing tests / 1 skipped**.
- Strict TypeScript, zero-warning lint, the production build, and the static-asset contract passed.
- Focused coverage includes local versus Sygilant action resolution, category/reference mismatch denial, exact
  destination requests and responses, official-address enforcement, notification read-state independence,
  live-notification actions, service-worker click handling, and accessible failure recovery.
- The mandatory Time Clock actual-component desktop/mobile suite was previously verified at **42/42**. That result
  remains the accepted baseline and is not represented as a new 10/07 execution.
- Hosted migration postflight, Worker deployment checks, and authenticated notification-to-report acceptance have
  not yet been performed.

## Release status

This entry records a locally verified release candidate only. Production order remains: apply and verify the exact
database changes, deploy the compatible Sygilant consumer, then deploy the SygShift Worker and complete health,
readiness, Time Clock, and authenticated notification-handoff acceptance.

## Known narrow limitations

- Only allowlisted dispatch and supported report destinations are eligible. Other notification actions remain local
  or unavailable.
- Final Sygilant-hosted cutover remains open and is not authorized by this candidate.
- If protected handoff preparation fails, the employee receives recovery guidance and can reopen the related work
  from the normal authorized workspace; the notification is not falsely acknowledged or completed.

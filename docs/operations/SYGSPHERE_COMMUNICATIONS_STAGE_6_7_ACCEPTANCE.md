# SygSphere Communications — Stage 6/7 Shared UI and Push-to-Talk Acceptance

**Status:** Shared presentation and interaction policy prepared. No employee-facing communications runtime is enabled.

## Shared experience rule

SygShift owns the exact presentation profile at `shared/sygsphere-communications/v1/presentation-policy.ts`. Sygilant must consume the same artifact, wording, state meanings, and interaction flow. Each product may use its approved color tokens, but it may not create different controls, error language, or status meanings.

The profile is deliberately plain:

- It never shows provider names, transport details, credential values, numeric errors, or diagnostic payloads to an employee.
- It always keeps SygSphere messages and Dispatch as visible fallbacks.
- It never implies that selecting a channel, opening a dock, or viewing a notification starts a call or a transmission.
- It never lets a browser choose a tenant, employee, permission, assignment, shift, site, or Dispatch authority.

## Stage 6 — complete shared UI acceptance

Before an interactive dock is enabled, both applications must render and test each shared state below from the same presentation profile.

| State | Required employee outcome |
| --- | --- |
| Unavailable | Quiet fallback to SygSphere messages and Dispatch; no interactive control or device request. |
| Permission needed | Explain the microphone choice in plain language and request it only after an explicit action. |
| Ready | Clear next step to open an allowed conversation or channel. |
| Ringing | Clear Answer and Decline actions; the active page and unsaved work remain open. |
| Connecting | Calm progress message with cancellation and text/Dispatch fallback. |
| Active | Obvious controls without covering the page's primary task. |
| Reconnecting | One plain-language recovery state with no raw provider error. |
| Denied | Explain that the account cannot use that capability and offer the normal fallback. |
| Failed | Preserve work, explain that the attempt did not start, and offer a retry/fallback. |
| Ended | Confirm the communication ended and return the person to normal work. |

### Visual and accessibility requirements

- Use existing SygShift/Sygilant spacing, readable type, rounded controls, clear focus rings, and minimum mobile touch targets.
- The primary action is visually obvious; secondary actions are quieter but reachable.
- Screen readers receive concise state changes; visual and audible alerts honor reduced-motion and user settings.
- A dock may not obscure the submit, save, send, clock, or emergency action on a report, form, document, schedule, time correction, or message.
- Route changes, refresh recovery, account changes, and sign-out must not duplicate controls or leave stale tenant data visible.

## Stage 7 — push-to-talk acceptance

The employee vocabulary is **channel**, not internal coordination terminology. The supported display scopes are **Your assignment channel**, **Your shift channel**, **Your site channel**, and **Dispatch channel**.

1. No channel begins transmitting automatically. A person must press and hold the large, labeled **Hold to talk** control.
2. The control changes immediately to **Release to stop** while that person is speaking.
3. Releasing the pointer/key, cancellation, focus loss, sign-out, permission loss, network loss, foreground loss, or coordinator revocation must stop local transmission before recovery begins.
4. The coordinator—not the browser—derives present eligibility, scope membership, priority, and whether another transmission is already active. A client-selected scope is display context only.
5. The microphone permission prompt occurs only after the person explicitly chooses to speak. Channel selection, page load, and incoming notification never trigger a device prompt.
6. Mobile users must be told when the browser requires the application to remain in the foreground. The system must not promise background PTT it cannot provide.
7. Permission denial, no device, a busy channel, a revoked assignment, or a reconnect must use the shared plain-language state and keep SygSphere messages/Dispatch available.
8. PTT does not alter a schedule, assignment, time record, attendance record, SygSphere message, notification history, or employee permission by itself.

## Required release gates

All prior Stage 4/5 gates remain mandatory. In addition, an interactive Stage 6/7 release requires:

1. An approved Stage 4 coordinator deployment with request-level authorization, idempotency, rate-limit, audit, and rollback tests.
2. Versioned command-specific payload validation that derives authority server-side and rejects unknown/overbroad fields.
3. SygShift and Sygilant verification of the identical contract digest and presentation-profile revision.
4. Two-device and restrictive-network evidence for microphone, active transmission stop, permission revocation, reconnect, and Dispatch fallback.
5. Rendered desktop, tablet, and phone checks for every state above, including keyboard, touch, screen reader, reduced-motion, long text, and tenant-isolation checks.
6. A controlled, revocable feature flag and a tested rollback path before any pilot account receives access.

## Explicit non-goals in this preparation

- No React dock, incoming-call modal, device chooser, microphone request, media permission, CSP/Permissions-Policy change, browser media API, Worker route, Durable Object binding, WebSocket, provider secret, feature flag, role grant, or employee transmission is enabled.
- No call, video, meeting, screen-share, usage, notification, or history record is created by this work.

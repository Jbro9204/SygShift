# SygSphere Communications — Stages 8–10 Pilot and Hardening Record

**Status:** Required before any employee is given interactive communications access. This is an acceptance record, not evidence that a call, PTT, video, meeting, or screen share has been enabled.

## Release principle

The Communications feature remains a protected, opt-in pilot capability until every applicable row below has a recorded pass. A visual green state, a provider dashboard entry, or a successful desktop-only demonstration is not enough. The pilot must prove that people can communicate without exposing another tenant, interrupting normal SygShift/Sygilant work, or losing the existing SygSphere and Dispatch fallbacks.

The release manager records the shared contract digest, both application release identifiers, coordinator release identifier, feature-gate revision, provider staging application identifier, and UTC test window with the evidence. Never record media, credentials, SDP, authentication tokens, employee personal data, or unredacted correlation identifiers in this file.

## Pilot boundary and roles

- Use two dedicated test accounts in one non-production tenant, then an approved, minimal pilot cohort. Do not begin with all employees.
- Test with at least two physical devices, two browser/device classes, and distinct network conditions; include a restricted network that uses TCP/TLS TURN if it is available.
- Assign a release manager, an on-call rollback owner, a tester on each device, and a privacy/security reviewer. The same person cannot self-approve every role.
- Use a disposable direct conversation, channel, meeting, and screen-share fixture. Do not use an employee incident, HR record, customer record, live site post, time record, schedule, or emergency event as a fixture.
- Keep SygSphere messaging and Dispatch operational throughout every test. Communications failure must not disable either fallback.

## Stage 8 — direct voice calling acceptance

| Test | Required result | Status / evidence |
| --- | --- | --- |
| Allowed caller and recipient | A caller can invite only an authorized member of the permitted tenant/scope. The recipient sees a plain-language ringing state. | Not run |
| Decline, timeout, and cancellation | Declining, expiry, caller cancellation, sign-out, or browser close ends the attempt for both sides without a stale active call. | Not run |
| Accept and end | Answer, mute, unmute, device selection, and end operate for their owner only. Ending the call stops publication and subscriptions promptly. | Not run |
| Missed-call history | A declined or expired call records only the minimal authorized history and notification. No media, token, diagnostic, or unrelated participant is exposed. | Not run |
| Permission and revocation | Denial causes employee-safe guidance; authorization loss during a call ends the media session and returns the person to messages/Dispatch. | Not run |
| Network recovery | A transition between available, degraded, offline, and restored network states never creates duplicate calls or duplicate history. Reconnection is calm and cancellable. | Not run |
| Tenant and role isolation | A cross-tenant, unassigned, expired, replayed, or role-revoked invite is rejected server-side and produces no caller-discoverable sensitive detail. | Not run |

## Stage 9 — video, meetings, and screen sharing acceptance

| Test | Required result | Status / evidence |
| --- | --- | --- |
| Camera is explicit | Camera access is requested only after a user selects video. Declining camera leaves supported audio, messaging, and Dispatch available. | Not run |
| Meeting membership and moderation | Only authorized participants can join. Participant changes, host/moderator actions, leave, removal, and revocation synchronize safely in both applications. | Not run |
| Screen share is user initiated | The browser's native chooser is launched only after a deliberate screen-share action. The application does not preselect a display, window, tab, or audio source. | Not run |
| Screen-share stop and revocation | The person, browser, moderator policy, authorization change, and network loss can stop sharing. Other participants promptly lose the track. | Not run |
| Unsupported devices | A device that cannot capture a screen is told so plainly and is not offered a broken control. Viewing behavior is tested separately. | Not run |
| Capacity steps | Run real tests at 5, 10, 20, and 50 authorized participants. Record join time, publish/subscribe recovery, CPU/memory concerns, accessibility, and failures. Do not extrapolate between steps. | Not run |
| Privacy and absence of recording | No recording, transcription, or retention behavior is implied or enabled unless separately approved, disclosed, authorized, and tested. | Not run |

## Cross-cutting security, recovery, and usability

Every pilot configuration must pass these checks before the cohort grows.

| Area | Required evidence | Status / evidence |
| --- | --- | --- |
| Ticket security | Bootstrap/connection tickets are short lived, one use, tenant-bound, actor-bound, scope-bound, and never placed in a URL, browser storage, browser log, or support message. Reuse and expiry fail closed. | Not run |
| Command safety | Unknown fields, repeated command IDs, stale sessions, unauthorized scope changes, and excessive requests are rejected server-side, audited minimally, and shown with shared plain-language copy. | Not run |
| Durable recovery | Idle reconnect, browser refresh, route change, duplicate socket, coordinator restart, and forced server closure recover without duplicate controls, ghost participants, or cross-tenant state. | Not run |
| Existing work preservation | Active reports, forms, PDFs, time corrections, schedules, HR cases, and email/message drafts retain their work while Communications opens, rings, reconnects, fails, or ends. | Not run |
| Accessibility | Keyboard, touch, visible focus, screen reader announcements, reduced motion, color contrast, long names, translated/long copy, and 320-pixel mobile layouts are verified in every state. | Not run |
| App parity | SygShift and Sygilant use the same contract revision, status meanings, permissions, and fallback behavior. Product colors may differ; workflow and safety behavior may not. | Not run |
| Telemetry honesty | Usage is marked unavailable until a source is available, estimated only when its inputs and model are recorded, and reconciled only after verified provider data is ingested. It is never presented as billing authority. | Not run |
| No raw technical errors | Employees never receive provider, WebRTC, token, database, or numeric diagnostic messages. Protected correlation/audit data remains out of the user interface. | Not run |

## Controlled pilot rollout

1. Confirm all applicable tables above are passing with immutable evidence links in the protected release record.
2. Enable only a named pilot cohort through a revocable, server-authoritative feature flag. Do not grant access by a client-only condition.
3. Watch protected service health, authorization denials, connection recovery, cleanup, and usage telemetry during a defined pilot window. Treat missing telemetry as missing—not zero.
4. Collect usability feedback from the pilot without asking users to interpret technical failures. Record the employee outcome, browser/device/network class, and redacted support correlation reference.
5. Expand in small cohorts only after the previous cohort is stable. A regression returns the feature to the prior cohort immediately.

## Emergency stop and rollback

- The primary stop is a server-authoritative feature-gate disable. It prevents new room, call, meeting, PTT, camera, and screen-share sessions without changing schedules, payroll, documents, messages, accounts, or historical records.
- The rollback owner can also disable the provider registry and invalidate future ticket issuance. Active media must receive the standard ended/reconnecting-safe outcome, then close according to the verified recovery policy.
- Do not force-reload a user who is completing normal work. The normal Sygilant reload notice is for safe application-version changes, not for routine mailbox or communications activity.
- Record the rollback timestamp, release identifiers, cohort, trigger, count of affected sessions, fallback availability, and restoration decision. Do not place secrets or media in the record.

## Release decision record

| Field | Required value |
| --- | --- |
| Decision | Not approved / Pilot approved / Expanded / Rolled back |
| UTC window |  |
| Contract digest and version |  |
| SygShift and Sygilant release IDs |  |
| Coordinator release ID |  |
| Feature-gate revision and cohort |  |
| Device, browser, and network matrix |  |
| Failed tests and mitigations |  |
| Rollback test result |  |
| Release manager / security reviewer |  |

No blank or failed applicable row may be converted into a production approval. The record remains a living release artifact through the pilot and is updated only with evidence from the exact tested release.

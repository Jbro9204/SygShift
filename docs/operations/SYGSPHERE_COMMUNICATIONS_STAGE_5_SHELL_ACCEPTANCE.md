# SygSphere Communications — Stage 5 Shell Acceptance

**Status:** Source-only lifecycle preparation and test plan. This document does not authorize an application-shell runtime.

## Purpose

When the shared communications runtime is eventually enabled, it must behave as a quiet, resilient layer in both SygShift and Sygilant. It cannot interrupt a report, form, document, schedule edit, time correction, or message draft.

The SygShift source now includes a pure, unmounted lifecycle reducer at `src/communications/sygsphereCommunicationsRuntimeLifecycle.ts`. It is closed by an immutable client-release switch and the shared server-sourced gate; it neither stores communications data nor opens a connection, requests a device, or changes application state. It exists only to make future account-change, authorization-loss, and sign-out cleanup deterministic.

## Required behavior

| Situation | Required result |
| --- | --- |
| A user opens a call panel while editing a form | The form remains mounted; unsaved field values and focus are retained. |
| The user changes routes during an active call | The active call remains connected unless the user explicitly ends it. |
| The browser refreshes or the network drops | The interface shows a plain-language reconnecting state; it never exposes provider errors or codes. |
| Camera or microphone permission is denied | The user can continue without media and receives one clear next step. |
| The service is unavailable | SygShift and Sygilant retain their normal workflows and direct the employee to SygSphere messages and Dispatch. |
| A user signs out or loses permission | The communications session ends, local transient state is cleared, and no tenant data remains visible. |
| A mobile app is backgrounded | The user is told that foreground behavior is required where the browser cannot support the requested action. |

## Acceptance matrix

Before an enabled Stage 5 build can be approved, test all items below on SygShift and Sygilant.

1. **Route persistence:** Start from a report, schedule edit, document fill, employee lifecycle case, time correction, and SygSphere thread. Open and close the communications UI without losing unsaved work.
2. **Navigation persistence:** Change routes during ringing, active, reconnecting, and ended call states. Confirm state remains accurate and duplicate controls do not appear.
3. **Permissions:** Test allowed, denied, dismissed, revoked-after-grant, no-device, and device-changed states for microphone and camera.
4. **Failure recovery:** Test offline, slow network, forced coordinator close, expired authorization, tenant mismatch, and provider unavailable. Confirm employee-safe copy and a return path.
5. **Identity isolation:** Use two tenants and two permission levels. Confirm a session, badge, notification, history item, or presence change never crosses identity or tenant boundaries.
6. **Accessibility:** Keyboard, screen-reader, focus-order, reduced-motion, contrast, touch-target, visual, and audible notification checks must pass.
7. **Responsive layouts:** Verify phone portrait, phone landscape, tablet, laptop, and wide desktop. No call control may obscure the primary page action.
8. **Draft preservation:** Validate text in every relevant editable control remains unchanged after the dock opens, closes, reconnects, or reports an error.

## Release evidence

Store the two-application results with the shared contract revision, coordinator release ID, test account roles, devices/browsers, timestamps, known limitations, and rollback result. A passing desktop-only demonstration is not sufficient.

## Explicit non-goals before acceptance

- Do not show a communications dock, request media permissions, add CSP media sources, or persist active-call browser state.
- Do not change existing SygSphere messages, Dispatch, notifications, forms, employee files, scheduling, timekeeping, payroll, or HR workflows.

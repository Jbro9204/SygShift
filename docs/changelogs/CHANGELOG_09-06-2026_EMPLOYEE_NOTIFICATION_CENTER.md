# SygShift Employee Notification Center

**Released:** September 6, 2026

## What changed

- Added a personal **My Notifications** inbox for every signed-in employee.
- Added a prominent bell in the top information bar. It displays the unread count, changes state when attention is required, and uses a stronger pulse for unread urgent items while respecting reduced-motion preferences.
- Added separate unread, requires-action, and urgent totals; All, Unread, and Requires Action views; notification-type filtering; bounded pagination; read, acknowledge, open-related-item, and dismiss actions.
- Integrated Support Ticket lifecycle messages into the personal inbox, including prior ticket notifications already waiting in the system.
- Added an MFA-protected notification composer for authorized users. Messages can target individual active employees, one or more roles, or both; duplicate recipients are removed automatically.
- Restricted the company-wide audience to Admin. Admin retains delivery visibility, while other notification managers receive only the capabilities granted by their exact effective permissions.
- Added routine, important, and urgent priorities; optional required acknowledgment; optional links back to relevant SygShift work; and review-before-send confirmation.
- Added optional transactional email delivery through the existing audited Cloudflare delivery processor, with bounded retry and failure recording.
- Preserved the existing administrative email-delivery operations as a separate tab so employee inbox work and technical delivery work are not mixed.

## Ticket-page layout correction

- Rebuilt the Support Tickets search and status controls as balanced, properly padded 42-pixel fields.
- Removed the empty ticket panel's artificial full-height stretch and reduced the no-results state to a useful compact block.
- Added a dedicated compact pagination treatment with a 58-pixel bar and 38-pixel controls.
- Added desktop/mobile, light/dark regression checks with explicit maximum heights so the thick pagination and oversized blank panel cannot return unnoticed.

## Header refinement

- Slightly reduced the horizontal spacing between the four required U.S. time-zone clocks without removing or reordering them.
- Increased the date typography to better match the clock time while preserving the current 12-hour and parenthetical 24-hour time display.
- Added a clear divider around the new notification bell while preserving Pacific, Mountain system time, Central, and Eastern clock visibility.

## Security and reliability

- Notification tables use forced row-level security and deny direct browser table access.
- Employee identity, sender identity, recipient expansion, Admin-only company-wide delivery, and timestamps are derived and enforced at the database boundary.
- Sending and recipient lookup require the exact notification-management permission plus current MFA; employee inbox reads and actions are limited to the signed-in employee's own records.
- Required items cannot be dismissed until acknowledged. Acknowledgments and notification campaigns create audit evidence.
- Email jobs expose only the minimum recipient and plain-text message envelope to the service worker; provider delivery is audited and follows existing employee email safeguards.
- Applied production migrations `20260906133034_employee_notification_center.sql` and `20260906140000_employee_notification_composer_title_fix.sql` through isolated previews that selected only the intended migration each time.

## Verification

- Type checking and zero-warning lint passed.
- All 168 Vitest files and 805 tests passed.
- The production Worker and client builds passed.
- All 116 desktop and mobile Playwright checks passed, including new Support Tickets layout checks in both themes.
- The notification composer passes production schema lint after the forward-only employee job-title compatibility repair.
- Deployed Cloudflare Worker version `7cddbe03-f0c6-4752-b514-b57c5234e1ea`.
- Production health and readiness returned HTTP 200 with readiness `ready`; `/notifications` returned HTTP 200, the live application asset contains the new notification entry point, and the new inbox RPC returned the expected unauthenticated denial rather than a missing-function response.

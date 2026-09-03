# User Account Role Assignment Cleanup

Date: 09/02/2026

## Outcome

User Accounts no longer exposes the legacy workforce role and the newer permission-role library as two competing, duplicated role lists. The employee profile now explains each responsibility once and keeps the complete role capability without the long scrolling checkbox wall.

## Interface changes

- Renamed the legacy primary field to **Workforce role** and explains that it controls Schedule, Time & Attendance, and operational routing.
- Replaced **Additional access roles** with **Department & management access**.
- Built-in roles no longer repeat in the specialized access selector.
- Assigned specialized access packages appear once as compact removable cards.
- Remaining specialized roles are added from one bounded dropdown instead of a long scroll list.
- The employee-account summary and User Accounts directory no longer repeat labels such as **Primary Supervisor** beneath **Human Resources Manager**.
- Empty, loading, disabled, desktop, and mobile behavior continue to use the established design system.

## Security and preservation

- The underlying workforce-role and effective-permission model remains unchanged because legacy operational routing still depends on the workforce role.
- Existing assigned role identifiers are preserved in the save payload, including legacy assignments that are no longer exposed as duplicate choices.
- Role changes remain atomic, permission checked, MFA protected where required, and audited through the existing server boundary.
- Sandy Caughlan's saved Human Resources Manager access was not changed.
- No database migration or production-data mutation was required.

## Verification

- Full release gate passed: TypeScript, zero-warning lint, 156 test files / 755 tests, and both Worker and client production builds.
- Focused desktop and mobile Chromium checks passed 4/4 with no accessibility violations or horizontal overflow.
- Production asset verification confirmed the new labels and controls are present and the legacy duplicate labels are absent.
- Primary and fallback application, health, and readiness endpoints returned HTTP 200 and ready.

## Release status

- Implementation commit: `d15753f`, pushed to `origin/main`.
- Cloudflare Worker version: `2f81d99f-f42e-4dd2-b8c0-7ede951d2d44`.
- Database migration: not required.


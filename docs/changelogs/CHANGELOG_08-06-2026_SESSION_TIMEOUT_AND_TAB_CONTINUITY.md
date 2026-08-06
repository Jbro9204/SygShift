# SygShift Change Log — Session Timeout and Tab Continuity

Date: 08/06/2026

## Summary

SygShift now warns after 25 minutes of inactivity and signs the user out after 30 minutes. Returning from another browser tab or application no longer replaces the active workspace with the full-screen authentication loader during a routine token refresh.

## Root cause

- The application still used the original 8-minute warning and 10-minute logout policy.
- Every Supabase authentication event re-enabled the initial full-screen authentication state.
- Background-tab token refreshes could therefore unmount and recreate the active page, discarding unsaved screen selections and returning the user to that page's default view.

## What changed

- Increased the inactivity warning threshold to 25 minutes.
- Increased the inactivity logout threshold to 30 minutes.
- Kept the initial secure-session verification for a true application load.
- Changed background authentication refreshes to update permissions silently without unmounting the current workspace.
- Added regression tests covering the timeout policy and non-blocking refresh behavior.

## Quality assurance

- TypeScript type check: passed
- Lint with warnings denied: passed
- Automated tests: 164 passed across 34 test files
- Production build: passed
- Database migration: not required

## Expected behavior

Users can switch between SygShift and another browser tab or application and return to the same active page and in-page working state. A warning appears after 25 inactive minutes, and automatic sign-out occurs after 30 inactive minutes.

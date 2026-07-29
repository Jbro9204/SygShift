# SygShift Change Log — 07/29/2026

## Update: Account Activity Visibility + Users & Access Button Layout

### What changed

- Added account activity visibility to Users & Access.
  - The employee table now shows whether the login exists, whether the account has activated, and the last recorded login.
  - The employee management window now shows a fuller account activity panel with activation, last login, password setup state, MFA status, and remembered-device count.
- Updated the admin directory database helper so last login is read from Supabase Auth when available.
  - This prevents stale account metadata from showing “Never” when the user has actually signed in.
  - Backfilled activation dates for accounts that had a real Auth login timestamp but no local activation timestamp.
- Fixed the Users & Access filter/action button row.
  - Role, Status, Login, Add employee, Create missing logins, and Email new logins now sit in a controlled responsive grid.
  - The layout no longer relies on loose wrapping that caused controls to merge or overlap.
- Added a button-layout guardrail test for Users & Access.
  - Future changes should fail tests if this toolbar regresses back into broken/merged button behavior.

### Verification completed

- Database migration applied successfully to production Supabase on 07/29/2026.
- Live account timestamp sanity check confirmed recent login data is available.
- TypeScript check passed.
- Full automated test suite passed: 28 test files, 103 tests.
- Lint passed.
- Production build passed.
- Cloudflare deployment completed successfully.

### Production deployment

- Deployed to Cloudflare on 07/29/2026.
- Production URL: https://app.sygilant.us
- Worker URL: https://sygshift.sygilant.workers.dev
- Cloudflare Version ID: `787f1057-ca3e-4b99-b9ee-0580523afe39`

### Notes

- Existing unrelated modified/untracked workspace files remain in the repo and were not part of this update.
- The account activity display is intentionally compact in the table and detailed in the employee window so the page stays usable without becoming cluttered.

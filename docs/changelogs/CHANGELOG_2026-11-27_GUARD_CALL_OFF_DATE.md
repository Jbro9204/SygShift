# Guard call-off date — 11/27/2026

Status: local candidate. No deployment or production database change.

- In My Time and the urgent call-off form, the Date field follows the selected shift's start date in its recorded time zone. When the employee and shift dates differ, the selector shows both dates. Clearing the shift restores the date entered for a date-only report.
- Shift-linked reports still submit the selected shift ID and let the existing attendance function resolve the occurrence. Date-only reports still submit the entered date. The call-off, coverage, and payroll processing rules are unchanged.
- The controlled Site T test saved November 29 even though the live form displayed November 27. The in-app Dispatch alert and coverage closure worked. The Worker suppressed email before provider submission because the fixed Dispatch mailbox matches the configured blocked domain. The company domain was deliberately blocked after a mail delivery issue, as recorded in the 08/23/2026 personal email delivery routing changelog.

## Local verification

- The date change was reapplied to upstream baseline d4a4f90 as a separate patch. The application change is confined to the shared call-off form.
- Six loopback Chromium cases passed across desktop and mobile viewports. The cases exercise maintenance access, future-shift selection, cross-time-zone dates, date-only fallback and submission with intercepted requests.
- The full local release verification passed, including 2,687 application tests with one skipped, native PostgreSQL safeguards, 108 operational email checks, all 42 time-clock browser cases and the final build. The physical phone test is deferred.

## Release controls

- Verified the live 486-row migration ledger against the exact November 27 Patrol source. All 485 prior ledger records and 617 unaffected owning sources matched the reviewed baseline. This release carries no migration changes.
- The release gate checks the already-installed Guided HR wrappers and their restricted implementations against the owning source, applied statement hash and exact runtime fingerprints. The read-only Sygilant input is the reviewed local owner manifest at bd141f5414f584d66858b40f743e09523ba73ed8.

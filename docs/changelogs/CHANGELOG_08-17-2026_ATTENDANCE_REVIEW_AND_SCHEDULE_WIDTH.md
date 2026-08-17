# SygShift Change Log — 08/17/2026

## Daily Attendance Review

- Corrected the review workflow that could time out and leave the missed-punch queue empty or incomplete over larger date ranges.
- Added a database fast path for published schedule occurrences with no recorded punches, time overrides, call-offs, or attendance events.
- Kept the complete reconciliation path for every occurrence that has recorded activity so worked segments, unpaid gaps, call-offs, corrections, and audit history retain their existing calculations.
- Continued grouping exact duplicate coverage slots before determining required headcount and missing employees.
- Preserved the published schedule and all original time records; the new calculation is read-only.
- Verified the production range 08/09/2026 through 08/16/2026 under the protected reviewer path. It returned 739 review rows, including 737 occurrences with no recorded time and 35 distinct scheduled employees missing time, in approximately 4.4 seconds.
- Compared the optimized and detailed calculations across sampled no-activity occurrences and confirmed identical results.

## Schedule Layout

- Updated the desktop Schedule view to fit the site/post column and all seven days within the available page width.
- Removed the desktop horizontal scrollbar and scroll instruction from the regular Schedule view.
- Preserved the existing dedicated mobile schedule layout for smaller screens.
- Kept Scheduler behavior separate from the regular Schedule view.

## Quality and Production Verification

- Added automated guardrails for the attendance-review fast path, full activity fallback, read-only behavior, and seven-day Schedule layout.
- Passed type checking, lint, 45 test files with 223 tests, and the production build.
- Applied production migration `20260817120000_attendance_review_missing_time_fast_path.sql`.
- Deployed Cloudflare Worker version `a0a18990-425b-404b-b99d-27e759dbf47b`.
- Verified the production health and readiness endpoints after deployment.


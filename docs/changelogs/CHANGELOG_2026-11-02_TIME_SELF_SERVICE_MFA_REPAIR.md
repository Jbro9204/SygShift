# Employee own-time MFA routing repair

Date: 11/02/2026. Application: SygShift Time & Attendance, including the shared platform entry. Source candidate; promotion and exact release evidence belong in the operator closeout.

## Incident and verified cause

Employees opening Time & Attendance received the global Verify your identity checkpoint and a no-available-method message that incorrectly referred to protected documents. Production health/readiness and scheduled runtime were healthy; this was a direct browser RPC failure, not evidence of a general login/provider outage.

The employee-owned accessor getOwnTimekeepingReview delegated to the team getTimekeepingReview accessor. The latter moved to get_timekeeping_review_v2 in the 10/26/2026 canonical review release. That wrapper intentionally requires MFA for team/payroll review before invoking the authoritative calculator. Both the Command Center and My Time therefore sent ordinary employees' self-service reads to the protected team endpoint. SQLSTATE 42501 and the genuine endpoint MFA error then correctly triggered the shared verification modal, although the caller should never have used that endpoint for personal hours.

Production logs verified 37 direct get_timekeeping_review_v2 HTTP 403 responses from 00:32:29 through 00:41:12 UTC on 11/03/2026 (the evening of 11/02 Eastern). A separate pair of payroll-rules permission failures is not silently reclassified or bypassed. The earlier verification-lifetime repair fenced stale sessions/pages; it did not correct this distinct self-service routing error. The latest invitation repair did not modify this call path or introduce a new employee MFA policy.

## Authoritative security checks

The existing public.get_timekeeping_review remains the sole calculator for effective punches, overnight pairing, breaks, corrections, payroll-week allocations, overtime and payroll categories. Its installed definition matched the independently fenced source. The private base resolves the authenticated active employee and only permits team scope when both MFA and existing effective team permissions are present. Otherwise, events, salary rows, time off and pending corrections remain scoped to that employee before aggregation. Private calculator helpers are not executable by browser roles.

An independently executed production READ ONLY transaction derived claims entirely inside SQL from an existing affected Guard session's metadata without exposing tokens, creating sessions, logging in, or changing the account. With AAL1/hasMfa=false, the existing canonical own-time RPC succeeded and all returned rows, pending corrections and exception history belonged to the actor. The same actor's v2 request failed with SQLSTATE 42501 and the exact MFA message. The transaction verified zero user-table writes and ended with ROLLBACK. No other employee's private data was output.

## Focused repair

- Employee-own-time reads call the existing get_timekeeping_review endpoint directly with the selected dates. They no longer invoke the team-MFA checkpoint or automatically retry through a different security path.
- Protected team getTimekeepingReview continues to call get_timekeeping_review_v2 through the existing verification coordinator. Its MFA and effective-permission enforcement are unchanged, including rejection of unverified team access.
- Extract the existing payload parsing/category normalization into one unchanged shared helper. Preserve existing client-side own-row and pending-correction filtering and summary construction in addition to the server's authoritative scope.
- Preserve server errors and their codes. A failed self-service read is shown as a failure; it is not treated as successful, converted into an MFA enrollment instruction, or replaced with fabricated/scheduled hours.

Product file: src/data/timekeeping.ts. Regressions: src/data/timekeeping.selfService.test.ts and src/time/TimeCommandCenterPage.selfService.test.tsx. Documentation: this changelog and DEVLOG.md. No database migration, Worker authorization change, permission/MFA catalog change, enrollment reset, employee exception or payroll policy change is introduced.

## Verification

Focused regression checks pass: the real own-time accessor and real Command Center/My Time/Identity Verification Host are exercised through a synthetic AAL1 transport that rejects the original wrong endpoint with the actual production error. Coverage includes Guard/Admin/Supervisor own-time access without a checkpoint, unchanged assured team access, unchanged unassured team rejection, no protected-to-own fallback, single-attempt own read errors, employee isolation, selected historical dates/background refresh, adjusted overnight/DST timestamps, breaks, payroll categories and weekly allocations. The four actual-page checks and fourteen accessor checks passed before the complete exact-source release gate. A combined focused run passed 50 checks across five integration/regression suites; TypeScript and zero-warning owned-file lint also passed.

The full application check, exact-main detached verification, both required GitHub push jobs, all 42 mandatory desktop/phone Time Clock browser checks, fresh production build, protected deployment and independent live source/health/asset checks remain mandatory. Record exact results and actual deployment status in the operator receipt; local focused tests are not a production completion claim.

## Presentation and release limitations

The v2 team wrapper adds work-type enrichment beyond the existing canonical self payload. The self-service repair does not reintroduce the old expensive history-map query, copy the payroll calculator, or invent training classifications. If the canonical self payload omits the optional enrichment, the historical review row's optional Paid training or Needs classification review suffix may be absent. The own page does not display a false Post label from parser defaults. Core row status, effective minutes, categories, allocations and the separate recent-punch training labels remain unchanged; supplied enrichment fields are preserved. Team payroll retains full v2 enrichment and existing mixed-classification protection.

No dedicated authenticated read-only release canary is configured. After the documented fallback was described for this incident, the owner instructed proceeding with repair without repeated approval prompts. Use that existing bounded fallback: automated role/clock tests, read-only live security probes, anonymous access boundaries, repeated health/readiness checks and rollback protection; a genuinely affected employee must still confirm the signed-in result. Never fabricate that confirmation or create operational punches to test.

Long-open browser sessions need the existing update/refresh control to load the repaired client. Preserve the current authorized login session; do not require a password reset or MFA enrollment for ordinary personal-hours viewing. The generic no-method modal wording is not the cause and is not disguised as the repair.

Application rollback is the preceding verified Worker version. It requires no data rollback because no database or operational record is modified. The earlier finite-ban compatibility repair and existing audit evidence remain intact. No maintenance window, shutdown or manual cron execution is required.

# HR Short-Notice Call-Out Report — September 21, 2026

## Outcome

Human Resources now has a protected, focused report for employees who called
out with less than four hours of notice. The report uses the scheduled shift
start and the documented time the call was actually received. Exactly four
hours is compliant and is not included; 239 minutes or less is included.

The Reports library was also normalized so every available report uses the
same card structure, spacing, typography, gold accent, and full-width action.

## HR report behavior

- Added **Short-Notice Call-Outs** to the report library for users with
  `hr.reporting.view`.
- Added a dedicated route guard plus an MFA- and permission-protected database
  boundary. Ordinary Time, Patrol, Licensing, Client, and Operations report
  access does not grant access to this HR report.
- Uses `call_received_at` when Dispatch or management documented it, with the
  immutable report timestamp as the legacy/self-service fallback.
- Separately identifies after-start reports and no-call/no-show occurrences.
- Includes employee, scheduled shift, client, site/post, received-by,
  submission source, notice minutes, reason, operational notes, current
  coverage, replacement, overtime impact, HR review outcome, reviewer, and
  decision note.
- Provides search plus notice-window, occurrence, HR-review, and coverage
  filters; summary metrics; paginated detail; and direct links to the coverage
  record and Accountability Tracker.
- Exports the complete filtered record set to a two-sheet Excel workbook and a
  protected PDF. Each server-authorized export appends an audit event.
- Documents facts and operational impact only. The report does not infer
  protected leave, assign discipline, or create attendance points.

## Report-library presentation

- Replaced the report-specific card variations with one centralized catalog
  card component.
- Standardized category labels, titles, descriptions, spacing, gold borders,
  button placement, card height, and responsive behavior.
- Uses three balanced columns on wide screens, two at intermediate widths, and
  one contained column on mobile.
- Preserved every report's existing permission visibility and destination.

## Security and preservation

- Production database access requires recent MFA and the effective
  `hr.reporting.view` permission.
- Downloads additionally require `hr.reporting.export`.
- The function is revoked from public and anonymous access and granted only to
  authenticated users after its internal authorization checks.
- No schedules, punches, timecards, call-off source records, coverage records,
  attendance decisions, notification behavior, payroll calculations, or
  existing report data were changed.
- The release retained the currently deployed SygSphere reliability work and
  did not replace it with the older main-branch Worker.

## Verification

- Full combined repository gate: **299 test files / 1,596 tests passed**, with
  strict TypeScript, zero-warning application/Worker lint, production builds,
  and the static-asset contract.
- Focused browser preservation matrix: **50/50 passed** across desktop and
  mobile, covering the new report, uniform light/dark report cards, and the
  complete Time Clock workflow.
- Accessibility checks passed for the report library and the desktop/mobile
  report workspaces; no horizontal overflow was detected.
- The linked Supabase dry run identified exactly one migration. Migration
  `20260921193740` applied successfully.
- A rollback-only production database regression proved that 239 minutes is
  included, exactly 240 minutes is excluded, after-start and no-call/no-show
  classification is correct, exports append one audit event, non-HR access is
  denied, and all fixtures are rolled back.
- Both production origins returned health `ok`, readiness `true`, and HTTP 200
  for `/reports`.
- The live Reports bundle is byte-identical to the verified combined build on
  both origins (SHA-256
  `8B4564D26060054B16286EF7038056733C7B7633E1A1B8B82F05F52D263FD76A`).

## Production references

- Database migration:
  `20260921193740_hr_short_notice_call_out_report.sql`
- Source commit: `b63d035`
- Cloudflare Worker version:
  `bf9dfd7d-e577-45cf-800e-9b82b208b23a`
- Rollback tag: `rollback/pre-hr-short-notice-report-20260921`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`

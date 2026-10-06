# EP / TRUEP Payroll Classification

Date: 10/06/2026
Status: Release verification in progress

## Outcome

SygShift now supports three mutually exclusive shift-level payroll reporting
categories: **Regular**, **EP**, and **TRUEP**. Regular remains the default.
EP and TRUEP are available only when an authorized administrator explicitly
enables those classifications for the Site. No existing Site was enabled or
guessed from its name or code.

The categories separate actual worked hours for Finance and Payroll without
changing pay rates or deciding overtime treatment. Regular, EP, TRUEP, and any
preserved legacy-unclassified hours partition Total Worked Hours. Overtime is
shown separately as a subset of those same worked hours and must not be added
to the category totals again.

## Scheduling and site controls

- Added an explicit **Enable EP / TRUEP classifications for this site** control
  to Site administration. New and existing Sites remain Regular-only until an
  authorized user enables the option.
- Added a responsive Regular / EP / TRUEP selector to shift creation and
  editing for enabled Sites. The selector is usable on desktop and phone,
  retains accessible touch targets, and fails closed when category data cannot
  be loaded.
- Added EP and TRUEP badges to scheduled shift cards.
- Preserved classifications through shift copies, future-week copies,
  call-off coverage, open coverage, replacement assignments, and same-week
  schedule revisions.
- Historical non-Regular shifts remain visibly classified if a Site is later
  disabled, but new non-Regular classification at that Site is rejected.

## Actual worked time and corrections

- Added a punch-time category snapshot and an append-only, MFA-protected
  correction history for unlocked worked-time occurrences.
- Category resolution uses the existing authoritative payroll occurrence
  model, including overnight shifts, Saturday-to-Sunday week boundaries,
  occurrence and Site/Post overrides, invalid-link repair, session inheritance,
  manual entries, and voided punches.
- A category correction applies to the complete active occurrence rather than
  one isolated punch. The original evidence is retained.
- Corrections and payroll export use the same transaction advisory lock and
  recheck the occurrence after waiting, preventing a correction from racing a
  payroll lock.
- Salary-default and other non-time rows remain in their existing pay totals
  but contribute zero to Regular, EP, TRUEP, and legacy-unclassified worked
  hours.

## Payroll review and export

- Added separate Regular, EP, TRUEP, Total Worked, Non-Overtime, and Overtime
  values to payroll review, CSV, XLSX employee summaries, weekly detail, Site
  summaries, and employee detail sheets.
- Added employee, work date/shift, Site/Post or venue, category, and approved
  worked hours to detail output.
- Mixed or unresolved category occurrences block official payroll lock with a
  clear review message.
- Existing locked payroll JSON was not rewritten. Historical locked rows that
  did not record a category remain visibly **Legacy / unclassified**.
- Rates, venue-specific pay, tax treatment, and legal overtime allocation
  remain owned by Finance and Payroll; this release does not infer or change
  them.

## Security and preservation

- Site visibility retains the latest manage-only effective-permission rule, so
  a person-specific deny cannot be bypassed by a role label.
- Schedule category visibility mirrors the complete current schedule-view
  permission set, including direct delete-shift and warning-override grants.
- Public database functions recheck active identity, effective permission, and
  MFA where required. Internal helpers and the append-only correction table are
  not directly exposed to browser roles.
- The database change is additive and forward-only. No schedule, punch,
  correction, locked payroll row, employee, Site, role, or permission history
  is deleted or rewritten.

## Verification

- [x] Linked production-schema migration plus regression rehearsal completed in
  one outer transaction with a final rollback.
- [x] Regression coverage includes overnight and Saturday-to-Sunday work,
  voided conflicting punches, occurrence/shift overrides, category correction,
  mixed-category lock rejection, deterministic shared locks, permission parity,
  and salary-default exclusion.
- [x] Independent review found no remaining high- or medium-severity issues.
- [x] Full `pnpm check`: TypeScript, zero-warning lint, **359 passed / 1
  skipped test file** and **1,963 passed / 1 skipped test**, production builds,
  and static-asset validation passed.
- [x] Focused payroll-category layout coverage passed on desktop Chromium and
  Pixel 7/mobile Chromium with no clipping or horizontal overflow.
- [x] Final post-change browser matrix passed **44/44**: **42/42**
  actual-component Time Clock workflows plus **2/2** responsive payroll-category
  layout checks across desktop and mobile Chromium.
- [x] Targeted production migration application and installed-definition
  verification completed. All **59,144 existing shifts** and **2,130 existing
  time events** remain Regular, **0 Sites** were auto-enabled, and **0 category
  corrections** were created during migration.
- [x] Supabase database advisors completed: no feature-specific performance
  warnings; authenticated RPC notices were reviewed as intentional endpoints
  with database-enforced identity, permission, and MFA checks.
- [ ] Git push, Cloudflare deployment, production health/readiness, exact live
  asset, and authenticated-workspace verification.

## Operational activation

After release, an authorized Site manager must deliberately enable EP / TRUEP
for each applicable Site. Until that happens, every shift remains Regular and
no scheduler sees the non-Regular choices. Finance and Payroll should confirm
their downstream import mapping for the new columns before relying on them for
live pay processing.

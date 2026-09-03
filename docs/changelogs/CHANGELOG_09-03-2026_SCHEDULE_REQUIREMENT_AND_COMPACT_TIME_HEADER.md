# Schedule Requirement Labels and Compact Operational Time Header

Date: 09/03/2026

## Outcome

Employee-facing schedule and time surfaces now show the requirement of the specific shift position: **Armed** for an armed position and **Unarmed** for an unarmed position. The four-zone operational clock system also uses one substantially smaller integrated information bar while retaining every time zone and the existing time-teaching behavior.

## Reported impact and root cause

- A mixed B'Nai coverage plan correctly contained one armed and one unarmed schedule block, but the employee calendar could still display **Armed coverage** on the unarmed position.
- The per-shift `requires_armed` value was correct. Several display surfaces preferred a shared Post name that could contain a generic Armed/Unarmed label, so presentation could disagree with the selected position.
- The existing global clocks were accurate but occupied a separate large stacked region beneath the account bar.

## What changed

- Added one centralized display helper that aligns only generic requirement-bearing Post names with the authoritative shift-level `requires_armed` value. Physical Post names and event names are preserved.
- Added explicit Armed/Unarmed labels to Schedule cards, Home, open opportunities, Action Center details, My Time choices, and Time & Attendance shift choices.
- Integrated the date, Eastern/Central/Mountain/Pacific clocks, appearance controls, account identity, and Sign Out into one compact shared header.
- Retained all four analog and digital clocks in the established order.
- Replaced **Operational default** with the clearer **System time** label on the highlighted Mountain clock.
- Preserved the one synchronized timer and the existing adaptive format: ordinary civilian time during `01:xx–12:xx`, with parenthetical 24-hour time during `00:xx` and `13:xx–23:xx`.
- Wide desktop uses a 72-pixel single row. Constrained desktop keeps four clocks on a compact second row, and tablet/phone layouts use two columns without hiding a zone or requiring horizontal scrolling.

## Files changed

- `src/lib/shiftDisplay.ts`
- `src/data/opportunities.ts`
- `src/pages/ActionCenterPage.tsx`
- `src/pages/OverviewPage.tsx`
- `src/pages/SchedulePage.tsx`
- `src/pages/TimePage.tsx`
- `src/time/MyTimePage.tsx`
- `src/time/TimeWorkspace.tsx`
- `src/components/OperationalTimeHeader.tsx`
- `src/App.css`
- `src/theme.css`
- Focused unit, source-guard, and Playwright regression tests
- `docs/ARCHITECTURE.md`
- `DEVLOG.md`

## Verification

- Focused Vitest validation passed: 5 files / 23 tests.
- Global-header Playwright validation passed: 22 tests across desktop and mobile Chromium projects.
- Rendered inspection passed at 1440, 1024, 768, 390, and 320 pixels, including the longest afternoon display `11:59 PM (23:59)`, light/dark presentation, reduced motion, accessibility analysis, and horizontal-containment checks.
- Full `pnpm check` passed: TypeScript, zero-warning application lint, 163 test files / 783 tests, and both production builds.
- Full Playwright release validation passed: 108 tests across desktop and mobile Chromium projects.

## Data, migration, and access status

- No database migration is required.
- No employee, schedule, assignment, qualification, opportunity, punch, time-card, payroll, permission, or audit record is changed.
- Armed qualification enforcement and all existing schedule/time authorization boundaries are unchanged.

## Git and deployment status

- Commit and push: pending final release gate.
- Cloudflare deployment: pending final release gate.
- Live health/readiness and authenticated workflow verification: pending deployment.

## Remaining scope

- The separate **Employee-Local Shift Time Presentation** Future item remains open. This release changes the compact global clock presentation and corrects requirement labels; it does not change employee-local schedule conversion, clock eligibility, stored timestamps, or payroll ownership.

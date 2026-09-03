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

- Implementation commit `f4ec99f` was pushed to `origin/main`.
- Cloudflare Worker version `5c6aa879-d39a-41cd-85f4-353b6796516d` was deployed successfully to the primary custom domain and Worker fallback.
- Primary and fallback health/readiness checks returned HTTP 200, and both readiness responses reported ready.
- Deployed-asset inspection confirmed the requirement-aware Armed/Unarmed helper, the compact operational-clock details, the **System time** label, and the responsive two-column clock layout.
- Authenticated production inspection confirmed four visible clocks, one highlighted **System time** label, requirement-aware **Unarmed coverage** schedule cards, and no page-level horizontal overflow.

## Follow-up legibility refinement

- Increased the full-width clock faces from 30 to 34 pixels and the constrained-width faces from 28 to 32 pixels.
- Increased the primary digital time from 10–11 pixels to 12 pixels, the zone label from 10 to 11 pixels, and the **System time** badge from 8 to 9 pixels.
- Slightly widened each clock card and its internal spacing while retaining the 72-pixel wide-desktop header, the constrained four-clock row, and the tablet/phone two-by-two layout.
- Added regression minimums for the time, zone, and clock-face sizes while retaining long-afternoon-time clipping, accessibility, reduced-motion, ordering, and horizontal-containment checks.
- The focused header suite passed all 22 desktop/mobile checks at 1920, 1440, 1280, 1024, 768, 390, and 320 pixels. The combined branch passed `pnpm check` with TypeScript, zero-warning lint, 163 test files / 784 tests, and both production builds.
- The aggregate Playwright run passed 107 of 108 checks; its sole unrelated Access Control fixture race passed immediately on isolated retry. The header suite was rerun after integrating the concurrent Client Directory release and passed 22 of 22.
- Implementation commit `e10e913` was pushed to `origin/main`, and the combined branch tip was deployed as Cloudflare Worker version `60526ed7-b5d9-4e6c-b2e1-27f64574077e`.
- Primary and fallback health/readiness returned HTTP 200 and ready. The live stylesheet contains the 12-pixel time, 11-pixel zone, and 34-pixel face rules.
- Authenticated live measurement confirmed four clocks, no clipped digital times, and no page-level horizontal overflow.
- No database migration or production-record change was required.

## Second incremental legibility refinement

- Increased the full-width clock faces from 34 to 36 pixels and constrained-width faces from 32 to 34 pixels.
- Increased the primary digital time from 12 to 13 pixels on desktop and to 12.5 pixels on phones, the zone label from 11 to 12 pixels, and the **System time** badge from 9 to 10 pixels.
- Slightly widened the clock cards again while tightening only the phone card padding enough to protect the longest teaching-format time at 320 pixels.
- Preserved the same 72-pixel wide-desktop header, four-zone order, highlighted Mountain system time, constrained four-clock row, tablet/phone two-by-two layout, and synchronized time behavior.
- Focused component checks passed 7 of 7. The header browser suite passed all 22 desktop/mobile checks across 1920, 1440, 1280, 1024, 768, 390, and 320 pixels, including the longest `11:59 PM (23:59)` display.
- The combined branch passed `pnpm check` with TypeScript, zero-warning lint, 163 test files / 785 tests, and both production builds after incorporating the concurrent Scheduler Dispatch-overlap acknowledgement release.
- Implementation commit `3c50a88` was pushed to `origin/main` and deployed as Cloudflare Worker version `dccced08-4911-4f72-a041-382dc9b0e2d5`.
- Primary and fallback health/readiness returned HTTP 200 and ready. The live stylesheet contains the 13-pixel desktop time, 12.5-pixel phone time, 12-pixel zone, and 36-pixel face rules.
- Authenticated live measurement confirmed four clocks, the intended 13/12/36-pixel desktop sizing and 10-pixel system badge, zero clipped times, and no page-level horizontal overflow.
- No database migration or production-record change was required.

## Final gradual legibility increment

- Increased the full-width clock faces from 36 to 38 pixels, constrained-width faces from 34 to 36 pixels, and phone faces from 34 to 35 pixels.
- Increased the primary digital time from 13 to 14 pixels on desktop and from 12.5 to 13 pixels on phones, the zone label from 12 to 12.5 pixels, and the **System time** badge from 10 to 10.5 pixels.
- Slightly widened each clock card while reducing only phone-level internal spacing to protect the longest teaching-format time at 320 pixels.
- Preserved the compact header, all four zones, highlighted Mountain system time, responsive four-clock and two-by-two layouts, and the existing synchronized time behavior.
- Focused component checks passed 7 of 7. The header browser suite passed all 22 desktop/mobile checks across 1920, 1440, 1280, 1024, 768, 390, and 320 pixels, including the longest `11:59 PM (23:59)` display.
- The full `pnpm check` release gate passed with TypeScript, zero-warning lint, 163 test files / 785 tests, and both production builds.
- Implementation commit `4d62085` was pushed to `origin/main` and deployed as Cloudflare Worker version `c69124f0-cda9-4d83-94c5-7e42c1267d27`.
- Primary and fallback health/readiness returned HTTP 200 and ready. The live stylesheet contains the 14-pixel desktop time, 13-pixel phone time, 12.5-pixel zone, 38-pixel wide face, and 35-pixel phone face rules.
- Authenticated live measurement confirmed four clocks, the intended 14/12.5/38-pixel desktop sizing and 10.5-pixel system badge, zero clipped times, and no page-level horizontal overflow.
- No database migration or production-record change was required.

## Remaining scope

- The separate **Employee-Local Shift Time Presentation** Future item remains open. This release changes the compact global clock presentation and corrects requirement labels; it does not change employee-local schedule conversion, clock eligibility, stored timestamps, or payroll ownership.

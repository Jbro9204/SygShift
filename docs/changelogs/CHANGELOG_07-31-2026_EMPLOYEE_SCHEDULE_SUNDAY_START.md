# SygShift Changelog — 07/31/2026 — Employee Schedule Sunday Start

## Summary

Updated the employee-facing Schedule layout so the personal schedule runs Sunday through Saturday, matching the company payroll cycle while keeping the current card layout intact.

## Changes

- Changed the employee personal schedule display start from Monday to Sunday.
- Kept the existing weekly/two-week/month layout and visual styling.
- Updated the regression guard so future work protects Sunday-through-Saturday ordering.

## Validation

- Targeted schedule guard tests passed.
- Full lint passed.
- Production build passed.
- Full test suite passed: 149 tests.
- Cloudflare deployment succeeded.
- Live smoke check passed at `https://app.sygilant.us`.

## Production

- Live URL: `https://app.sygilant.us`
- Cloudflare Version ID: `c353d77c-85a5-4147-b9e8-abf12d7981a8`

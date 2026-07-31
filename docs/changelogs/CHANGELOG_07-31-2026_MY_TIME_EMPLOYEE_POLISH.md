# SygShift Changelog — 07/31/2026 — My Time Employee Polish

## Completed

- Fixed the employee landing card so Time-Off Requests and Shift Pool are both clear, separate actions instead of one vague coverage button.
- Opened the Time-Off Requests and Events & Openings routes to all employee roles while keeping management actions protected by page-level permissions.
- Removed the regular employee “Report sick / call-off” button from the My Time page header so the page no longer mixes employee actions with admin-style command tools.
- Kept Report Sick / Call-Off in the clock status workflow where it belongs, beside clock status and punch actions.
- Replaced the cheap-looking off-clock badge with a premium clock status pill using the same SygShift visual language.
- Reworked Recent Punches into selectable day tabs for up to seven recent punch days, so the panel no longer dumps every recent punch onto one cluttered list.
- Added layout styling for the new Overview request actions, clock status pill, and recent punch day selector.
- Added guardrail tests to protect route access, employee landing actions, recent punch grouping, and the new My Time styling from regression.

## QA

- `git diff --check` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 32 test files, 148 tests.
- `pnpm build` passed.

## Notes

- Employee-facing time actions are intentionally organized by context:
  - Clock in/out, break, and report sick/call-off live with clock status.
  - Time-off requests and shift-pool access live in the employee request card.
  - Time Command Center and Advanced Time Tools only show in the My Time header for users with team time permissions.

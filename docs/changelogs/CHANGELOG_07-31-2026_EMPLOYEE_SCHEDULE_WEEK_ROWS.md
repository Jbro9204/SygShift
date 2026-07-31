# SygShift Changelog — 07/31/2026 — Employee Schedule Week Rows

## Completed

- Reworked the employee-only Schedule view so personal schedule days render as complete Monday-through-Sunday week rows.
- Stopped the employee schedule grid from auto-fitting into six visible days and pushing Saturday into an awkward wrapped position.
- Kept the underlying schedule data lookup compatible with the existing Sunday-based schedule weeks while displaying the employee view Monday-first.
- Added horizontal overflow protection for smaller screens so a complete week row stays intact instead of breaking the calendar layout.
- Added regression checks so employee schedule layout remains seven days per row and Monday-first.

## QA

- `git diff --check` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 32 test files, 148 tests.
- `pnpm build` passed.

## Notes

- This update changes the employee personal schedule display only. Operations schedule week storage and payroll week logic remain Sunday-through-Saturday.

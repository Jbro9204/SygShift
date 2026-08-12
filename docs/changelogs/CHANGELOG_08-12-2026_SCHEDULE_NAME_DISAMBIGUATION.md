# SygShift Change Log — Schedule Name Disambiguation

Date: 08/12/2026

## Summary

Schedule and Scheduler employee names now remain clear when a preferred name is only one character or when multiple employees share the same last name.

## Name display behavior

- A normal preferred name remains unchanged. `Zachary Ward` with preferred name `Zach` appears as `Zach Ward`.
- A one-character preferred name includes the employee's full first name. `Jainique Lee` with preferred name `J` appears as `Jainique (J) Lee`.
- An employee without a preferred name continues to use the recorded first and last name. `Joseph Lee` appears as `Joseph Lee`.
- The rule is centralized so Schedule and Scheduler do not develop inconsistent name formats.

## Scheduling workflow

- Applied the new display rule to schedule cards, selected assignments, employee pickers, employee-schedule views, staffing suggestions, and training assignment selectors.
- Added employee numbers to scheduling picker labels and selected-assignment details as a reliable second identifier.
- Employee picker sorting remains first-name based and now uses the clarified display name.

## Database and security

- Extended the schedule-builder and weekly-schedule payloads with employee numbers.
- Preserved active-employee filtering, schedule-view scoping, authenticated-only execution, and existing draft-management permissions.
- Applied and verified migration `20260812153000_schedule_name_disambiguation.sql` in production.

## Verification

- Confirmed the production functions include employee numbers.
- Confirmed authenticated users retain authorized access and anonymous execution remains blocked.
- Full regression suite: 42 test files and 204 tests passed.
- Type checking: passed.
- Lint: passed.
- Production build: passed.

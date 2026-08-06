# SygShift Change Log — Scheduler Employee First-Name Order

Date: 08/06/2026

## Summary

Employee choices used throughout Schedule and Scheduler are now ordered by the name staff recognize first: preferred name when present, otherwise legal first name, followed by last name.

## What changed

- Added one shared, locale-aware employee ordering rule to the schedule data layer.
- Applied the rule when schedule builder data loads so every scheduling employee selector receives the same order.
- Added deterministic tie-breaking by last name, legal first name, and employee ID.
- Preserved the existing employee search behavior and staffing-suggestion ranking.

## Areas covered

- Add shift or event
- Edit shift and switch/assign employee
- Manual assignment and review workflows
- Employee schedule filter
- Full-week employee view

## Quality assurance

- TypeScript type check: passed
- Lint with warnings denied: passed
- Automated tests: 162 passed
- Production build: passed
- Database migration: not required

## Result

Schedulers can locate employees by first name without needing to know or remember each employee's last name. The rule is centralized so future schedule employee pickers inherit the same behavior.

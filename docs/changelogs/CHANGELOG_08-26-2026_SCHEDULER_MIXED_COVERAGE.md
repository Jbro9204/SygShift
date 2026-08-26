# SygShift Change Log — Mixed Coverage and Additive Guard Assignment

Date: 08/26/2026

## Summary

Expanded the scheduling workflow so one coverage plan can require any supported combination of armed and unarmed positions, and so guards can be added to remaining positions without replacing people who are already assigned.

## Schedule Creation

- Replaced the single all-armed or all-unarmed assumption with two clear staffing values:
  - **Total guards needed**
  - **Armed positions**
- The form calculates and displays the resulting armed and unarmed staffing mix before saving.
- A three-person plan with one armed position now creates one armed coverage block and one two-person unarmed coverage block for the same Site/Post, date, and time.
- The initial guard can be placed into the armed or unarmed portion of the plan when both types are present.
- Permanent Site/Post schedules and one-time events use the same controlled workflow.
- Existing schedule records, including the current Miss Fits entry, were not changed by this release.

## Guard Assignment

- Replaced the ambiguous replacement action with **Add guard to open position**.
- Each save fills one available position and retains every existing active assignment.
- The action is disabled when no employee is selected or the coverage block is already full.
- The focused window closes after a successful save and refreshes the schedule immediately.
- Intentional reassignment and full-block editing remain separate workflows.

## Data and Security Safeguards

- Added a forward-only database function for mixed coverage creation.
- Added a separate forward-only database function for adding one assignment to an available position.
- Preserved armed-credential checks, availability warnings, administrative override documentation, MFA requirements, role permissions, schedule audit history, and announcement behavior.
- Explicit armed and unarmed requirements are stored independently instead of being overwritten by the Site/Post default.
- Capacity is checked while the schedule is locked so concurrent saves cannot overfill a coverage block.
- No public or anonymous execution access was granted.

## Validation

- Added regression coverage for mixed armed/unarmed plans, explicit requirement preservation, additive assignment behavior, form controls, and database mappings.
- Passed type checking and linting.
- Passed all 82 test files / 410 tests.
- Passed the production build and Cloudflare deployment dry-run.
- Applied and recorded targeted production migration `20260826200000_scheduler_mixed_coverage_assignments.sql`.
- Ran a rollback-safe production database test that created one armed position and two unarmed positions, added two guards, verified that both assignments remained active, and left no test schedule data behind.
- Deployed Cloudflare production version `347b38fe-0091-4b57-a2af-2dd1a9734fa9`.
- Verified HTTP 200 health and readiness responses on the custom domain and the Workers fallback.
- Verified that the live scheduler bundle contains the new mixed-coverage and additive-assignment controls.

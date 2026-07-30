# SygShift Dev Log — 07/30/2026 — Scheduler Draft Button Language

## Completed

- Updated the Scheduler “Add a shift or event” completion button so it no longer says “Publish shift.”
- The button now clearly says:
  - `Save draft shift`
  - `Save draft shifts`
  - `Save open draft shift`
  - `Save open draft shifts`
- Updated the pending state from `Publishing...` to `Saving draft...`.
- Updated the success message so schedulers see that the shift was saved into the schedule draft and that the schedule should be published separately when the week is ready.
- Preserved the existing save behavior and database path. This was intentionally a user-facing workflow clarity fix, not a risky scheduler data rewrite.
- Added a scheduler behavior guardrail test so this wording does not regress back to “Publish shift” in the add-shift modal.

## QA

- Targeted scheduler guard test passed.
- Typecheck passed.
- Lint passed.
- Production build passed.

## Workflow Clarification

- Adding or editing a shift is draft work.
- Publishing should only refer to the separate final schedule action: publishing the full schedule draft.
- The “Publish announcement for guards” checkbox remains separate because that controls whether an open-shift communication is created.

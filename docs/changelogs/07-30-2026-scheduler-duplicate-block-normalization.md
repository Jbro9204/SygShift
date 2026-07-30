# 07/30/2026 — Scheduler Duplicate Block Normalization

## Summary

Fixed the deeper scheduling issue where identical schedule blocks could exist more than once inside the same working draft. This caused duplicate cards, incorrect open coverage counts, and false overlap errors when schedulers tried to edit or assign shifts.

## What Changed

- Added a reusable database normalizer for duplicate schedule blocks.
- Duplicate draft blocks are now collapsed into one primary block when they have the same:
  - schedule revision;
  - site/post or event;
  - start time;
  - end time;
  - time zone;
  - armed/unarmed requirement.
- Active assignments from duplicate blocks are moved onto the primary block.
- Duplicate active assignments for the same employee are safely canceled instead of double-counted.
- Headcount is recalculated to preserve the larger required coverage count and all active assignments.
- Open/covered state is recalculated from real assignment count.
- Extra duplicate blocks are canceled so they no longer appear as open shifts or duplicate scheduler cards.

## Prevention

- Schedule draft opening now normalizes copied schedule data before returning the draft.
- Schedule draft edits now normalize the draft after save and return the cleaned schedule payload.
- Schedule publishing now normalizes the draft before it goes live.
- The overlap checker now ignores same-schedule duplicate blocks that are being normalized, so a duplicate block cannot falsely block the correction process.

## Live Data Repair

- Cleaned active duplicate blocks from working drafts in Supabase.
- Verified there are now zero active duplicate draft blocks.
- Verified there are now zero active draft assignments that the overlap checker falsely blocks.

## Spot Check

- Confirmed the `3 unarmed guards` Friday block is now one schedule block:
  - 07/31/2026, 7:30 AM–6:00 PM;
  - headcount 2;
  - Fernando Gomez and William Lane assigned;
  - not open.
- Confirmed the Saturday block is one schedule block:
  - 08/01/2026, 9:00 AM–6:00 PM;
  - headcount 1;
  - Fernando Gomez assigned;
  - not open.

## QA

- `pnpm check` passed.
- TypeScript passed.
- Lint passed with denied warnings.
- 29 test files passed.
- 112 tests passed.
- Production build passed.


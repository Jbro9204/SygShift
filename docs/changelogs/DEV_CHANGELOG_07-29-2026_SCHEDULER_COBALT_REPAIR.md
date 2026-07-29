# SygShift Dev Changelog - 07/29/2026 - Scheduler Cobalt Repair

## Production Issue

Michael reported that adding EP/Cobalt shifts from the Scheduler failed with:

`event_id: Invalid input`

He also reported that COBALT was not available as a site, forcing him to use an unrelated "3 unarmed guards" site.

## Completed

- Repaired the Scheduler create-shift response contract.
  - Confirmed production has the `scheduler_create_open_shift`, `scheduler_update_draft_shift`, and `scheduler_resolve_review_shift` RPC wrappers.
  - The live database function now returns `event_id` again.
  - The frontend parser now also tolerates older permanent site/post shift responses where `event_id` is omitted.
  - Added a regression test for a permanent post shift response that omits `event_id`.
- Added COBALT as a live operational site.
  - Site code: `COB`
  - Site name: `Cobalt`
  - Time zone: `America/Denver`
  - Posts:
    - `Unarmed coverage`
    - `Armed coverage`
- Verified COBALT exists in the live database with both posts active.
- Verified the live scheduler function definition includes `event_id` in its response payload.
- Deployed the corrected frontend/Worker bundle to Cloudflare.

## Important Scheduling Note

The Cobalt source schedule showed:

- Friday 07/31/2026: Cobalt, 07:30 AM-06:00 PM, Fernando and William
- Saturday 08/01/2026: Cobalt, 09:00 AM-06:00 PM, John Holliday, armed

I did not auto-insert those shifts because the latest draft already shows active overlaps:

- Fernando Gomez is already assigned during part of the Friday Cobalt window.
- William Lane is already assigned during the Friday Cobalt window.

That needs scheduler confirmation before replacing or overriding existing assignments. John Holliday appears armed-qualified for 08/01/2026 and did not show an overlap in the latest draft check.

## Validation

- `pnpm test -- src/data/scheduleBuilder.test.ts` passed.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `pnpm lint` passed.
- Live database COBALT verification passed.
- Live scheduler RPC wrapper verification passed.
- Cloudflare deployment completed.

## Deployment

- Cloudflare Worker version: `ba66465d-1591-4af8-85d5-ce5ba759ca48`
- App URL: `https://app.sygilant.us`

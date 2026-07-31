# SygShift Dev Changelog — 07/31/2026

## Directory and Licensing Center Workflow Cleanup

### What changed

- Increased the Directory profile modal width so employee profile information is not cramped.
- Removed credential and license management from the Directory profile modal.
- Kept Availability inside Directory so schedulers can still manage employee availability where it makes operational sense.
- Replaced the old Directory credential-heavy profile area with a cleaner employee profile snapshot.
- Added a dedicated employee list inside Licensing Center.
- Added a Licensing Center view switch:
  - Employee List
  - Credential List
- Reworked the employee Licensing Center profile so the user chooses a person, chooses one credential/license, then manages that one item.
- Kept record-level credential searching available through the Credential List view.
- Updated the sidebar/navigation surface so Directory is no longer treated as a credential-editing workspace.

### Why this matters

- Directory is now cleaner and less crowded.
- Licensing staff get a focused workspace designed around their actual job: choose an employee, review missing/expiring credentials, and manage the correct credential without hunting through a crowded modal.
- Schedulers still keep Availability access in Directory.
- Credentials now live where they belong: Licensing Center.

### Guardrails added

- Added tests that fail if Directory credential editing is accidentally brought back into the Directory page.
- Added tests that verify Licensing Center keeps the employee-first credential workflow.
- Added layout guard coverage for the new Licensing Center employee list and selected credential workspace.

### QA completed

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` — 32 files / 143 tests passing
- `pnpm build`

### Production status

- Deployed to production: `https://app.sygilant.us`
- Cloudflare Worker version: `58d7a0cc-df54-4645-838a-97e86b405387`

# SygShift Repository Instructions

These instructions apply to every file and task in this repository.

## Mandatory first step

Before inspecting, editing, testing, migrating, deploying, or reporting on SygShift, read:

1. `docs/BUILD_AND_HANDOFF_GUIDE.md`
2. `docs/ARCHITECTURE.md`
3. `docs/SECURITY.md`
4. `docs/future-items/FUTURE_ITEMS.md`
5. `DEVLOG.md`
6. The newest relevant files in `docs/changelogs/`

Do not work from `C:\Users\Jordan\Documents\DayZ Shirt`. The canonical repository on Jordan's primary workstation is `C:\Users\Jordan\Projects\SygShift`. On another workstation, verify the repository by confirming that its `origin` is `https://github.com/Jbro9204/SygShift.git`.

## Non-negotiable rules

- Preserve production data, audit history, active clock-ins, payroll history, schedule history, and employee access.
- Never expose or commit passwords, tokens, database credentials, service-role keys, private employee data, source workbooks, or payroll exports.
- Never edit or reorder a migration that may already be applied. Add a new forward-only migration.
- Authorization must be enforced at the database or Worker boundary, not only by hiding interface controls.
- Every mutation needs an explicit loading state, a clear result, immediate query refresh, and correct modal behavior.
- Use the existing design system and page-specific layout wrappers. Do not introduce one-off button or form styling.
- Treat `pnpm check` as the minimum release gate. Add targeted tests for every regression fixed.
- Do not claim completion without verifying the affected workflow at the database, application, and rendered-interface layers appropriate to the change.
- Keep Git clean and intentional. Do not discard or overwrite unrelated work.
- Every meaningful completed update requires a dated changelog in `docs/changelogs/` and a matching Desktop backup when that folder is available.
- Production dates display as `MM/DD/YYYY`. Colorado operations use `America/Denver`; authoritative timestamps are stored in UTC.
- Do not add development-tool authorship, generated-by notices, or assistant references to product code, user-facing copy, commits, or release artifacts.

## Release boundary

Deployment is not complete until:

1. Relevant migrations are applied and verified.
2. `pnpm check` passes.
3. Relevant end-to-end or live workflow checks pass.
4. The intended commit is pushed to `origin/main`.
5. Cloudflare deployment succeeds when deployment is in scope.
6. `https://app.sygilant.us/api/v1/health` and `/api/v1/ready` return healthy responses.
7. The changelog records what changed, what was tested, migration/deployment status, and any remaining limitation.


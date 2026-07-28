# SygShift Dev Changelog - Users & Access Audit Repair

Date: 07/28/2026

## Issue

Users & Access could not save employee profile changes because the live database function `public.admin_update_employee(...)` attempted to insert into `private.audit_log`.

That relation does not exist in SygShift. The real audit table is `private.audit_events`.

## Fix

- Patched the faulty migration source so future database rebuilds use `private.audit_events`.
- Added a production repair migration that replaces `public.admin_update_employee(...)`.
- Applied the repair directly to the linked Supabase production project.
- Verified the live function no longer references `private.audit_log`.
- Verified the live function now references `private.audit_events`.

## User-facing result

- Users & Access employee profile saves should no longer fail with `relation "private.audit_log" does not exist`.
- Employee updates still create audit history in the correct centralized audit table.

## QA completed

- Repository scan confirmed no remaining `private.audit_log` references.
- `pnpm typecheck` passed on 07/28/2026.
- `pnpm lint` passed on 07/28/2026.
- `pnpm test` passed on 07/28/2026 with 23 test files and 79 tests passing.
- `pnpm build` passed on 07/28/2026.

## Notes

- I intentionally did not run a blanket Supabase `db push` because the local and remote migration histories have existing drift from earlier manual database work. Running a full push would risk applying unrelated old migrations. This repair was applied as a targeted SQL patch only.

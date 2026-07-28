# SygShift Separation Private Function Repair - 07/28/2026

## Summary

Fixed the remaining live `column reference "separated_on" is ambiguous` error after confirming the source was inside `private.separate_employee_account_and_future_work`.

## What changed

- Added migration `20260728102000_employee_separation_private_ambiguity_repair.sql`.
- Updated the private employee separation workflow so the employee table column is qualified and the date argument is referenced without colliding with the column name.
- Qualified related account update references in the same function to reduce future ambiguity risk.

## Validation

- Applied the repair directly to the linked Supabase database.
- Re-scanned live database function definitions for `separated_on`.
- Confirmed no live function definition still contains the bad `separated_on = coalesce(separated_on` pattern.

## Deployment

- No Cloudflare redeploy was required because this was a database-only repair.
- Production URL remains `https://app.sygilant.us`.

# Cross-Platform Presence and SygSphere Read Receipts — September 16, 2026

## Outcome

SygShift and Sygilant now share one approximate availability model, while SygSphere shows exactly who read a message and when. User Accounts keeps sign-in history separate from live presence so administrators are not asked to interpret two different concepts as one status.

## Problem and root cause

- SygSphere's earlier presence value came from a page-local heartbeat and did not aggregate tabs, devices, or Sygilant activity.
- User Accounts exposed account setup and sign-in history but had no distinct live-availability view.
- The **Read by** count identified readers only through a title string and did not provide an accessible, touch-friendly reader list or read times.
- The two applications needed a shared database contract rather than separate timers or background scans.

## What changed

- Added private, per-auth-session and per-tab presence records for SygShift and Sygilant.
- Aggregated all current tabs, devices, and applications with **Active now** winning over **Away**, then **Offline** after heartbeat expiry; disabled or inactive accounts always report **Offline**.
- Added a durable private last-active summary so ordinary cleanup of expired heartbeat rows never changes a previously active employee back to **Never active**.
- Added a 45-second heartbeat, a five-minute idle threshold, and throttled interaction recovery without any minute-by-minute schedule or employee-table scan.
- Removed the legacy SygSphere activity write from 30-second directory and avatar reads while retaining the existing session-security, MFA, feature-gate, conversation, and sound-preference boundaries.
- Added a separate **Presence** filter and column to User Accounts, including last-active time and the current source application in a restrained tooltip.
- Replaced SygSphere's legacy page-only presence heartbeat with the shared reporter and added consistent status dots and plain-language labels.
- Made **Read by N** open an accessible reader panel on mouse hover, keyboard focus, or tap, with each reader's avatar, name, and exact read time.
- Limited reader identities and exact timestamps at the database boundary to the message author; other authorized participants receive an empty reader-detail list.
- Kept presence explicitly approximate. It is not attendance, payroll, timekeeping, discipline, or proof that a person saw or acted on work.

## Security and data integrity

- Presence tables live in the private schema with forced row-level security, no browser policies, and no direct `authenticated` table privileges.
- The write RPC validates the current authenticated employee and live authentication session before accepting a bounded application, client UUID, and `active` or `away` state.
- The directory RPC retains the existing User Accounts permission boundary. SygSphere reader details remain available only through the participant-protected message path.
- Application source is display metadata, not an authorization or employment fact.
- No employee, account, message, schedule, shift, punch, payroll, document, or audit record was deleted or rewritten.

## Database migrations

- `20260916132452_cross_platform_presence_and_read_receipts.sql`
- `20260916134702_cross_platform_presence_native_sygilant_session_repair.sql`
- `20260916135430_platform_presence_auth_user_index.sql`
- `20260916140140_platform_presence_history_retention.sql`
- `20260916141353_platform_presence_account_eligibility_repair.sql`
- `20260916142017_sygsphere_presence_write_deduplication.sql`
- `20260916142703_sygsphere_reader_identity_author_boundary.sql`

All seven migrations are registered in production. The final rollback-only regression passed active-wins aggregation, cross-application source aggregation, Away, expiry to Offline, durable last-active retention, disabled-account override, no-account Offline behavior, duplicate-write removal, and the author-only reader-detail boundary, then left zero session or history rows behind.

## Verification

- Full SygShift repository gate passed: **263 test files / 1,334 tests**, strict TypeScript, zero-warning application lint, Worker build, and client production build.
- Responsive SygSphere, User Accounts, and mandatory actual-component Time Clock browser matrix passed **100/100** across desktop and mobile.
- Focused presence contract and database guards passed **3 files / 7 tests** after the durable-history migration.
- Production contains the expected private tables, forced RLS, restricted RPC grants, supporting indexes, and no presence fixture data.
- Security advisor notices for the private no-policy tables and authenticated security-definer RPCs are expected for this intentionally RPC-only design; both RPCs enforce their own session or administrative permission boundary.
- The new auth-user index has not yet accumulated normal production use, but the prior missing-foreign-key-index finding is resolved.
- Both production SygShift origins returned HTTP `200` for health and readiness, with every readiness dependency true.
- The primary and fallback origins served the same versioned application assets. Cloudflare reports Worker version `4ac0e084-9f21-476b-b015-b40a428b19e3` at 100% of traffic.
- The coordinated Sygilant custom domain and immutable deployment both passed the production perimeter: 13 pages, 28 protected reads, one rejected hostile-origin mutation, and 72 versioned assets.

## Release references

- SygShift source commit: `a623fe9`
- Cloudflare Worker version: `4ac0e084-9f21-476b-b015-b40a428b19e3`
- Sygilant source commit: `da91892`
- Sygilant Cloudflare Pages deployment: `3c029dd4-8108-451d-95a3-431e6df7dec5`
- Sygilant immutable deployment URL: `https://3c029dd4.guardline.pages.dev`
- Rollback tag: `rollback/pre-cross-platform-presence-20260916`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`

## Files

- `src/components/PlatformPresenceReporter.tsx`
- `src/data/platformPresence.ts`
- `src/lib/platformPresenceState.ts`
- `src/pages/UserAdminPage.tsx`
- `src/pages/SygSpherePage.tsx`
- `src/data/sygsphere.ts`
- `src/App.css`
- `src/styles/sygsphere.css`
- `supabase/migrations/20260916132452_cross_platform_presence_and_read_receipts.sql`
- `supabase/migrations/20260916134702_cross_platform_presence_native_sygilant_session_repair.sql`
- `supabase/migrations/20260916135430_platform_presence_auth_user_index.sql`
- `supabase/migrations/20260916140140_platform_presence_history_retention.sql`
- `supabase/migrations/20260916141353_platform_presence_account_eligibility_repair.sql`
- `supabase/migrations/20260916142017_sygsphere_presence_write_deduplication.sql`
- `supabase/migrations/20260916142703_sygsphere_reader_identity_author_boundary.sql`
- `supabase/tests/platform_presence_regression.sql`

## Remaining limitation

Presence is deliberately approximate and expires safely when a browser closes, loses connectivity, or cannot refresh. It must not be used as an attendance or performance record.

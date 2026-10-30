# SygShift central emergency-access bridge

Date: 10/29/2026
Application: SygShift
Status: released and production-verified; controlled-account multi-device acceptance remains open

## Current-state gaps confirmed

- The existing **Disable login** control called `public.admin_set_employee_account_state` directly from the browser.
- That operation disabled SygShift application authorization, but it did not prove that Auth sessions, refresh tokens, shared-identity sessions, trusted devices, push subscriptions, presence, or open browser sessions had been removed.
- The interface said the employee would be signed out even though the operation could not verify complete cross-platform revocation.
- Browser and Worker authorization used the legacy session-context contract, which did not require the central emergency-access state or prove that the current Auth session row still existed.
- The SygShift-to-Sygilant signed destination allowlist did not include the Security Center.

## Architecture implemented

SygShift no longer presents its old account-state action as a complete revocation control. The employee access page now opens the centralized Sygilant Security Center through the existing signed platform handoff. The interface clearly separates access suspension from employment termination and directs restoration through the same protected control plane.

Protected SygShift access now consumes `public.get_session_context_emergency()` and fails closed unless all of the following are true:

- central emergency-access enforcement is active;
- the emergency-access state is `active`;
- the authorization context is active;
- the current Auth session still exists and is active;
- the access generation is present and valid.

The same contract is enforced by the browser, protected Worker routes, and Sygilant shared-identity handoff issuance. This prevents a stale browser token or stale shared-identity handoff from bypassing a central suspension.

Open SygShift clients now subscribe to the employee's private revocation topic and honor the central `access-revoked` event by clearing protected state, signing out locally, and returning to login. Browsers also revalidate the emergency session context when connectivity returns, the tab becomes visible, or the window regains focus so an offline device cannot remain trusted merely because it missed the live event.

## Interface changes

- Replaced **Disable login** and **Enable login** with **Open Sygilant Security Center**.
- Added plain-language guidance for **Suspend access only** versus **Terminate employment**.
- Added restoration guidance requiring role review, password reset, new MFA verification, and newly created sessions.
- Removed the claim that SygShift alone signs the employee out everywhere.
- Added strict signed navigation to `/security?employeeId=<uuid>` so the selected SygShift employee opens directly in the Security Center. Unrecognized parameters, actions, and fragments remain rejected.

## Files changed

- `src/pages/UserAdminPage.tsx`
- `src/data/adminUsers.ts`
- `src/data/auth.ts`
- `src/data/auth.test.ts`
- `src/data/platformLaunch.ts`
- `src/data/platformLaunch.test.ts`
- `src/components/AppShell.tsx`
- `src/components/AppShellLifecycle.test.tsx`
- `src/components/EmergencyAccessRevocationListener.tsx`
- `src/components/EmergencyAccessRevocationListener.test.tsx`
- `src/centralEmergencyAccessBridgeGuard.test.ts`
- `src/documentMfaBoundary.test.ts`
- `src/hrMfaWindow.test.ts`
- `src/sygilantSharedIdentity.test.ts`
- `src/userAccountActivityWorker.test.ts`
- `src/worker.test.ts`
- `src/workforceRoleAssignmentBoundary.test.ts`
- `tests/fixtures/clock-data.ts`
- `worker/index.ts`
- `worker/sygilantSharedIdentity.ts`
- `docs/work-orders/2026-10-29-emergency-access-revocation/migration-ownership-post-central-activation-v2.json`

## Verification completed

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- Complete application test suite: 389 files passed, 1 skipped; 2,286 tests passed, 1 skipped.
- Release-control suite: 189 tests passed, including migration ownership, database-release, exact-main, process-cleanup, and emergency-access preparation controls.
- Mandatory Time Clock browser matrix: all 42 desktop and mobile checks passed.
- Production build and static-asset contract: passed.
- Focused coverage verifies the private revocation topic, one-time forced logout, offline-return revalidation, central session-context rejection, exact Security Center destination, protected Worker denial, and shared-identity denial.
- The complete `pnpm check` gate passed under the repository's exact Node.js `24.19.0` and pnpm `11.25.0` toolchain after rebasing onto current `origin/main`.
- Exact source `dd5b532df4f792dd60be98002909b84d42c11e66` repaired the browser release fixture to use `get_session_context_emergency` and its enforced access-generation, active-session, emergency-enforcement, and emergency-state fields instead of the retired session-context mock.

## Production release and central activation

Exact source `dd5b532df4f792dd60be98002909b84d42c11e66` was released as Cloudflare Worker version `40129fe3-84d2-4d5c-956f-3c9339711f39`. Worker version `02ee56ae-7692-4072-a4e2-fbf1c071a1da` at source `3cc2a31eb69b028e73d047e3b3af96b18f72f25d` is the application rollback floor.

Wrangler did not return a candidate Version URL, so candidate-preview smoke checks were unavailable. The governed release completed as `released`, promoted the exact candidate, required two status-reconciliation reads, and did not roll back. Production verification used 31 live probes and three upstream probes. The pre-promotion full-success watermark was `2026-10-30T03:31:06.414Z`; the first post-promotion scheduled full success was `2026-10-30T03:31:57.399Z` on the exact source.

Independent live checks returned HTTP 200 from `/api/v1/health` with service `sygshift` and version `v1`. `/api/v1/ready` returned HTTP 200 with `ready=true`, status `ready`, exact source `dd5b532df4f792dd60be98002909b84d42c11e66`, scheduled-runtime mode `closed`, and zero consecutive failures. Readiness reported all required checks true: assets binding, scheduled-runtime coordinator, scheduled-runtime freshness and source, Supabase publishable and service-role keys, Supabase URL, shared-identity consumer and session secrets, and Sygilant consumer-secret, key-separation, and signing-secret checks.

The coordinated activation order was:

1. Commit the additive centralized precursor contracts `20261029230000`, `20261029230500`, `20261029231000`, and `20261029232000` without enabling the one-way enforcement switch.
2. Release compatible Sygilant and SygShift application paths, including SygShift Worker `40129fe3-84d2-4d5c-956f-3c9339711f39`.
3. Apply only `20261029233000_activate_emergency_access_control_plane` after the compatible application paths were live.
4. Pass the activation postflight and the rollback-only canary, whose explicit result was `emergency_access_control_plane_passed_in_rollback`, without retaining synthetic fixtures.
5. Capture the post-central-activation migration-ownership evidence without replaying or rewriting migration history.

The read-only post-central-activation evidence contains 427 applied migrations, 408 SygShift owning sources, and 151 Sygilant default-chain owning sources. Evidence paths are repository-relative and contain no workstation metadata. Its file SHA-256 is `71f80e4539676a31940139dd50ad144776b2e43398f8d966f7042a834a5e1328`, and its ledger SHA-256 is `76529a52ac0d0fc4bdfda85ceb0eeb33c65009efa6776f4a70cbf4131d20bdb8`. Comparison with the 426-entry precursor baseline found zero changed or removed earlier entries and exactly one addition: `20261029233000_activate_emergency_access_control_plane`, with eight statements, statement-array SHA-256 `ccafd1d523550fc2f4a60b7102fcb0ae419366d2692e228e7b82d3acd1028c54`, and ordered-statements SHA-256 `60d42cea563d864ebfeb0b229a613ab21aebd15ae6f552ebaa69e740b08d24c8`.

## Remaining acceptance evidence

No approved controlled production account and credentials were available for the required simultaneous Sygilant, SygShift, SygSphere, and SygTasks multi-browser/device exercise. The deployment, exact source, activation, live health, live readiness, scheduled runtime, and migration ownership are verified, but full zero-active-access receipt verification across every platform remains open. This release must not be described as complete end-to-end emergency-revocation acceptance until that controlled test is performed.

## Rollback plan

If an application rollback is required, roll SygShift back to Worker `02ee56ae-7692-4072-a4e2-fbf1c071a1da` at source `3cc2a31eb69b028e73d047e3b3af96b18f72f25d`. Do not restore the old browser-driven disable action or any retired mutation permission. The central activation is forward-only: database rollback must not be used to revive access, clear a fail-closed marker, or recreate the independent SygShift mutation path. Keep affected accounts disabled while the integration is repaired. Because the bridge itself adds no SygShift database migration and changes no employment, payroll, schedule, document, message, or audit record, application source rollback requires no SygShift data rollback.

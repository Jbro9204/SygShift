# SygShift central emergency-access bridge

Date: 10/29/2026
Application: SygShift
Status: prepared and locally verified; not deployed

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
- `worker/index.ts`
- `worker/sygilantSharedIdentity.ts`

## Verification completed

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- Complete application test suite: 389 files passed, 1 skipped; 2,286 tests passed, 1 skipped.
- Release-control suite: 189 tests passed, including migration ownership, database-release, exact-main, process-cleanup, and emergency-access preparation controls.
- Production build and static-asset contract: passed.
- Focused coverage verifies the private revocation topic, one-time forced logout, offline-return revalidation, central session-context rejection, exact Security Center destination, protected Worker denial, and shared-identity denial.
- The complete `pnpm check` gate passed under the repository's exact Node.js `24.19.0` and pnpm `11.25.0` toolchain after rebasing onto current `origin/main`.

## Activation dependencies and blockers

This SygShift bridge must not be deployed before the centralized Sygilant contract is live. Deploying it first would intentionally fail closed because `public.get_session_context_emergency()` would not yet exist.

Required activation order:

1. Deploy the centralized Sygilant emergency-access schema and orchestration.
2. Revoke browser execution of the legacy `public.admin_set_employee_account_state(uuid, boolean)` operation, leaving the centralized server operation as the only mutation path.
3. Confirm the Sygilant shared-identity consumer accepts strict `/security?employeeId=<uuid>` signed destinations.
4. Deploy this SygShift bridge.
5. Run the controlled multi-device production test and verify zero active access across every required platform before reporting completion.

No database migration, push, deployment, or live controlled-account revocation was performed in this SygShift worktree. Production zero-session verification therefore remains open.

## Rollback plan

If the central contract is unavailable after release, roll back the SygShift application and Worker together to the immediately preceding production source. Do not restore the old browser-driven disable action. Keep central access suspension in effect while the integration is repaired. Because this bridge adds no SygShift database migration and changes no employment, payroll, schedule, document, message, or audit record, source rollback requires no SygShift data rollback.

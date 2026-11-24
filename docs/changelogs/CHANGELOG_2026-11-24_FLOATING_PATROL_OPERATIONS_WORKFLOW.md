# Floating patrol Operations workflow — 11/24/2026

Status: application release candidate. The reviewed SygShift database migration is installed without activating a policy or changing any schedule, timeclock or report record.

- Put Floating patrol properties ahead of the fixed-route connection and open it directly from the protected section link. Search and select the exact employee and published shift; the existing server eligibility check remains authoritative.
- Provide a separate, explicit reusable scheduling-post list to authorized route and assignment managers. Confirm its broader effect and record a reason before saving. Exact shift approvals and connected routes take precedence. No default list was seeded.
- Verify both save paths by versioned readback. A lost response does not retry the write. An inherited scope can be blocked on the exact shift without changing the post’s list.
- Local checks: 51 focused Patrol and data-access tests, TypeScript, lint, and 16 real-component Chromium fixture cases on phone and desktop, light and dark. No live client data was used.
- The 42 new native database checks passed along with 369 schedule lifecycle and 11 lock checks. The hosted rollback rehearsal verified only the three intended existing routines changed and no policy was seeded. The 474-entry ownership baseline includes this migration and the separately released Sygilant dashboard migration; all 472 predecessors were preserved.
- Removing a reusable list blocks inherited access; it does not revoke existing exact-shift approvals. An unchanged site/client connection can become eligible again after reactivation if Operations did not revoke its approval.

The existing one-shift approval flow is available for a Site T test after Operations confirms the window. Signed-in production acceptance is separate from the isolated test results.

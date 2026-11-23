# Floating patrol site picker — production closeout, 11/23/2026

Status: both application releases are active and production health is verified. Signed-in Operations screen verification remains pending security-key completion, and live Guard Mode acceptance with Test McTester and two approved test properties remains pending an Operations-owned test window and retirement plan.

## What changed

Operations can approve specific active reporting properties for an exact published guard shift. Sygilant's Patrol Shift Log uses the selected property's linked client, checklist and hit requirements. The change does not grant a guard general access to the Operations site list. Existing fixed-site and native patrol route behavior remains separate.

No property approval, production test shift, real schedule, attendance event, punch, payroll amount, account permission, published report or MG property mapping was changed by this rollout. The approved two test properties were already available; this release did not use them in production.

## Production evidence

- Shared database: both exact migration owners verified after a hosted rollback-only rehearsal, a scoped forward activation, and independent readback. The observed 472-entry manifest preserves all 470 predecessor entries and recorded historical owners. The live release gate compared the tracked baseline, checked 111 function definitions for retry safety and confirmed Auth timestamp compatibility.
- Sygilant Pages: source `2d31d3e93943484124ff96ab120b75d0876101a3`, deployment `7b4d852b-d710-4f53-a18a-de62ba4627de`, verified in production before SygShift promotion.
- SygShift: source `045c05e45207ec7bccac92fa751d17fc5e9ff569`, Worker `b60dc2f7-55ed-4aae-9ae9-aa9d4143e50b`, deployment `c8069625-38aa-4a24-89bb-b45410a5d394`, 100% active. The rollback-safe wrapper completed with no rollback and three upstream probes.
- SygShift public root, sign-in, health and readiness returned HTTP 200; all 12 readiness checks passed. The first natural full scheduled run on the new exact source completed at `2026-11-23T19:27:55.438Z` with zero consecutive failures.
- Public HTML referenced the freshly built `/assets/index-Cbl9LluO.js`. Its bytes and `/assets/PatrolPage-DGcba4WM.js` matched the deploy build (SHA-256 `5ee690f8bf9d5eb690451a78fbe3816c48730ba32f3146a9ec9d3d46d5fb5a72` and `b5f9253df2d6e4fa16f8d6336c4bea4fd77d6844cbd5211ad01d15baa82da0d1`).
- [Exact SygShift GitHub push workflow](https://github.com/Jbro9204/SygShift/actions/runs/45245427725): exact candidate quality and CodeQL passed. Local exact-candidate and deployment gates passed; local application suite recorded 2,662 passes with one existing skip, 369 native patrol lifecycle checks, 11 concurrency checks, and 42 mandatory desktop/mobile Time Clock cases. Production was rebuilt after browser testing.
- Controlled whole-flow rehearsal passed against disposable fixtures: 401 native assertions and 12 desktop/mobile browser scenarios. The two authorized properties resolve to different hit requirements, while unapproved properties, other guards and retired assignments are denied. It did not create production shifts, reports, or punches.
- An authorized signed-in Chrome session displayed the update notice. Read-only navigation to `/patrol/operations` prompted for the registered security key at `/account-security`; the challenge was not completed or bypassed. Workspace access and the rendered Operations controls were not confirmed in that session. No records or permissions were changed.

## Remaining proof and fallback

The documented anonymous release probe was approved and used. Wrangler did not provide a candidate Version URL, so no pre-promotion candidate-URL smoke check is claimed. Production identity, bundles and natural runtime were verified after promotion. Signed-in Guard Mode with an actual test-only assignment remains a distinct acceptance item.

If containment is needed, pause new property approvals and use the documented exact application rollback floor: SygShift Worker `4ef3ddbf-05bf-4191-a418-4d44d7b9fa1f` and Sygilant Pages `26eb69de-1284-4b59-a6aa-4c89db9ce159`. Preserve additive database objects, approval audits and existing reports. Any database correction must be forward-only and reviewed.

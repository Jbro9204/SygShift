# Scheduler Dispatch-overlap acknowledgement — 09/03/2026

## Outcome

- Confirmed the protected **Scheduler** role has active `scheduler.manage`, `schedule.manage`, and `schedule.override_warnings` permissions in production.
- Added a server-authoritative preview when an assignment would create the permitted overlap of one Dispatch phone-duty responsibility and one standard Site/Post shift.
- Added a required, clearly worded acknowledgement showing the existing location, date, and time before the Scheduler can continue.
- The acknowledgement is available to MFA-verified Schedulers and other already-authorized schedule managers; it does not require Admin intervention.

## Safety boundary

- This is not a general conflict override.
- Two physical shifts, two Dispatch duties, Dispatch plus Training, and every other ordinary double-booking remain blocked by the existing database conflict rule.
- Dispatch phone duty still adds no duplicate scheduled minutes, overtime, punch session, or missing-clock alert.
- The server recalculates the overlap immediately before and after assignment creation, preventing a stale browser preview from bypassing acknowledgement.
- Every accepted overlap records the employee, both shifts, location and time context, acknowledging Scheduler, timestamp, and zero payable minutes in the protected audit history.

## Validation

- Full validation passed: TypeScript, zero-warning application lint, **163 test files / 785 tests**, and both production builds.
- Production preview returned the correct current Dispatch and Site/Post overlap context.
- A rollback-only, MFA-authenticated Scheduler test proved the server blocks the same assignment without acknowledgement and accepts it with acknowledgement.
- Public and anonymous execution remain revoked; only authenticated callers can reach the RPC, which independently enforces active employee, MFA, and schedule-management permission checks.
- Pushed implementation commit `c50c179` and deployed Cloudflare Worker version `141259f7-cdf4-45ee-87d6-9f6fb3e7cee4`.
- Primary and fallback health/readiness endpoints returned HTTP 200 and ready; deployed assets contain the acknowledgement UI and versioned server calls.
- Authenticated production QA confirmed the Scheduler workspace loads the current draft and continues to identify Dispatch phone duty separately from ordinary Site/Post shifts.

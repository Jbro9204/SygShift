# Secure Access Incident Recovery

Date: October 19, 2026
Status: Production recovered and verified

## Incident

Production users reached **Checking secure access** and then the fail-closed **Secure access is temporarily unavailable** state. The public Cloudflare Worker, static application, `/api/v1/health`, and `/api/v1/ready` remained healthy, while the SygShift Supabase project's authenticated data plane stopped responding.

Direct checks showed that keyed Auth, generic REST, `get_session_context`, and `get_required_action_checkpoint` requests stalled without response. Storage returned an upstream `544`. Requests rejected at the Supabase gateway without a key still returned immediately, isolating the failure behind the gateway to the project services rather than DNS, the browser, or the Cloudflare application.

## Containment and recovery

- Temporarily removed the production `* * * * *` Worker cron trigger so recovery could proceed without recurring background database requests.
- Restarted Supabase project `eqkdfrbwtioiqtjsyglg` through its production control plane.
- Preserved the current application and database release. No rollback, migration, punch edit, schedule edit, payroll change, identity edit, or data repair was performed.
- Restored the intended `* * * * *` trigger at `2026-10-19T14:24:08.296035Z` after Auth, REST, Storage, and protected-session paths recovered.

## Verified cause boundary

Cloudflare telemetry showed nine contained scheduled failures beginning at `2026-10-19T14:07:16.996Z`. Every failure was the first scheduled database operation, `service_run_timekeeping_automation`, with `status: 504` and `timedOut: true`. The Worker's eight-second RPC deadline opened the per-run circuit immediately, so patrol, document, HR, notification, push, recovery, and other downstream scheduled lanes did not start.

The last cycle before the outage completed the full serialized pipeline without a backlog. This supports a project-wide Supabase/PostgREST availability failure that the cron encountered, not a new concurrent Worker fanout. The SygSphere acknowledgment migration has no Auth, session, required-action, Storage, or cron hook and was not rolled back.

Supabase's unified log collection did not retain a usable pre-restart server exception, so the provider-internal trigger for the project outage remains unknown.

## Post-restart verification

- Supabase Auth health returned `200`; Storage returned `200`; REST and protected RPC controls responded promptly instead of timing out.
- The production database reported 26 of 60 connections, one active query, zero blocked queries, and zero idle-in-transaction sessions after recovery.
- Recent database telemetry showed approximately 5% CPU, 56% memory, and 1% disk I/O, with no current capacity-saturation signal.
- `get_session_context` averaged approximately 15 ms, `get_required_action_checkpoint` approximately 19 ms, and `sygsphere_request` approximately 47 ms in the available query statistics.
- `https://app.sygilant.us/`, `/api/v1/health`, and `/api/v1/ready` returned `200` after recovery.
- An existing signed-in production session passed secure access, rendered the full SygSphere workspace, and showed **Messaging connected**.
- Six restored scheduled cycles from `2026-10-19T14:32:51.007Z` through `2026-10-19T14:37:51Z` completed the full pipeline with `outcome: Ok`; no post-recovery `scheduled_work_contained` event occurred.
- Ingested wall times included 11,169 ms for the first warm cycle, 3,794 ms for a normal empty cycle, and 14,994 ms for the five-minute attendance-refresh cycle. The slower attendance cycle completed normally within the existing 45-second invocation budget.
- Auth remained `200` after the restored cycles, and application health remained `200`.

## Separate observation

The first restored cycle claimed two queued timekeeping emails for one recipient, but the email provider suppressed both because of its bounce/spam suppression list. This did not affect secure access or scheduler completion and requires separate recipient-deliverability review rather than another site restart.

## Preserved records and fallback

All employee, identity, schedule, shift, time-event, adjustment, active-clock, payroll, notification, SygSphere, and audit records were left intact. If the scheduled path regresses, the cron trigger can be removed independently without rolling back application code or database state while the project remains available for signed-in users.

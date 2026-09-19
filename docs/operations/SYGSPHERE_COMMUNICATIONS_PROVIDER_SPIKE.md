# SygSphere Communications Provider Spike

**Stage:** 1 non-production validation
**Contract:** `shared/sygsphere-communications/v1` / `1.0.0-draft.1`
**Current status:** The isolated staging TURN preflight and disposable server-side SFU transport probe are recorded in `SYGSPHERE_COMMUNICATIONS_STAGE_A_STAGING_EVIDENCE.md`. The two-physical-device matrix remains blocked and no browser runtime, camera capture, screen capture, Worker route, or production feature is enabled.

## Safe preflight

The following command is safe by default. It makes no network request and intentionally reports the actual unvalidated checks as `false`.

```powershell
node tools/validate-sygsphere-communications-provider-spike.mjs
```

The staging-only TURN credential check requires all values to come from an approved secret store. Do not save them in `.env`, Git, screenshots, tickets, or this document.

```powershell
$env:COMMS_SPIKE_ENVIRONMENT = 'staging'
$env:COMMS_SPIKE_CONFIRM_NON_PRODUCTION = 'I_UNDERSTAND_THIS_CREATES_STAGING_TURN_CREDENTIALS'
$env:CF_TURN_KEY_ID = '<staging key id from secret store>'
$env:CF_TURN_API_TOKEN = '<staging token from secret store>'
node tools/validate-sygsphere-communications-provider-spike.mjs --execute-turn-credential-check
```

The tool prints only status, count, and HTTP outcome. It never prints credential values, ICE usernames, ICE passwords, account identifiers, provider session identifiers, SDP, employee identifiers, or media payloads.

## Required staging prerequisites

- A dedicated staging SFU application and a separate staging TURN key.
- Least-privilege Worker secret access; no browser-delivered provider secret.
- Two active test employee accounts with deterministic role and scope fixtures.
- Two physical devices on different networks, with one restricted network that requires TCP/TLS TURN.
- A disposable test conversation and operational channel. No production employee, message, incident, or notification recipient may be used.
- A protected evidence destination that stores aggregate timings and pass/fail observations only.

## Manual two-device matrix

Record browser, OS, network class, start/end time, measured timing, and result for every row. Do not claim a pass from a mock or a green client control alone.

| Test | Required proof | Status |
| --- | --- | --- |
| Two-way audio | Device A and B receive distinguishable synthetic test audio | Not run |
| Non-cooperative sender closure | Provider force-closes the sender track; receiver no longer receives media | Not run |
| Non-cooperative receiver closure | Provider removes receiver subscription after revocation | Not run |
| Idle rebuild | Audio works after 60 seconds, five minutes, and 30 minutes idle | Not run |
| Track reuse | Receiver update reuses the expected transceiver where supported; fallback is recorded | Not run |
| TURN UDP/TCP/TLS | UDP preferred and restrictive-network TCP/TLS path both connect or fail honestly | Not run |
| Camera | Explicit camera publish/stop; denial leaves audio usable | Not run |
| Screen share | Desktop publish/stop and mobile viewing; unsupported mobile capture is not offered | Not run |
| Revocation | Session/permission loss closes active publication and subscriptions within the defined recovery policy | Not run |

## Provider and analytics discovery

- Pin the Cloudflare Realtime SFU OpenAPI version used for the spike before coding the provider adapter.
- Record the actual account-supported SFU analytics dataset through GraphQL introspection; do not assume a dataset name or field list.
- TURN reconciliation uses `callsTurnUsageAdaptiveGroups` only after account access proves its available fields and retention.
- Cloudflare analytics is operational reconciliation, not billing authority. Display unavailable data as unavailable rather than zero.

## Release boundary

No production flag is enabled by this work. The future adapter may not be promoted until this matrix has actual evidence, the authorization/tenant tests pass, matching CSP and Permissions-Policy changes are reviewed, and the existing messaging and Dispatch fallback workflows remain verified.

# Stranded notification provider outcome — 10/19–10/20/2026

Status: twenty-nine broadcast recipients have exact provider-delivery correlation; the remaining recipient's target-specific outcome is unproven. Preserve the pending record and its history; do not exhaust it, reopen accepted deliveries or replay the broadcast on this evidence.

The restored native production baseline has exactly one generic `schedule_published` notification at attempt count five with neither delivered nor failed timestamp. Its recipient employee is NULL: it represents a broadcast, not one employee. It was created 10/17/2026 13:57:32.596397 UTC; latest claim 15:14:03.903508 UTC; next availability 15:34:03.903809 UTC. Its last error is NULL. Queue identity SHA-256 is `a98a7480565ac6be35b51b156e9811030b19e8d4d1179cdcca7569d82c486d27`.

The related schedule/message-type email audit contains thirty distinct historical recipients: twenty-nine sent entries and one failed entry, all from the earlier 13:57:53–13:57:55 UTC burst. None contains a provider reference or retained structured provider code. These entries are aggregate-related evidence, not proof of the fifth attempt. No address, employee identifier, message body or raw failure text is included here.

Connected Cloudflare read-only API access verified the correct account, the `sygshift` script and its `sygilant.us` zone. A bounded exact queue-ID Worker observability search from 10/17/2026 13:52–15:40 UTC returned zero correlated events. A narrower email-related query returned four events without exact queue correlation or provider-message reference. These absences are not proof that nothing was sent.

The documented Email Sending individual-event GraphQL query succeeded for 15:12–15:17 UTC: thirty events, twenty-nine `delivered` and one `rejected` with structured `errorCause=suppressed`, spanning 15:14:05–15:14:57 UTC. Provider message IDs for delivered events were SHA-256 hashed before returning evidence; no raw message IDs, recipients, subjects or contents were returned by that query. This establishes actual provider outcomes in the time window, but not yet their exact association with the stranded queue record.

The restored queue has one generic claim and zero support/employee email claims in that same window, and one schedule-publication row for the target schedule. A final read-only query was prepared to compare the provider's sender and recipient-set hashes with the thirty aggregate-related audit recipients. Cloudflare rejected it with **GraphQL rate limiter budget depleted**, requesting a retry after five minutes. Sender equality and recipient-set equality therefore remain unverified. Timing, count and uniqueness evidence must not substitute for that missing correlation.

At approximately 00:35:54 UTC on 10/20/2026, after a conservative five-minute wait with no provider polling, the one authorized narrow correlation retry succeeded with HTTP 200. It returned these exact comparisons:

| Check | Result |
| --- | --- |
| Complete provider recipient set equals the historical audit recipient set | False |
| Every provider recipient is in the expected set | False |
| Every provider sender equals the configured SygShift sender | False |
| No duplicate recipient events in the window | True |
| Unique provider message ID for each delivered event | True |
| Bounded result below the 100-event limit | True |

Outcomes remained twenty-nine delivered and one rejected/suppressed, with zero other outcomes. Address comparisons used only trim/lower normalization before hashing. A provider address representation difference or an unrelated sending burst could explain failed matches; neither is assumed. These results do not prove the exact queue attempt's outcome. No additional provider query or persistent classification was performed.

The parent authorized bounded representation diagnostics after that result. The final diagnostic separated delivered and rejected records and established the exact cause of the failed all-event comparisons:

| Final representation/correlation evidence | Result |
| --- | --- |
| Delivered event count | 29, from 15:14:05 through 15:14:57 UTC on 10/17/2026. |
| Delivered sender representation | All 29 are RFC display mailboxes; extracting only the enclosed mailbox gives 29 exact configured-SygShift-sender matches. They are not MD5/SHA hashes or marked-redacted values. |
| Delivered recipient representation | All 29 are bare mailboxes, giving 29 exact expected-recipient digest matches and 29 distinct recipients. |
| Provider message identity | 29 unique message IDs for the 29 deliveries; only SHA-256 identifiers were retained. |
| Rejected event | One `rejected` / structured `errorCause=suppressed` event at 15:14:50 UTC. Its sender and recipient are both empty strings, and it has no message ID. |
| Remaining expected recipient | Exactly one expected recipient is absent from the delivered set. It is also the sole historical failed recipient, but there is no provider recipient/request identity establishing that the blank rejected event belongs to it. |

The full-set sender comparison failed partly because delivered sender fields use display syntax; the remaining full-set mismatch is the blank rejected-event identity. It is not evidence that the twenty-nine delivered events are an unrelated burst. Combined with the sole claim in that window, configured sender and complete delivered-recipient subset, this establishes actual delivery evidence for those twenty-nine target recipients. It does **not** establish the thirtieth target's outcome or make a full broadcast replay safe.

The final diagnostic was the last provider request. The exact unavailable correlation is the rejected event's sender/recipient or a provider request/message reference binding it to the remaining target. Preserve the pending row while that target-specific attribution remains unproven; do not infer identity by elimination, lease age, free-text error, count/time coincidence or suppression-list membership. Any persistent recovery needs a separate exact guarded change and duplicate-protection review that preserves the twenty-nine confirmed deliveries.

The deployed Worker awaits the Email Sending binding but discards its returned message ID and sends NULL `target_provider_reference` to its audit RPC. This explains why the database alone lacks a direct provider identifier. A future reviewed observability improvement may retain that reference, but it cannot reconstruct this historic attempt and was not implemented during this investigation.

Evidence is retained in ignored `tmp/overnight-2026-10-19/stranded-provider-investigation-summary.json`, `stranded-provider-local.{sql,json}`, `stranded-provider-recipient-local.{sql,json}`, `stranded-provider-pending-query.json`, `stranded-provider-pending-execution.js`, `stranded-provider-correlation-result.json` and the `stranded-provider-{representation,final-representation}-{execution.js,result.json}` files. The first summary retains the initial rate-limited observation; later results preserve both failed raw comparisons and the final exact representation proof. Local queries used the guarded loopback restored fixture with read-only transactions, eight-second statement and 250 ms lock limits. No production database CLI/native authentication, production DDL/DML, send, replay, provider mutation, backup change or automation-memory update occurred.

Primary provider reference: [Email Service metrics and GraphQL individual events](https://developers.cloudflare.com/email-service/observability/metrics-analytics/). The REST message-detail endpoint requires a provider message ID; none is retained for this queue attempt.

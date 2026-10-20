# Client and licensing record preservation

At 23:59:23 UTC on October 19, 2026, all twelve requested stable core tables matched the restored native production baseline by row count and complete-row multiset SHA-256. Each full row was serialized with UTC and ISO YMD settings, SHA-256 hashed, sorted by its row hash, concatenated with a delimiter, then SHA-256 hashed again. Only table names, counts and aggregate digests were returned; no record values were exported.

| Table in public | Matching count |
| --- | ---: |
| clients | 227 |
| client_contacts | 141 |
| client_documents | 265 |
| client_service_records | 5 |
| sygilant_client_document_versions | 259 |
| sygilant_client_document_metadata | 259 |
| licensing_credential_versions | 0 |
| licensing_submissions | 0 |
| licensing_submission_events | 0 |
| sygilant_client_document_acknowledgements | 0 |
| sygilant_client_contracts | 0 |
| sygilant_client_contract_versions | 0 |

All twelve complete-row digests match, including empty-table states. No difference needed live-activity reconciliation, and no data was frozen or repaired. Native local and hosted targets each used one explicit read-only aggregate statement under an eight-second overall statement ceiling and 250ms lock ceiling, followed by rollback. The local target additionally required exact loopback host, port and restored database guards. Each selected-table check is bounded; no whole-database scan was run.

Evidence: `tmp/overnight-2026-10-19/client-licensing-integrity-comparison.json`, with local/hosted JSON, SQL and generator beside it. These results supplement the separately verified thirteen workforce/payroll preservation tables; they do not assert that every unrelated database table was fingerprinted.

Closing verification on 10/20/2026 at approximately 00:37:51 UTC repeated these twelve selected-table comparisons after the final index repair. Every original count and complete-row SHA-256 still matches the restored baseline. The closing receipt is protected `backups/overnight-2026-10-19/closing-integrity-review.json`; all 13 workforce/payroll relations separately matched the fresh pre-index snapshot containing the legitimate clock-out. This does not enlarge the scope to every database table.

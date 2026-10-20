# Served production caller trace

Static, unauthenticated HTML/JavaScript inspection on October 19–20, 2026. No sign-in, provider, RPC, or mutation was performed. JavaScript bodies remained in memory; retained evidence contains URLs, hashes, sizes, MIME/status metadata and aggregate literal counts, not a minified dump.

| Production origin | JavaScript responses scanned | Obsolete identifiers | Private permission helper |
| --- | ---: | ---: | ---: |
| `https://app.sygilant.us` | 146, including theme initialization, push worker and PDF worker | 0 | 0 |
| `https://sygilant.us` | 88 | 0 | 0 |
| `https://f205e571.guardline.pages.dev` | 88 | 0 | 0 |

The exact obsolete literal searches were `sygilant_permissions`, `sygilant_report_packages`, and `client_documents.provenance`. All three origins also had zero `client_documents` literals, zero `employee_effective_permissions` literals, and no associated client-documents/provenance select chain. The canonical immutable Pages origin comes from captured provider deployment `f205e571-404d-4c46-b2bd-2bb252ec2465`, project guardline; it was not inferred from the repository name. All 88 Sygilant JavaScript path/hash pairs match across its custom and immutable origins. Their HTML shells differ, so whole-page HTML hashes are recorded separately.

Each origin contains one `get_session_context` literal. Syntax-tree inspection, without executing the code, identifies these supported calls:

- SygShift: direct `rpc` argument zero in `https://app.sygilant.us/assets/index-d-Ok8A9q.js`; asset SHA-256 `9354c37cd64c3fb3515aa63cda241fac80b23f8801ff162acbad664a17aaa4ae`.
- Sygilant custom/immutable: argument zero to its minified first-party RPC wrapper in `assets/sygsphere-C2qVV-mR.js`; SHA-256 `c490d8508b21184bc1fab8af2233c6c52bc28aacfdb82f8be08ae0a70cf2f39f` on both origins. The deployed source maps this to `sphereSessionEmployeeId` → `sphereRpc('get_session_context')` → authenticated `/api/sygsphere/rpc/get_session_context` proxy. No private permission helper call was found.

Recorded deployed commits exist locally and were searched independently: SygShift `54d021cd85e137739d5db33c9cf7418b613bf4d0`, Sygilant `0ef8694443fca4fe1e60e3ff1b020161f56e9758`. Runtime source under src/worker/functions has zero obsolete-identifier or private permission-helper hits after separating tests. `get_session_context` appears in three SygShift runtime files and six Sygilant runtime files, consistent with existing auth, delegated identity and first-party proxy support. Source hashes and caller line references are in the evidence. Generic provenance labels refer to retained source-record UI or supported template `provenance_source`, not the absent client document column.

Limitations: this inspects current literal asset references and the recorded deployed source; it cannot attribute an old cached browser, external integration, arbitrary generated identifier, or the original historical request. Two additional unversioned PDF-library filenames discovered by the broad string crawl (`/assets/pdf.worker.mjs`, `/assets/qcms_bg.js` on SygShift) returned HTTP 200 text/html rather than JavaScript. Their response hashes are retained; they supply no module body to scan and are not treated as a complete closed module graph. The actual served versioned PDF worker was scanned. These findings do not justify fabricating a compatibility table, widening grants, deploying an unrelated caller change, or claiming the original error source has been resolved.

Private sanitized evidence: `tmp/overnight-2026-10-19/served-schema-call-audit-result.json`, `served-permission-callsite-audit-result.json`, and `deployed-source-schema-call-audit-result.json`; reproducible scripts are adjacent.

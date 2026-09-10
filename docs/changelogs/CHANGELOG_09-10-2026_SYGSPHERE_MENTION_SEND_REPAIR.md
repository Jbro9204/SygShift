# SygSphere Mention Send Repair

**Date:** 09/10/2026  
**Status:** Released and verified in production

## Incident and user impact

Sending a SygSphere message containing a human-name mention such as `@Michelle` could fail with `invalid regular expression: quantifier operand invalid`. The draft remained available for retry, but the message was not sent. This was an incomplete release of the human-name mention feature and blocked a core messaging workflow.

## Root cause

Migration `20260910163434_sygsphere_human_name_mentions.sql` escaped an employee mention label by running a dynamically constructed PostgreSQL regular expression. The escaping expression itself was invalid in PostgreSQL, so the database rejected the send request before inserting the message. The browser then displayed the raw database diagnostic instead of a safe, useful recovery message.

## Repair

- Replaced dynamic regular-expression construction with a literal, case-insensitive token scanner using `strpos` and explicit left/right-boundary checks.
- Preserved real employee UUIDs as the authoritative mention identity and kept the private matcher unavailable to `public`, `anon`, and `authenticated` clients.
- Covered simple names, full names, apostrophes, spaces, regex punctuation, ordinary sentence punctuation, case differences, email-like text, and false prefix matches.
- Aligned browser-side mention detection and rendering with the same boundary rules, including `@Michelle.` at the end of a sentence.
- Prevented raw SQL/function diagnostics from appearing in the composer. A failed send now reports that the message was not sent, confirms the draft is safe, and offers retry.
- Corrected the SygSphere text-size browser fixture so live refresh persists the selected size exactly as production does; the formerly intermittent check then passed 20 consecutive desktop runs.
- Hardened the production send-path regression to use a completed-MFA identity, avoid ambiguous test variables, and wrap all message/mention work in an explicit transaction that always rolls back.

## Database release safety

- Added and released forward migration `20260912050000_repair_sygsphere_mention_token_matcher.sql` (SHA-256 `97B55DB4F351BB5A63F7AECDB540EEB573C5D857F784AEDA1FE2EA2442D899CD`).
- Built an isolated release workspace from all 215 production migration-ledger entries. The dry run listed exactly the single repair migration before application.
- An initial assertion failure during preflight and the first isolated application rolled back completely; production retained the original function until the corrected migration passed its full assertion block.
- Production now records the repair migration, the invalid dynamic regex is absent, the literal matcher passes, and execute privileges remain denied to browser roles.
- The real `public.sygsphere_request('send', ...)` path passed in production with a completed-MFA employee identity and preserved the selected employee ID and human-readable label. The verification transaction leaves no message or mention behind.
- One temporary verification message created while hardening the older regression was identified by exact message ID, client ID, conversation, body, and creation window. It had no replies, reads, files, reactions, saves, revisions, or uploads; it was removed atomically, and its message and mention absence were verified afterward.

## Verification

- Full application gate: TypeScript passed, lint passed with zero warnings, 234 test files / 1,207 tests passed, and both production builds completed.
- SygSphere and Time Clock browser matrix: 92/92 passed across desktop and mobile.
- Repeated text-size/live-refresh isolation: 20/20 desktop runs passed.
- Post-deployment Time Clock regression matrix: 42/42 passed across desktop and mobile, including early clock-in acknowledgment, clock-in/break/clock-out, ended-shift return, missing metadata, guard/admin/dispatcher/supervisor controls, read-only access, ambiguous-shift selection, and duplicate submission protection.
- Production matcher regression and the transactional production send-path regression passed.
- Health, readiness, and `/sygsphere` returned HTTP 200 on both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev`.
- The deployed main and SygSphere JavaScript assets match the final verified local build byte for byte on both origins.

## Release record

- Source commits: `e17d525`, `da41656`, and `d67aa85`.
- Released source head: `d67aa8577ae7593e3a36f4915648a5d5b33e9e61`.
- Cloudflare Worker version: `c868692b-5d56-4b00-aafc-e22992cd02e0`.
- Rollback tag: `rollback/pre-sygsphere-mention-token-repair-20260910` at `083d07bc67fae697ad9ef863ceac2ead88bc1fd9`.
- Main asset: `/assets/index-DfqQF5jA.js` — SHA-256 `7D2F8854E4A7E69BED17B8EBA65B6E8A8B97D0329C902FA06DAA3D1F9E7FE7B0`.
- SygSphere asset: `/assets/SygSpherePage-DIo-rv-t.js` — SHA-256 `D3AF2C1E8AB8D3BFC54C74D75370AC53F43CE9B05191A6AF214C97C328D1C8F1`.


# SygShift Change Log — 08/30/2026

## HRIS Stage 8: Talent, Learning, Cases, Safety, and Assets

### Delivered

- Added protected foundations for goals, reviews, performance history, development plans, and restricted talent records.
- Added learning categories, training items, assignments, completion evidence, and controlled Licensing Center connections.
- Added restricted Employee Case records with participants, factual notes, follow-up tasks, evidence, and append-only history.
- Added Safety and workers' compensation foundations with separate witnesses, restrictions, return-to-work, medical, and audit boundaries.
- Added asset inventory, issuance, acknowledgment, transfer, return, offboarding reconciliation, and controlled financial review foundations.
- Added compact permission-aware Talent & Learning and Cases, Safety & Assets workspaces using bounded 5/10/20 worklists.

### Security and release controls

- Added 15 exact permissions without assigning any of them to a current role or employee.
- Added independent database and Worker release gates for all five modules; every gate remains disabled.
- Required recent MFA for Employee Cases and Safety at both the Worker and database boundaries.
- Kept private records behind row-level security, browser-role revocation, service-only access, and append-only audit evidence.
- Preserved existing employees, roles, permissions, individual overrides, accounts, time-off requests, schedules, timekeeping, payroll, licensing, documents, and authentication behavior.

### Production state

- Production migration: `20260831120000_hris_stage8_talent_learning_cases_safety_assets_foundation.sql` applied and recorded.
- Cloudflare deployment: implementation commit `8a34f42`, Worker version `6ad77790-b974-4271-b8bb-31bdaaee2e85`.
- Production verification confirmed all five release gates are disabled, all 15 permissions are unassigned, no individual override exists, and all five Stage 8 business workspaces contain zero records.
- Existing active-employee, role-assignment, and individual-override counts were unchanged by the database release.
- Local release validation passed: Stage 8 validator, access inventory, access-preservation verification, type checking, zero-warning linting, 116 test files / 583 tests, Worker build, client production build, and Git whitespace validation.
- Live health and readiness returned `200` on both production domains, the login page returned `200`, and all five unauthenticated Stage 8 workspace probes returned the required `401` response.

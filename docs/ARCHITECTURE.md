# SygShift architecture

## Purpose

SygShift is a workforce-operations application for scheduling, qualifications, events, timekeeping, requests, announcements, and payroll preparation. The source workbook remains an immutable business record during migration. Imported records are accepted only after automated reconciliation reports zero unexplained differences.

## Runtime

- React and TypeScript provide the browser application.
- Cloudflare Workers serves the application and versioned API routes.
- Supabase provides PostgreSQL, authentication, object storage, and managed backups.
- Operational timestamps are stored in UTC. Colorado schedules are displayed in `America/Denver` time.
- The application is API-first so a future company hub can use the same authorization and business services without embedding this interface.

## Trust boundaries

### Browser

The browser may receive a Supabase publishable key. It must never receive a database password, secret key, service-role key, email-provider credential, encryption key, or payroll integration credential. Browser database requests are treated as untrusted and are constrained by PostgreSQL row-level security.

### Cloudflare Worker

The Worker owns same-origin API endpoints, request validation, server-authoritative timestamps, rate limiting, idempotency, and integrations that require secrets. API paths are versioned under `/api/v1`.

### PostgreSQL

PostgreSQL is the final authorization boundary. Roles are Guard, Supervisor, and Admin. Row-level security is enabled on every table exposed through the Data API. Sensitive site instructions, source cells, import evidence, and audit details live in a non-public schema.

## Modules

1. Identity and employee directory
2. Sites, posts, patrol, and dispatch coverage
3. Master schedule and published schedule history
4. Events and qualified open-shift requests
5. Time off and call-off workflow
6. Timeclock, corrections, approval, locking, and payroll exports
7. Announcements and delivery history
8. Audit history and source reconciliation

## Change discipline

- Schema changes are forward-only migrations.
- Material state changes create audit records.
- Punches and source evidence are append-only.
- Published schedules are versioned; historical versions are not overwritten.
- Payroll exports identify their source entries and preserve a checksum.
- Every completed change is reviewed, checked, and committed to Git.

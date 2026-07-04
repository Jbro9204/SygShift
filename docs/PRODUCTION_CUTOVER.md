# Production cutover checklist

This checklist is the controlled path for moving SygShift from local development to a live Cloudflare + Supabase deployment.

Current verified deployment and database status is tracked in [ROLL_OUT_STATUS_20260704.md](ROLL_OUT_STATUS_20260704.md).

## 1. Rotate exposed credentials before launch

Any credential that was copied into chat, email, screenshots, tickets, or shared notes must be treated as exposed.

Rotate these before production launch:

- Supabase personal access token
- Supabase database password
- Supabase service-role key
- Any temporary employee login CSV that was downloaded or shared outside the approved handoff process

After rotation, update only the systems that need each value. Do not place service-role keys in browser code, committed files, static hosting variables, or screenshots.

## 2. Configure Cloudflare server secrets

Set these as Cloudflare Worker secrets or protected deployment variables:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Set these as browser-safe build variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

The service-role key is server-only. It is used by the Worker for admin account provisioning and must never be available to client JavaScript.

## 3. Apply and verify database migrations

Run pending migrations against the production Supabase project, then verify:

- public tables have row-level security enabled
- private tables have row-level security enabled
- `anon` and `authenticated` do not have private schema usage
- active employees with login access have records in `private.employee_accounts`
- at least one active admin account exists

Recommended verification query:

```sql
select
  (select count(*) from public.employees) as employees,
  (select count(*) from public.employees where status = 'active') as active_employees,
  (
    select count(*)
    from public.employees e
    join private.employee_accounts a on a.employee_id = e.id
    where e.status = 'active' and a.disabled_at is null
  ) as active_linked_accounts,
  (
    select count(*)
    from public.employees e
    left join private.employee_accounts a on a.employee_id = e.id
    where e.status = 'active' and a.employee_id is null
  ) as active_without_login,
  (
    select count(*)
    from public.employees e
    join private.employee_accounts a on a.employee_id = e.id
    where e.status = 'active' and e.role = 'admin' and a.disabled_at is null
  ) as active_admin_accounts,
  (select count(*) from pg_tables where schemaname = 'private' and rowsecurity is false) as private_tables_without_rls;
```

Production should show:

- `active_without_login = 0` after employee logins are intentionally provisioned
- `active_admin_accounts >= 1`
- `private_tables_without_rls = 0`

## 4. Deploy and verify Cloudflare

Run:

```powershell
pnpm check
pnpm test:e2e
pnpm deploy
```

After deployment, verify:

- `/api/v1/health` returns `200`
- `/api/v1/ready` returns `200` and reports `ready: true`
- `/login` loads over HTTPS
- `/users` redirects unauthenticated visitors to `/login`
- an admin can sign in, change the temporary password, enroll MFA, and open Users & access
- non-admin users cannot open admin routes or admin API endpoints

## 5. First admin account

The first admin account should:

- use the permanent username `jbrown`
- have role `admin`
- have employment type `salary`
- be active
- have MFA enrolled before any production admin work
- replace any temporary password with a private password that passes Supabase policy

If Supabase rejects a requested password, do not weaken the policy. Use a stronger temporary password and keep forced password change enabled.

## 6. Employee login handoff

Temporary passwords should be distributed through a controlled internal process:

- export the temporary login CSV only when needed
- store it in an approved secure location
- give each employee only their own username and temporary password
- require password change at first sign-in
- delete temporary CSVs after handoff is complete

Do not commit login CSVs, screenshots of passwords, or password lists to the repository.

## 7. Final go/no-go checks

Before launch:

- Source scan shows no committed secrets
- Source scan shows no development-tool authorship traces
- Supabase security advisor has no critical findings
- Current workbook data has been reconciled against the live directory
- Backup and restore process has been tested
- The boss-facing build explanation has been updated for non-technical readers

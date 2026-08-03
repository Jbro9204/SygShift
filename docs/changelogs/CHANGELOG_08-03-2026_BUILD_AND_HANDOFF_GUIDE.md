# SygShift Build and Handoff Guide

Date: 08/03/2026

## Purpose

Added a permanent repository-backed operating standard so SygShift can be maintained consistently from another computer or by another qualified maintainer without relying on conversation history.

## Completed

- Added root-level repository instructions in `AGENTS.md`.
- Added the comprehensive `docs/BUILD_AND_HANDOFF_GUIDE.md` manual.
- Documented the canonical repository, production application, Cloudflare Worker, Supabase project reference, and health/readiness endpoints without storing credentials.
- Added mandatory session preflight, new-workstation setup, source-of-truth order, repository map, architecture boundaries, product rules, implementation discipline, interface standards, permission and MFA rules, testing matrix, database procedure, Git workflow, deployment checks, changelog rules, incident response, definition of done, and end-of-session handoff template.
- Added an explicit warning not to work from the unrelated DayZ workspace.
- Linked the guide from the project README.

## Verification

- Confirmed the repository was clean and synchronized with `origin/main` before editing.
- Reviewed the current README, architecture, security baseline, production cutover checklist, future plan, package scripts, Cloudflare configuration, migration inventory, routes, data modules, and existing regression guard tests before writing the guide.
- Documentation links and referenced paths were checked against the current repository structure.
- `pnpm check` passed: typecheck, lint, 33 test files, 161 tests, and the production build.

## Source control

- Commit: this changelog's containing documentation commit.
- Push: `origin/main`.

## Deployment impact

Documentation only. No application, database, security policy, employee data, or production runtime behavior changed.

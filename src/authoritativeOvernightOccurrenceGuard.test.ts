/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260824224500_authoritative_overnight_occurrence_resolution.sql",
  ),
  "utf8",
);

const maintenanceDisplayMigration = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260824230000_time_maintenance_canonical_occurrence_display.sql",
  ),
  "utf8",
);

describe("authoritative overnight occurrence resolution", () => {
  it("makes the clock-in session own later punches across midnight", () => {
    expect(migration).toContain("session_number");
    expect(migration).toContain("session_clock_in.direct_occurrence_shift_id");
    expect(migration).toContain("when session.clock_in_event_id is not null");
    expect(migration).toContain("event.kind = 'clock_in'");
    expect(migration).toContain("event.resolved_occurrence_shift_id as original_shift_id");
  });

  it("rejects impossible stored links and only repairs unambiguous assignments", () => {
    expect(migration).toContain("event.valid_stored_shift_id is null");
    expect(migration).toContain("having count(distinct candidate.shift_id) = 1");
    expect(migration).toContain("time_event_occurrence_overrides");
    expect(migration).toContain("'system_repair'");
  });

  it("routes time maintenance, payroll, live punches, and team totals through one source", () => {
    expect(migration).toContain("private.get_effective_time_events(actor_employee_id)");
    expect(migration).toContain("private.get_effective_time_events_with_occurrence()");
    expect(migration).toContain("partition by event.employee_id, event.occurrence_key");
    expect(migration).toContain("event.assignment_anchor at time zone operational_time_zone");
  });

  it("preserves immutable source punches", () => {
    expect(migration).not.toContain("update public.time_events");
    expect(migration).not.toContain("delete from public.time_events");
  });

  it("uses the resolved occurrence for the Time Maintenance shift and location", () => {
    expect(maintenanceDisplayMigration).toContain("occurrence.shift_id as shift_id");
    expect(maintenanceDisplayMigration).toContain(
      "left join public.shifts shift on shift.id = occurrence.shift_id",
    );
  });
});

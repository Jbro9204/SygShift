# Database release baseline review

The guarded viewer-system-time release discovered that production had one applied
migration newer than the preserved October 19 overnight baseline. The release
stopped before deployment, as designed.

The replacement format-v2 baseline was captured read-only from the reviewed
production project at `2026-10-21T14:16:06.748Z` and compared with the preserved
baseline. The comparison found exactly one expected delta:

- Applied migration `20261020134522_incident_report_direct_capture` was added.
- Its owning source is the committed Sygilant file
  `20261020134522_incident_report_direct_capture.sql` from Sygilant commit
  `703391094995f3ace0a0486a3e586c4d6057c5e8`.
- The migration has an exact version/name source match and a captured 27-statement
  array.
- No prior applied entry was removed or changed.
- No prior owning source was removed or changed.

The new manifest contains 377 applied migrations, 396 SygShift sources, and 116
Sygilant sources. It has no missing sources and no unresolved ownership decisions.
Its SHA-256 is
`b8d28bd8619091ab564466d63a594eb19f5adaec2c394362727e16906af55f23`.

This evidence does not authorize migration replay, bulk migration push, or any
production database mutation. The prior baseline remains preserved unchanged.

## Final coordinated baseline

While this release was waiting for its independent quality gate, the separately
authorized Sygilant report-correction release installed two additional migrations.
The SygShift release gate stopped before deployment when each ledger change became
visible. After Sygilant stabilized and pushed exact commit
`a6deebba38c365510399711a18e136601ea7413c`, a final read-only baseline was
captured at `2026-10-21T14:47:35.413Z`.

Compared with the earlier 377-entry baseline, the final baseline adds only:

- `20261021135052_safe_report_void_replacement_lifecycle` with its exact
  committed Sygilant source and 80-statement array.
- `20261021144500_tracktik_active_source_reference_repair` with its exact
  committed Sygilant source and 14-statement array.

No prior ledger entry or owning-source checksum changed. The final manifest has
379 applied migrations, 396 SygShift sources, 118 Sygilant sources, no missing
sources, and no unresolved ownership decisions. Its SHA-256 is
`5cd13ad4e619fd017cb3636d200eb2e5d6b1c73c9dd64a61eb090ea6799da2ff`.

select jsonb_build_object(
  'controlStatus', private.hris_stage2_control_status(),
  'releaseStatus', private.hris_stage2_release_status(),
  'proposalSummary', private.hris_stage2_reconciliation_summary(),
  'preservationSnapshot', private.hris_stage2_preservation_snapshot()
) as hris_stage2_release_evidence;

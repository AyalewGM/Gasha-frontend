/**
 * Synthetic-only known-shape fixture for injected-port frontend tests.
 * No production reader constructs or trusts this payload.
 */
export function foundingEvidence(caseId: string, contextRef: string) {
  return {
    case_id: caseId,
    bank_source_attested: false,
    enforcement_activated: false,
    feature_evidence: {
      schema: "gasha-synthetic-case-feature-view-v1",
      scope: "case_creation_source_only",
      availability: "available",
      source_assurance: "synthetic_unattested",
      context_ref: contextRef,
      assessment_version: "synthetic-v1",
      feature_set_version: "features-01",
      decision_as_of: "2026-11-07T10:00:00.000001Z",
      lineage_ref: "d".repeat(64),
      source_fingerprint: "f".repeat(64),
      computation_fingerprint: "e".repeat(64),
      eligible_observations: 7,
      late_observations: 1,
      nonprior_observations: 0,
      unavailable_signals: ["device_ref"],
    },
  };
}

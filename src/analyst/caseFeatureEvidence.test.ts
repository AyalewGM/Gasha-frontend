import { describe, expect, it } from "vitest";
import { parseProtectedCaseFeatureEvidence } from "./caseFeatureEvidence";

const CASE = "00000000-0000-4000-8000-000000000041";
const OTHER = "00000000-0000-4000-8000-000000000051";
const CONTEXT = "c".repeat(64);
const DIGEST = "d".repeat(64);
const FINGERPRINT = "f".repeat(64);

function fixture(availability: "available" | "not_recorded" = "available") {
  return {
    case_id: CASE,
    bank_source_attested: false,
    enforcement_activated: false,
    feature_evidence: {
      schema: "gasha-synthetic-case-feature-view-v1",
      scope: "case_creation_source_only",
      availability,
      source_assurance: availability === "available" ? "synthetic_unattested" : "not_established",
      context_ref: CONTEXT,
      assessment_version: availability === "available" ? "synthetic-v1" : null,
      feature_set_version: availability === "available" ? "features-01" : null,
      decision_as_of: availability === "available" ? "2026-11-21T10:05:12.123456+00:00" : null,
      lineage_ref: availability === "available" ? DIGEST : null,
      source_fingerprint: availability === "available" ? FINGERPRINT : null,
      computation_fingerprint: availability === "available" ? DIGEST : null,
      eligible_observations: availability === "available" ? 7 : null,
      late_observations: availability === "available" ? 1 : null,
      nonprior_observations: availability === "available" ? 2 : null,
      unavailable_signals: availability === "available" ? ["device_ref"] : null,
    },
  };
}

describe("strict creation-source feature-evidence decoder", () => {
  it("accepts available synthetic evidence and projects no case, context, fingerprint or Bank authority", () => {
    const result = parseProtectedCaseFeatureEvidence(fixture(), CASE, CONTEXT);
    expect(result).toEqual({
      availability: "available",
      decisionAsOf: "2026-11-21T10:05:12.123456+00:00",
      eligibleObservations: 7,
      lateObservations: 1,
      nonpriorObservations: 2,
      unavailableSignals: ["device_ref"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/context_ref|fingerprint|lineage|tenant|bank_/);
  });

  it("distinguishes legitimate legacy absence from synthetic zero measurements", () => {
    expect(parseProtectedCaseFeatureEvidence(fixture("not_recorded"), CASE, CONTEXT))
      .toEqual({ availability: "not_recorded" });
    expect(() => parseProtectedCaseFeatureEvidence({
      ...fixture("not_recorded"),
      feature_evidence: { ...fixture("not_recorded").feature_evidence, eligible_observations: 0 },
    }, CASE, CONTEXT)).toThrow("Protected founding-event evidence could not be verified");
  });

  it.each([
    ["wrong case", (e: ReturnType<typeof fixture>) => { e.case_id = OTHER; }],
    ["wrong context", (e: ReturnType<typeof fixture>) => { e.feature_evidence.context_ref = DIGEST; }],
    ["Bank attestation claim", (e: ReturnType<typeof fixture>) => { e.bank_source_attested = true; }],
    ["enforcement claim", (e: ReturnType<typeof fixture>) => { e.enforcement_activated = true; }],
    ["wrong scope", (e: ReturnType<typeof fixture>) => { e.feature_evidence.scope = "all_case_events"; }],
    ["wrong schema", (e: ReturnType<typeof fixture>) => { e.feature_evidence.schema = "unknown"; }],
    ["unknown assurance", (e: ReturnType<typeof fixture>) => { e.feature_evidence.source_assurance = "bank_verified"; }],
    ["malformed version", (e: ReturnType<typeof fixture>) => { e.feature_evidence.assessment_version = "bad/value"; }],
    ["malformed checksum", (e: ReturnType<typeof fixture>) => { e.feature_evidence.lineage_ref = "x"; }],
    ["missing checksum", (e: ReturnType<typeof fixture>) => { e.feature_evidence.source_fingerprint = null; }],
    ["naive cutoff", (e: ReturnType<typeof fixture>) => { e.feature_evidence.decision_as_of = "2026-11-21T10:05:12"; }],
    ["invalid date", (e: ReturnType<typeof fixture>) => { e.feature_evidence.decision_as_of = "2026-02-31T10:05:12Z"; }],
    ["invalid timezone", (e: ReturnType<typeof fixture>) => { e.feature_evidence.decision_as_of = "2026-11-21T10:05:12+25:00"; }],
    ["count coerced to string", (e: ReturnType<typeof fixture>) => { e.feature_evidence.eligible_observations = "7" as never; }],
    ["count negative", (e: ReturnType<typeof fixture>) => { e.feature_evidence.late_observations = -1; }],
    ["count excessive", (e: ReturnType<typeof fixture>) => { e.feature_evidence.nonprior_observations = 1e13; }],
    ["unrecognized signal", (e: ReturnType<typeof fixture>) => { e.feature_evidence.unavailable_signals = ["unknown_signal"]; }],
    ["duplicate signal", (e: ReturnType<typeof fixture>) => { e.feature_evidence.unavailable_signals = ["device_ref", "device_ref"]; }],
    ["unknown top field", (e: ReturnType<typeof fixture>) => { Object.assign(e, { tenant_id: "tenant-b" }); }],
    ["unknown nested field", (e: ReturnType<typeof fixture>) => { Object.assign(e.feature_evidence, { bank_source: "secret" }); }],
    ["missing nested field", (e: ReturnType<typeof fixture>) => { delete (e.feature_evidence as Partial<typeof e.feature_evidence>).decision_as_of; }],
  ])("rejects %s without echoing the invalid payload", (_label, mutate) => {
    const payload = fixture();
    mutate(payload);
    expect(() => parseProtectedCaseFeatureEvidence(payload, CASE, CONTEXT))
      .toThrow("Protected founding-event evidence could not be verified");
  });

  it("rejects null and non-object envelopes, mismatched expected identities, coerced booleans", () => {
    for (const value of [null, [], {}, "sensitive", 42]) {
      expect(() => parseProtectedCaseFeatureEvidence(value, CASE, CONTEXT)).toThrow();
    }
    expect(() => parseProtectedCaseFeatureEvidence(fixture(), OTHER, CONTEXT)).toThrow();
    expect(() => parseProtectedCaseFeatureEvidence(fixture(), CASE, "invalid")).toThrow();
    expect(() => parseProtectedCaseFeatureEvidence({
      ...fixture(), bank_source_attested: "false",
    }, CASE, CONTEXT)).toThrow();
  });
});

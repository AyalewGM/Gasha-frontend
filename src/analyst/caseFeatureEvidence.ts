/**
 * Synthetic founding-event feature evidence from the opt-in, audited #45 GET.
 *
 * This decoder does not authorize a read or attest a Bank source. All
 * provenance checksums are validated and discarded rather than projected
 * into the analyst UI. Never use untrusted response fields as tenant authority.
 */
import { isCaseIdentifier } from "./protectedCasePath";

const DIGEST = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,96}$/;
const MISSING = new Set([
  "beneficiary_ref",
  "device_ref",
  "sender_beneficiary_history_coverage",
  "beneficiary_unique_senders_1h",
]);
const ENVELOPE = ["case_id", "feature_evidence", "bank_source_attested", "enforcement_activated"];
const FIELDS = [
  "schema", "scope", "availability", "source_assurance", "context_ref",
  "assessment_version", "feature_set_version", "decision_as_of",
  "lineage_ref", "source_fingerprint", "computation_fingerprint",
  "eligible_observations", "late_observations", "nonprior_observations",
  "unavailable_signals",
];
const OPTIONAL = FIELDS.slice(5);

export type FoundingFeatureEvidence =
  | Readonly<{ availability: "not_recorded" }>
  | Readonly<{
      availability: "available";
      decisionAsOf: string;
      eligibleObservations: number;
      lateObservations: number;
      nonpriorObservations: number;
      unavailableSignals: readonly string[];
    }>;

function invalid(): never {
  // No backend body, internal context identifier or sensitive exception in UX.
  throw new Error("Protected founding-event evidence could not be verified");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

function cutoff(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 48) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const h = Number(hour), min = Number(minute), s = Number(second);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
      h > 23 || min > 59 || s > 59) return false;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 ||
      Number(zone.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 1_000_000_000_000;
}

/**
 * Accept only the exact synthetic, creation-source schema and a history-linked
 * case/context pair. Reject false "available" zeroes in legacy not-recorded
 * evidence and never retain raw fingerprints, context refs or case IDs.
 */
export function parseProtectedCaseFeatureEvidence(
  payload: unknown,
  expectedCaseId: string,
  expectedContextRef: string,
): FoundingFeatureEvidence {
  if (!isCaseIdentifier(expectedCaseId) || !DIGEST.test(expectedContextRef)) invalid();
  const envelope = record(payload);
  exactKeys(envelope, ENVELOPE);
  if (envelope.case_id !== expectedCaseId ||
      envelope.bank_source_attested !== false ||
      envelope.enforcement_activated !== false) invalid();

  const view = record(envelope.feature_evidence);
  exactKeys(view, FIELDS);
  if (view.schema !== "gasha-synthetic-case-feature-view-v1" ||
      view.scope !== "case_creation_source_only" ||
      view.context_ref !== expectedContextRef ||
      typeof view.context_ref !== "string" ||
      !DIGEST.test(view.context_ref)) invalid();

  if (view.availability === "not_recorded") {
    if (view.source_assurance !== "not_established" ||
        OPTIONAL.some((field) => view[field] !== null)) invalid();
    return Object.freeze({ availability: "not_recorded" as const });
  }
  if (view.availability !== "available" ||
      view.source_assurance !== "synthetic_unattested" ||
      typeof view.assessment_version !== "string" ||
      !VERSION.test(view.assessment_version) ||
      typeof view.feature_set_version !== "string" ||
      !VERSION.test(view.feature_set_version) ||
      !cutoff(view.decision_as_of) ||
      typeof view.lineage_ref !== "string" ||
      !DIGEST.test(view.lineage_ref) ||
      typeof view.source_fingerprint !== "string" ||
      !DIGEST.test(view.source_fingerprint) ||
      typeof view.computation_fingerprint !== "string" ||
      !DIGEST.test(view.computation_fingerprint) ||
      !count(view.eligible_observations) ||
      !count(view.late_observations) ||
      !count(view.nonprior_observations) ||
      !Array.isArray(view.unavailable_signals) ||
      view.unavailable_signals.length > MISSING.size ||
      view.unavailable_signals.some((code: unknown) =>
        typeof code !== "string" || !MISSING.has(code)) ||
      new Set(view.unavailable_signals).size !== view.unavailable_signals.length) invalid();

  return Object.freeze({
    availability: "available" as const,
    decisionAsOf: view.decision_as_of,
    eligibleObservations: view.eligible_observations,
    lateObservations: view.late_observations,
    nonpriorObservations: view.nonprior_observations,
    unavailableSignals: Object.freeze([...view.unavailable_signals]),
  });
}

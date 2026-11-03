/**
 * Inert, display-only projection for backend #45's protected case-history GET.
 * This decoder does NOT authenticate the response, grant case.read, or make a
 * network request. Only a future independently reviewed authenticated client
 * may supply the response to this projection.
 */
export type CaseOperation = "create" | "triage" | "assign" | "dispose" | "correct" | "reconcile";
export type CaseDisposition = "confirmed_fraud" | "confirmed_legitimate" | "unresolved";

export interface CaseHistoryEvent {
  readonly revision: number;
  readonly previous_revision: number | null;
  readonly operation: CaseOperation;
  readonly recorded_at: string;
  readonly reason_code: string;
  readonly disposition: CaseDisposition | null;
  readonly actor_ref: string;
  readonly assignee_ref: string | null;
  readonly source_event_id: string;
  readonly source_context_ref: string;
  readonly bank_execution: "unknown";
}

export interface CaseHistoryProjection {
  readonly case_id: string;
  readonly enforcement_activated: false;
  readonly events: readonly CaseHistoryEvent[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const AWARE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d+))?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/;
const OPERATIONS: ReadonlySet<string> = new Set(["create", "triage", "assign", "dispose", "correct", "reconcile"]);
const DISPOSITIONS: ReadonlySet<string> = new Set(["confirmed_fraud", "confirmed_legitimate", "unresolved"]);
const REASONS: Record<CaseOperation, ReadonlySet<string>> = {
  create: new Set(["source_evaluation"]),
  triage: new Set(["analyst_triage"]),
  assign: new Set(["investigation_assigned"]),
  dispose: new Set(["fraud_evidence", "legitimate_evidence", "needs_review"]),
  correct: new Set(["corrected_finding"]),
  reconcile: new Set(["feedback_reconciled"]),
};
const PREVIOUS: Record<CaseOperation, ReadonlySet<CaseOperation | null>> = {
  create: new Set<CaseOperation | null>([null]),
  triage: new Set<CaseOperation | null>(["create"]),
  assign: new Set<CaseOperation | null>(["triage"]),
  dispose: new Set<CaseOperation | null>(["assign"]),
  correct: new Set<CaseOperation | null>(["dispose", "correct"]),
  reconcile: new Set<CaseOperation | null>(["dispose", "correct"]),
};
const DISPOSITION_REASON: Record<CaseDisposition, string> = {
  confirmed_fraud: "fraud_evidence",
  confirmed_legitimate: "legitimate_evidence",
  unresolved: "needs_review",
};
const TOP_KEYS = ["case_id", "enforcement_activated", "events"] as const;
const EVENT_KEYS = [
  "revision", "previous_revision", "operation", "recorded_at",
  "reason_code", "disposition", "actor_ref", "assignee_ref",
  "source_event_id", "source_context_ref", "bank_execution",
] as const;

function invalid(): never {
  // No untrusted response body, identifier, or server diagnostic in UI errors.
  throw new Error("Invalid protected case-history projection");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = AWARE_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    Number.isFinite(Date.parse(value));
}

/**
 * JavaScript Date.parse truncates fractional seconds to milliseconds; backend
 * case history records microseconds. Preserve that precision when comparing
 * absolute UTC event order (including events with different offsets).
 */
function instantMicroseconds(value: string): bigint {
  const fraction = AWARE_TIMESTAMP.exec(value)?.[4] ?? "";
  const remainder = fraction.slice(0, 6).padEnd(6, "0").slice(3);
  return BigInt(Date.parse(value)) * 1000n + BigInt(remainder || "0");
}

/**
 * Strictly validate backend case-history response v0.1.
 * A browser cannot infer tenant authorization from this payload: the backend
 * must authenticate every read and recheck tenant and capability.
 */
export function parseProtectedCaseHistory(value: unknown, expectedCaseId: string): CaseHistoryProjection {
  if (
    !record(value) || !exactKeys(value, TOP_KEYS) ||
    typeof expectedCaseId !== "string" || !UUID.test(expectedCaseId) ||
    value.case_id !== expectedCaseId || value.enforcement_activated !== false ||
    !Array.isArray(value.events) || value.events.length === 0 || value.events.length > 500
  ) invalid();

  let previousOperation: CaseOperation | null = null;
  let previousAt: bigint | null = null;
  let sourceEvent: string | null = null;
  let sourceContext: string | null = null;
  let lastDisposition: CaseDisposition | null = null;
  const events: CaseHistoryEvent[] = value.events.map((raw: unknown, index: number) => {
    if (!record(raw) || !exactKeys(raw, EVENT_KEYS)) invalid();
    const operationValue = raw.operation;
    if (typeof operationValue !== "string" || !OPERATIONS.has(operationValue)) invalid();
    const operation = operationValue as CaseOperation;
    const dispositionValue = raw.disposition;
    if (
      typeof raw.revision !== "number" || !Number.isInteger(raw.revision) ||
      raw.revision !== index + 1 ||
      raw.previous_revision !== (index === 0 ? null : index) ||
      typeof raw.reason_code !== "string" || !REASONS[operation].has(raw.reason_code) ||
      !validInstant(raw.recorded_at) ||
      typeof raw.actor_ref !== "string" || !HASH.test(raw.actor_ref) ||
      (raw.assignee_ref !== null &&
        (typeof raw.assignee_ref !== "string" || !HASH.test(raw.assignee_ref))) ||
      typeof raw.source_event_id !== "string" || !UUID.test(raw.source_event_id) ||
      typeof raw.source_context_ref !== "string" || !HASH.test(raw.source_context_ref) ||
      raw.bank_execution !== "unknown" ||
      (dispositionValue !== null &&
        (typeof dispositionValue !== "string" || !DISPOSITIONS.has(dispositionValue))) ||
      !PREVIOUS[operation].has(previousOperation) ||
      (operation === "assign") !== (raw.assignee_ref !== null)
    ) invalid();

    const at = instantMicroseconds(raw.recorded_at as string);
    if (previousAt !== null && at < previousAt) invalid();
    if (sourceEvent === null) {
      sourceEvent = raw.source_event_id as string;
      sourceContext = raw.source_context_ref as string;
    } else if (raw.source_event_id !== sourceEvent || raw.source_context_ref !== sourceContext) invalid();

    const disposition = dispositionValue as CaseDisposition | null;
    if (operation === "dispose") {
      if (disposition === null || raw.reason_code !== DISPOSITION_REASON[disposition]) invalid();
    } else if (operation === "correct") {
      if (disposition === null || disposition === lastDisposition) invalid();
    } else if (disposition !== null) invalid();

    if (disposition !== null) lastDisposition = disposition;
    previousAt = at;
    previousOperation = operation;
    // Copy only validated, documented, pseudonymous fields into the view.
    return Object.freeze({
      revision: raw.revision as number,
      previous_revision: raw.previous_revision as number | null,
      operation,
      recorded_at: raw.recorded_at as string,
      reason_code: raw.reason_code as string,
      disposition,
      actor_ref: raw.actor_ref as string,
      assignee_ref: raw.assignee_ref as string | null,
      source_event_id: raw.source_event_id as string,
      source_context_ref: raw.source_context_ref as string,
      bank_execution: "unknown" as const,
    });
  });

  return Object.freeze({
    case_id: expectedCaseId,
    enforcement_activated: false as const,
    events: Object.freeze(events),
  });
}

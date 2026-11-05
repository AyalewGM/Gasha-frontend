/**
 * Issue #45: inert decoder for the server-projected ranked case queue.
 *
 * Not an HTTP client or an identity/tenant authority. The backend's protected
 * endpoint is default-unwired; only a separately accepted server-controlled
 * reader, verifier, audit and same-origin session/ingress may supply data.
 * The synthetic UC-01/02/03 App must never import this module.
 */
export type CaseQueueStatus = "create" | "triage" | "assign";
export type CaseQueueScenario =
  | "APP-01" | "APP-02" | "APP-05"
  | "ATO-02" | "ATO-06"
  | "MM-01" | "MM-02" | "MM-05";

export interface CaseQueueItem {
  readonly rank: number;
  readonly case_id: string;
  readonly source_event_id: string;
  readonly source_context_ref: string;
  readonly scenario_ids: readonly CaseQueueScenario[];
  readonly status: CaseQueueStatus;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly assignee_ref: string | null;
  readonly bank_execution: "unknown";
}

export interface CaseQueueProjection {
  readonly tenant_scope: "authenticated_reader";
  readonly ranking_policy_version: string;
  readonly generated_at: string;
  readonly items: readonly CaseQueueItem[];
  readonly bank_ranking_approved: false;
  readonly enforcement_activated: false;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const AWARE = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,6}))?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/;
const TOP_KEYS = [
  "tenant_scope", "ranking_policy_version", "generated_at", "items",
  "bank_ranking_approved", "enforcement_activated",
] as const;
const ITEM_KEYS = [
  "rank", "case_id", "source_event_id", "source_context_ref",
  "scenario_ids", "status", "revision", "created_at", "updated_at",
  "assignee_ref", "bank_execution",
] as const;
const SCENARIOS: ReadonlySet<string> = new Set([
  "APP-01", "APP-02", "APP-05", "ATO-02", "ATO-06",
  "MM-01", "MM-02", "MM-05",
]);
const STATUS_REVISIONS: Readonly<Record<CaseQueueStatus, number>> = {
  create: 1, triage: 2, assign: 3,
};

function invalid(): never {
  // Never reflect raw server errors, customer fields or identifiers to the UI.
  throw new Error("Invalid protected case-queue projection");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = AWARE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31];
  return year >= 1 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    Number.isFinite(Date.parse(value));
}

/** Compare complete microsecond instants, including offset and DST-fold cases. */
function micros(value: string): bigint {
  const fraction = AWARE.exec(value)?.[4] ?? "";
  const remainder = fraction.padEnd(6, "0").slice(3);
  return BigInt(Date.parse(value)) * 1000n + BigInt(remainder || "0");
}

/**
 * Validate the entire untrusted response, never displaying a partial queue.
 * expectedLimit is only a request-bound size check, NOT a capability/tenant
 * assertion. The response has no tenant ID; tenant and principal linkage must
 * be checked by the installed backend reader on every request.
 */
export function parseProtectedCaseQueue(value: unknown, expectedLimit: number): CaseQueueProjection {
  if (
    !Number.isInteger(expectedLimit) || expectedLimit < 1 || expectedLimit > 100 ||
    !record(value) || !exactKeys(value, TOP_KEYS) ||
    value.tenant_scope !== "authenticated_reader" ||
    typeof value.ranking_policy_version !== "string" ||
    !VERSION.test(value.ranking_policy_version) ||
    !validInstant(value.generated_at) ||
    value.bank_ranking_approved !== false ||
    value.enforcement_activated !== false ||
    !Array.isArray(value.items) || value.items.length > expectedLimit
  ) invalid();

  const generatedAt = micros(value.generated_at as string);
  const caseIds = new Set<string>();
  const sourceIds = new Set<string>();
  const items: CaseQueueItem[] = value.items.map((raw: unknown, index: number) => {
    if (!record(raw) || !exactKeys(raw, ITEM_KEYS)) invalid();
    const status = raw.status;
    if (typeof status !== "string" || !Object.prototype.hasOwnProperty.call(STATUS_REVISIONS, status)) invalid();
    const typedStatus = status as CaseQueueStatus;
    const scenarios = raw.scenario_ids;
    if (
      typeof raw.rank !== "number" || raw.rank !== index + 1 ||
      typeof raw.case_id !== "string" || !UUID.test(raw.case_id) ||
      typeof raw.source_event_id !== "string" || !UUID.test(raw.source_event_id) ||
      typeof raw.source_context_ref !== "string" || !DIGEST.test(raw.source_context_ref) ||
      !Array.isArray(scenarios) || scenarios.length === 0 ||
      !scenarios.every((scenario: unknown) => typeof scenario === "string" && SCENARIOS.has(scenario)) ||
      scenarios.join(",") !== [...new Set<string>(scenarios as string[])].sort().join(",") ||
      typeof raw.revision !== "number" || raw.revision !== STATUS_REVISIONS[typedStatus] ||
      !validInstant(raw.created_at) || !validInstant(raw.updated_at) ||
      (raw.assignee_ref !== null &&
        (typeof raw.assignee_ref !== "string" || !DIGEST.test(raw.assignee_ref))) ||
      (typedStatus === "assign") !== (raw.assignee_ref !== null) ||
      raw.bank_execution !== "unknown" ||
      caseIds.has(raw.case_id) || sourceIds.has(raw.source_event_id)
    ) invalid();

    if (micros(raw.created_at as string) > micros(raw.updated_at as string) ||
        micros(raw.updated_at as string) > generatedAt) invalid();

    caseIds.add(raw.case_id as string);
    sourceIds.add(raw.source_event_id as string);
    // Detached frozen projection: later mutation of a response cannot alter UI.
    return Object.freeze({
      rank: index + 1,
      case_id: raw.case_id as string,
      source_event_id: raw.source_event_id as string,
      source_context_ref: raw.source_context_ref as string,
      scenario_ids: Object.freeze([...(scenarios as CaseQueueScenario[])]),
      status: typedStatus,
      revision: raw.revision as number,
      created_at: raw.created_at as string,
      updated_at: raw.updated_at as string,
      assignee_ref: raw.assignee_ref as string | null,
      bank_execution: "unknown" as const,
    });
  });

  return Object.freeze({
    tenant_scope: "authenticated_reader" as const,
    ranking_policy_version: value.ranking_policy_version as string,
    generated_at: value.generated_at as string,
    items: Object.freeze(items),
    bank_ranking_approved: false as const,
    enforcement_activated: false as const,
  });
}

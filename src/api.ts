export type BeneficiaryType =
  | "internal"
  | "external"
  | "merchant"
  | "wallet"
  | "unknown";

export type DecisionAction =
  | "allow"
  | "monitor"
  | "challenge"
  | "review"
  | "hold"
  | "block"
  | "no_action_shadow";

export interface CanonicalTransaction {
  tenant_id: string;
  event_id: string;
  occurred_at: string;
  channel: string;
  transaction_type: string;
  amount: string;
  currency: string;
  sender_customer_id: string;
  sender_account_id: string;
  beneficiary_id: string;
  beneficiary_type: BeneficiaryType;
  destination_institution_id?: string | null;
  device_id?: string | null;
  correlation_id: string;
}

export interface DecisionPolicy {
  configuration_version: string;
  policy_version: string;
  rule_version: string;
  model_version?: string | null;
  monitor_threshold: number;
  review_threshold: number;
  hold_threshold: number;
  block_threshold: number;
}

export interface DecisionRequest {
  transaction: CanonicalTransaction;
  policy: DecisionPolicy;
  customer_risk: number;
  transaction_risk: number;
  velocity_risk: number;
  device_session_risk: number;
  beneficiary_risk: number;
  relationship_risk: number;
  network_risk: number;
  journey_risk: number;
}

export interface FraudDecision {
  tenant_id: string;
  event_id: string;
  action: DecisionAction;
  risk_score: number;
  reason_codes: string[];
  configuration_version: string;
  policy_version: string;
  rule_version: string;
  model_version?: string | null;
  decided_at: string;
  correlation_id: string;
}

import { apiBasePath } from "./apiRouting";

// Reject timezone-naive timestamps: the 01:00 hour repeats during DST fall-back.
// The synthetic recommendation must carry an unambiguous absolute instant.
const AWARE_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/;

const SYNTHETIC_DECISION_ACTIONS: ReadonlySet<string> = new Set([
  "allow", "monitor", "challenge", "review", "hold", "block", "no_action_shadow",
]);

/** Validate the untrusted HTTP payload before it can drive a recommendation UI.
 * This does not confer bank-side authenticity, tenant authorization or action.
 */
function parseSyntheticDecision(value: unknown): FraudDecision {
  const invalid = () => new Error("Invalid synthetic decision response");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid();
  }
  const record = value as Record<string, unknown>;
  const requiredStrings = [
    "tenant_id", "event_id", "correlation_id", "policy_version",
    "rule_version", "configuration_version", "decided_at",
  ];
  if (
    requiredStrings.some((key) =>
      typeof record[key] !== "string" || !(record[key] as string).trim()
    ) ||
    typeof record.action !== "string" ||
    !SYNTHETIC_DECISION_ACTIONS.has(record.action) ||
    typeof record.risk_score !== "number" ||
    !Number.isFinite(record.risk_score) ||
    record.risk_score < 0 ||
    record.risk_score > 1 ||
    !Array.isArray(record.reason_codes) ||
    !record.reason_codes.every((code: unknown) => typeof code === "string") ||
    (record.model_version !== undefined &&
      record.model_version !== null &&
      typeof record.model_version !== "string") ||
    (!AWARE_ISO_TIMESTAMP.test(record.decided_at as string) ||
      Number.isNaN(Date.parse(record.decided_at as string)))
  ) {
    throw invalid();
  }
  return value as FraudDecision;
}


const API_BASE = apiBasePath(import.meta.env.VITE_API_BASE_PATH);

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health/live`);
    if (!res.ok) return false;
    // Vite's SPA fallback can return 200 HTML when the proxy/backend is missing.
    // Only the synthetic FastAPI liveness contract is evidence of "API up".
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return false;
    const data: unknown = await res.json();
    return (
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      "status" in data &&
      data.status === "ok"
    );
  } catch {
    return false;
  }
}

export async function createDecision(
  request: DecisionRequest,
): Promise<FraudDecision> {
  const res = await fetch(`${API_BASE}/v1/decisions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Decision request failed (${res.status}): ${detail}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("Invalid synthetic decision response");
  }
  return parseSyntheticDecision(body);
}

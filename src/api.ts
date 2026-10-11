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

const API_BASE = "/api";

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health/live`);
    return res.ok;
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
  return res.json();
}

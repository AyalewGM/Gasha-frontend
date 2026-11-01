import type { BeneficiaryType } from "./api";

/** Demonstration inputs only. Never an observed signal, verified label or bank evidence. */
export type RiskKey =
  | "customer_risk"
  | "transaction_risk"
  | "velocity_risk"
  | "device_session_risk"
  | "beneficiary_risk"
  | "relationship_risk"
  | "network_risk"
  | "journey_risk";

export type SyntheticRisks = Record<RiskKey, number>;

export interface SyntheticTransactionDraft {
  tenant_id: string;
  channel: string;
  transaction_type: string;
  amount: string;
  currency: string;
  sender_customer_id: string;
  sender_account_id: string;
  beneficiary_id: string;
  beneficiary_type: BeneficiaryType;
  destination_institution_id: string;
  device_id: string;
}

export interface SyntheticScenario {
  id: "uc01" | "uc02" | "uc03";
  label: string;
  description: string;
  transaction: SyntheticTransactionDraft;
  risks: SyntheticRisks;
}

export const SYNTHETIC_SCENARIOS: readonly SyntheticScenario[] = [
  {
    id: "uc01",
    label: "UC-01 · New-beneficiary social-engineering pattern",
    description: "Illustrative new external beneficiary and unfamiliar relationship; no verified scam or fraud label.",
    transaction: {
      tenant_id: "synthetic-tenant",
      channel: "mobile",
      transaction_type: "transfer",
      amount: "1250.00",
      currency: "ETB",
      sender_customer_id: "synthetic-customer-01",
      sender_account_id: "synthetic-account-01",
      beneficiary_id: "synthetic-new-beneficiary-01",
      beneficiary_type: "external",
      destination_institution_id: "synthetic-external-institution",
      device_id: "synthetic-device-known",
    },
    risks: {
      customer_risk: 0.20,
      transaction_risk: 0.72,
      velocity_risk: 0.50,
      device_session_risk: 0.20,
      beneficiary_risk: 0.90,
      relationship_risk: 0.95,
      network_risk: 0.35,
      journey_risk: 0.30,
    },
  },
  {
    id: "uc02",
    label: "UC-02 · Beneficiary/network concentration",
    description: "Illustrative beneficiary velocity and network signals; no cross-bank or receiving-bank records are implied.",
    transaction: {
      tenant_id: "synthetic-tenant",
      channel: "mobile",
      transaction_type: "transfer",
      amount: "840.00",
      currency: "ETB",
      sender_customer_id: "synthetic-customer-02",
      sender_account_id: "synthetic-account-02",
      beneficiary_id: "synthetic-shared-beneficiary-02",
      beneficiary_type: "external",
      destination_institution_id: "synthetic-external-institution",
      device_id: "synthetic-device-known",
    },
    risks: {
      customer_risk: 0.25,
      transaction_risk: 0.68,
      velocity_risk: 0.94,
      device_session_risk: 0.12,
      beneficiary_risk: 0.97,
      relationship_risk: 0.78,
      network_risk: 0.98,
      journey_risk: 0.20,
    },
  },
  {
    id: "uc03",
    label: "UC-03 · Device/session journey anomaly",
    description: "Illustrative account-access and device/session risk inputs; not a proven ATO or a live journey detector.",
    transaction: {
      tenant_id: "synthetic-tenant",
      channel: "mobile",
      transaction_type: "transfer",
      amount: "2750.00",
      currency: "ETB",
      sender_customer_id: "synthetic-customer-03",
      sender_account_id: "synthetic-account-03",
      beneficiary_id: "synthetic-beneficiary-03",
      beneficiary_type: "external",
      destination_institution_id: "synthetic-external-institution",
      device_id: "synthetic-new-device-03",
    },
    risks: {
      customer_risk: 0.70,
      transaction_risk: 0.68,
      velocity_risk: 0.81,
      device_session_risk: 0.98,
      beneficiary_risk: 0.65,
      relationship_risk: 0.68,
      network_risk: 0.30,
      journey_risk: 0.99,
    },
  },
];

export function findSyntheticScenario(id: string): SyntheticScenario | undefined {
  return SYNTHETIC_SCENARIOS.find((scenario) => scenario.id === id);
}

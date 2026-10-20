import { useEffect, useState } from "react";
import { runDecisionRequest } from "./decisionSubmission";
import {
  checkHealth,
  createDecision,
  type BeneficiaryType,
  type DecisionRequest,
  type FraudDecision,
} from "./api";

const RISK_FIELDS = [
  ["customer_risk", "Customer"],
  ["transaction_risk", "Transaction"],
  ["velocity_risk", "Velocity"],
  ["device_session_risk", "Device/session"],
  ["beneficiary_risk", "Beneficiary"],
  ["relationship_risk", "Relationship"],
  ["network_risk", "Network"],
  ["journey_risk", "Journey"],
] as const;

type RiskKey = (typeof RISK_FIELDS)[number][0];

const BENEFICIARY_TYPES: BeneficiaryType[] = [
  "internal",
  "external",
  "merchant",
  "wallet",
  "unknown",
];

export default function App() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<FraudDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tx, setTx] = useState({
    tenant_id: "tenant-a",
    channel: "mobile",
    transaction_type: "transfer",
    amount: "1250.00",
    currency: "ETB",
    sender_customer_id: "customer-1",
    sender_account_id: "account-1",
    beneficiary_id: "beneficiary-9",
    beneficiary_type: "external" as BeneficiaryType,
    destination_institution_id: "external-bank",
    device_id: "",
  });

  const [risks, setRisks] = useState<Record<RiskKey, number>>({
    customer_risk: 0,
    transaction_risk: 0,
    velocity_risk: 0,
    device_session_risk: 0,
    beneficiary_risk: 0,
    relationship_risk: 0,
    network_risk: 0,
    journey_risk: 0,
  });

  useEffect(() => {
    checkHealth().then(setHealthy);
  }, []);

  async function submit() {
    setSubmitting(true);
    const request: DecisionRequest = {
      transaction: {
        ...tx,
        event_id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        destination_institution_id:
          tx.beneficiary_type === "external"
            ? tx.destination_institution_id || null
            : null,
        device_id: tx.device_id || null,
        correlation_id: `ui-${Date.now()}`,
      },
      policy: {
        configuration_version: "tenant-config-9",
        policy_version: "decision-policy-5",
        rule_version: "rules-4",
        monitor_threshold: 0.5,
        review_threshold: 0.7,
        hold_threshold: 0.85,
        block_threshold: 0.95,
      },
      ...risks,
    };
    await runDecisionRequest(request, createDecision, {
      onStart: () => { setDecision(null); setError(null); },
      onSuccess: setDecision,
      onFailure: setError,
    });
    setSubmitting(false);
  }

  function setTxField(key: keyof typeof tx) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setTx((t) => ({ ...t, [key]: e.target.value }));
  }

  return (
    <div className="app">
      <header>
        <h1>Gasha — Fraud Decision Console</h1>
        <span className={`health ${healthy ? "up" : "down"}`}>
          {healthy === null ? "checking…" : healthy ? "API up" : "API down"}
        </span>
      </header>

      <div className="grid">
        <section className="panel">
          <h2>Transaction</h2>
          <div className="row">
            <div className="field">
              <label>Tenant</label>
              <input value={tx.tenant_id} onChange={setTxField("tenant_id")} />
            </div>
            <div className="field">
              <label>Channel</label>
              <input value={tx.channel} onChange={setTxField("channel")} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Type</label>
              <input
                value={tx.transaction_type}
                onChange={setTxField("transaction_type")}
              />
            </div>
            <div className="field">
              <label>Amount</label>
              <input value={tx.amount} onChange={setTxField("amount")} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Currency</label>
              <input
                value={tx.currency}
                maxLength={3}
                onChange={setTxField("currency")}
              />
            </div>
            <div className="field">
              <label>Sender customer</label>
              <input
                value={tx.sender_customer_id}
                onChange={setTxField("sender_customer_id")}
              />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Sender account</label>
              <input
                value={tx.sender_account_id}
                onChange={setTxField("sender_account_id")}
              />
            </div>
            <div className="field">
              <label>Beneficiary</label>
              <input
                value={tx.beneficiary_id}
                onChange={setTxField("beneficiary_id")}
              />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Beneficiary type</label>
              <select
                value={tx.beneficiary_type}
                onChange={setTxField("beneficiary_type")}
              >
                {BENEFICIARY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {tx.beneficiary_type === "external" && (
              <div className="field">
                <label>Destination institution</label>
                <input
                  value={tx.destination_institution_id}
                  onChange={setTxField("destination_institution_id")}
                />
              </div>
            )}
          </div>

          <h2>Intelligence inputs</h2>
          <div className="risks">
            {RISK_FIELDS.map(([key, label]) => (
              <label key={key} className="risk-slider">
                <span>{label}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={risks[key]}
                  onChange={(e) =>
                    setRisks((r) => ({ ...r, [key]: Number(e.target.value) }))
                  }
                />
                <output>{risks[key].toFixed(2)}</output>
              </label>
            ))}
          </div>

          <button
            className="submit"
            disabled={submitting}
            onClick={submit}
          >
            {submitting ? "Deciding…" : "Request decision"}
          </button>
          {error && <div className="error">{error}</div>}
        </section>

        <section className="panel">
          <h2>Decision</h2>
          {submitting ? (
            <div className="empty" role="status">Decision pending for the current transaction…</div>
          ) : decision ? (
            <>
              <p>Risk recommendation only — not a bank-executed intervention.</p>
              <div className={`decision-action action-${decision.action}`}>
                {decision.action}
              </div>
              <div className="score-bar">
                <div
                  className="score-fill"
                  style={{ width: `${decision.risk_score * 100}%` }}
                />
              </div>
              <div>
                Risk score: <strong>{decision.risk_score.toFixed(3)}</strong>
              </div>
              {decision.reason_codes.length > 0 && (
                <div className="reason-codes">
                  {decision.reason_codes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              )}
              <dl className="kv" style={{ marginTop: "1rem" }}>
                <dt>Event</dt>
                <dd>{decision.event_id}</dd>
                <dt>Correlation</dt>
                <dd>{decision.correlation_id}</dd>
                <dt>Policy</dt>
                <dd>{decision.policy_version}</dd>
                <dt>Rules</dt>
                <dd>{decision.rule_version}</dd>
                <dt>Config</dt>
                <dd>{decision.configuration_version}</dd>
                <dt>Decided at</dt>
                <dd>{new Date(decision.decided_at).toLocaleString()}</dd>
              </dl>
            </>
          ) : (
            <div className="empty">
              Submit a transaction to see the fraud decision, reason codes, and
              version provenance.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

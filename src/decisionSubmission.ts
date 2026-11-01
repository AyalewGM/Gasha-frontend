import type { DecisionRequest, FraudDecision } from "./api";

interface Callbacks {
  onStart: () => void;
  onSuccess: (decision: FraudDecision) => void;
  onFailure: (message: string) => void;
}

/** Isolates every request from the preceding decision; fail closed on mismatched identity. */
export async function runDecisionRequest(
  request: DecisionRequest,
  send: (request: DecisionRequest) => Promise<FraudDecision>,
  callbacks: Callbacks,
): Promise<void> {
  callbacks.onStart();
  try {
    const result = await send(request);
    if (
      result.tenant_id !== request.transaction.tenant_id ||
      result.event_id !== request.transaction.event_id ||
      result.correlation_id !== request.transaction.correlation_id
    ) throw new Error("Decision response does not match the requested transaction");
    // The synthetic backend echoes the caller-selected policy. Reject a
    // recommendation produced for another set of versioned policy inputs.
    if (
      result.configuration_version !== request.policy.configuration_version ||
      result.policy_version !== request.policy.policy_version ||
      result.rule_version !== request.policy.rule_version ||
      (result.model_version ?? null) !== (request.policy.model_version ?? null)
    ) throw new Error("Decision response provenance does not match the requested synthetic policy");
    callbacks.onSuccess(result);
  } catch (error) {
    callbacks.onFailure(error instanceof Error ? error.message : String(error));
  }
}

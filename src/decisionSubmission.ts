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
    callbacks.onSuccess(result);
  } catch (error) {
    callbacks.onFailure(error instanceof Error ? error.message : String(error));
  }
}

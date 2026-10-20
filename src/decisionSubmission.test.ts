import { describe, expect, it, vi } from "vitest";
import { runDecisionRequest } from "./decisionSubmission";
import type { DecisionRequest, FraudDecision } from "./api";

const request = {
  transaction: { tenant_id: "tenant-a", event_id: "event-b", correlation_id: "corr-b" },
} as DecisionRequest;
const matchingDecision = {
  tenant_id: "tenant-a", event_id: "event-b", correlation_id: "corr-b", action: "review",
} as FraudDecision;

describe("fraud decision request isolation", () => {
  it("clears prior decision before sending and never reuses it after failure", async () => {
    let displayed: FraudDecision | null = { ...matchingDecision, event_id: "event-a" };
    const actions: string[] = [];
    const handlers = {
      onStart: () => { displayed = null; actions.push("start"); },
      onSuccess: (decision: FraudDecision) => { displayed = decision; actions.push("success"); },
      onFailure: () => { displayed = null; actions.push("failure"); },
    };
    await runDecisionRequest(request, async () => {
      expect(displayed).toBeNull();
      throw new Error("HTTP 422");
    }, handlers);
    expect(displayed).toBeNull();
    expect(actions).toEqual(["start", "failure"]);
  });

  it("rejects decisions for another tenant or event", async () => {
    for (const changed of [{ tenant_id: "other" }, { event_id: "event-a" }, { correlation_id: "corr-a" }]) {
      const success = vi.fn();
      const failure = vi.fn();
      await runDecisionRequest(request, async () => ({ ...matchingDecision, ...changed }), {
        onStart: vi.fn(), onSuccess: success, onFailure: failure,
      });
      expect(success).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalledWith("Decision response does not match the requested transaction");
    }
  });

  it("shows only a matching successful decision", async () => {
    const success = vi.fn();
    await runDecisionRequest(request, async () => matchingDecision, {
      onStart: vi.fn(), onSuccess: success, onFailure: vi.fn(),
    });
    expect(success).toHaveBeenCalledWith(matchingDecision);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createProtectedCaseTransitionPort } from "./protectedCaseTransitionPort";
import type { CaseHistoryEvent } from "./caseHistory";

const CASE = "abcdef11-1111-4111-8111-111111111111";
const SOURCE = "abcdef22-2222-4222-8222-222222222222";
const ASSIGNEE = "abcdef33-3333-4333-8333-333333333333";
const KEY = "0".repeat(32);
const ACTOR = "a".repeat(64);
const CONTEXT = "c".repeat(64);

const EVENTS: readonly CaseHistoryEvent[] = [
  { operation: "create", reason_code: "source_evaluation" },
  { operation: "triage", reason_code: "analyst_triage" },
  { operation: "assign", reason_code: "investigation_assigned" },
  { operation: "dispose", reason_code: "fraud_evidence", disposition: "confirmed_fraud" },
  { operation: "correct", reason_code: "corrected_finding", disposition: "confirmed_legitimate" },
].map((row, index) => ({
  revision: index + 1,
  previous_revision: index || null,
  recorded_at: `2026-11-15T00:00:0${index}Z`,
  actor_ref: ACTOR,
  assignee_ref: row.operation === "assign" ? ACTOR : null,
  source_event_id: SOURCE,
  source_context_ref: CONTEXT,
  bank_execution: "unknown",
  operation: row.operation as CaseHistoryEvent["operation"],
  reason_code: row.reason_code,
  disposition: (row.disposition ?? null) as CaseHistoryEvent["disposition"],
}));

function history(revision: number) {
  return { case_id: CASE, events: EVENTS.slice(0, revision), enforcement_activated: false };
}

const receipt = {
  case_id: CASE,
  source_event_id: SOURCE,
  revision: 4,
  operation: "dispose",
  disposition: "confirmed_fraud",
  bank_execution: "unknown",
  enforcement_activated: false,
};
const dispose = { operation: "dispose", disposition: "confirmed_fraud" } as const;

describe("injected protected case transitions", () => {
  it.each([
    [1, { operation: "triage" }, { reason_code: "analyst_triage" }],
    [2, { operation: "assign", assigneeSelector: ASSIGNEE },
      { reason_code: "investigation_assigned", assignee_selector: ASSIGNEE }],
    [3, dispose, { reason_code: "fraud_evidence", disposition: "confirmed_fraud" }],
    [4, { operation: "correct", disposition: "confirmed_legitimate" },
      { reason_code: "corrected_finding", disposition: "confirmed_legitimate" }],
    [5, { operation: "reconcile" }, { reason_code: "feedback_reconciled" }],
  ] as const)("binds a revision %i proposal and its receipt to the case history", async (revision, proposal, fields) => {
    const payload = {
      ...receipt, revision: revision + 1, operation: proposal.operation,
      disposition: "disposition" in proposal ? proposal.disposition : null,
    };
    const post = vi.fn().mockResolvedValue({ status: 200, payload });
    const port = createProtectedCaseTransitionPort("synthetic-a", post);
    await expect(port.submit(CASE, history(revision), proposal, KEY)).resolves.toEqual(payload);
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `/v1/tenants/synthetic-a/cases/${CASE}/transitions/${proposal.operation}`,
      { source_event_id: SOURCE, expected_revision: revision, idempotency_key: KEY, ...fields },
    );
    expect(Object.isFrozen(post.mock.calls[0][1])).toBe(true);
  });

  it("rejects path substitution, invalid history, out-of-order steps and authority injections", async () => {
    const post = vi.fn();
    expect(() => createProtectedCaseTransitionPort("tenant/../other", post))
      .toThrow("This action does not match the current case history.");
    const port = createProtectedCaseTransitionPort("synthetic-a", post);
    const injected = { ...dispose, bank_execution: "hold" };
    await expect(port.submit("../elsewhere", history(3), dispose, KEY)).rejects
      .toMatchObject({ kind: "invalid_proposal" });
    await expect(port.submit(CASE, { ...history(3), case_id: SOURCE }, dispose, KEY)).rejects
      .toMatchObject({ kind: "invalid_proposal" });
    await expect(port.submit(CASE, history(1), dispose, KEY)).rejects
      .toMatchObject({ kind: "invalid_proposal" });
    await expect(port.submit(CASE, history(3), injected, KEY)).rejects
      .toMatchObject({ kind: "invalid_proposal" });
    await expect(port.submit(CASE, history(4), { ...dispose, operation: "correct" }, KEY)).rejects
      .toMatchObject({ kind: "invalid_proposal" });
    await expect(port.submit(CASE, history(3), dispose, KEY + "\n")).rejects
      .toMatchObject({ kind: "invalid_proposal" });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    [403, "access_denied"], [404, "access_denied"], [409, "refresh_required"],
    [422, "request_rejected"], [503, "outcome_unknown"], [302, "outcome_unknown"],
  ])("redacts status %i and never retries automatically", async (status, kind) => {
    const post = vi.fn().mockResolvedValue({ status, payload: { detail: "sensitive diagnostics" } });
    const port = createProtectedCaseTransitionPort("synthetic-a", post);
    await expect(port.submit(CASE, history(3), dispose, KEY)).rejects.toMatchObject({ kind });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { case_id: SOURCE }, { source_event_id: CASE }, { revision: 5 },
    { operation: "reconcile" }, { disposition: "confirmed_legitimate" },
    { enforcement_activated: true }, { bank_execution: "held" }, { raw_details: "sensitive detail" },
  ])("treats malformed 200 receipts as uncertain outcomes", async (fault) => {
    const post = vi.fn().mockResolvedValue({ status: 200, payload: { ...receipt, ...fault } });
    const port = createProtectedCaseTransitionPort("synthetic-a", post);
    await expect(port.submit(CASE, history(3), dispose, KEY)).rejects.toMatchObject({
      kind: "outcome_unknown",
      message: "The action could not be confirmed. Refresh the case history before retrying.",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reports transport failures as unknown without automatically replaying a POST", async () => {
    const post = vi.fn().mockRejectedValue(new Error("sensitive transport detail"));
    const port = createProtectedCaseTransitionPort("synthetic-a", post);
    await expect(port.submit(CASE, history(3), dispose, KEY)).rejects.toMatchObject({
      kind: "outcome_unknown",
      message: "The action could not be confirmed. Refresh the case history before retrying.",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("retires the port on 401 and does not expose a late receipt as confirmed", async () => {
    let complete!: (value: { status: number; payload: unknown }) => void;
    const pending = new Promise<{ status: number; payload: unknown }>((resolve) => {
      complete = resolve;
    });
    const post = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce({ status: 401 });
    const port = createProtectedCaseTransitionPort("synthetic-a", post);
    const submitted = port.submit(CASE, history(3), dispose, KEY);
    await expect(port.submit(CASE, history(3), dispose, KEY)).rejects
      .toMatchObject({ kind: "session_unavailable" });
    complete({ status: 200, payload: receipt });
    await expect(submitted).rejects.toMatchObject({ kind: "outcome_unknown" });
    await expect(port.submit(CASE, history(3), dispose, KEY)).rejects
      .toMatchObject({ kind: "session_unavailable" });
    expect(post).toHaveBeenCalledTimes(2);
  });
});

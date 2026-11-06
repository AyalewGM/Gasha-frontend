import { describe, expect, it, vi } from "vitest";
import { parseLinkedCaseHistory } from "./caseQueueHistory";

const CASE_ID = "00000000-0000-4000-8000-000000000041";
const SOURCE_ID = "00000000-0000-4000-8000-000000000042";
const OTHER_ID = "00000000-0000-4000-8000-000000000043";
const CONTEXT = "c".repeat(64);
const ACTOR = "a".repeat(64);
const ASSIGNEE = "b".repeat(64);

type Stage = "create" | "triage" | "assign";

function fixture(stage: Stage = "assign") {
  const steps = [
    { operation: "create", reason_code: "source_evaluation", at: "2026-11-05T10:00:00.000001Z" },
    { operation: "triage", reason_code: "analyst_triage", at: "2026-11-05T11:00:00.000002Z" },
    { operation: "assign", reason_code: "investigation_assigned", at: "2026-11-05T11:30:00.000003Z" },
  ].slice(0, ({ create: 1, triage: 2, assign: 3 })[stage]);
  const events = steps.map((step, i) => ({
    revision: i + 1,
    previous_revision: i === 0 ? null : i,
    operation: step.operation,
    recorded_at: step.at,
    reason_code: step.reason_code,
    disposition: null,
    actor_ref: ACTOR,
    assignee_ref: step.operation === "assign" ? ASSIGNEE : null as string | null,
    source_event_id: SOURCE_ID,
    source_context_ref: CONTEXT,
    bank_execution: "unknown",
  }));
  const last = events[events.length - 1];
  const queue = {
    tenant_scope: "authenticated_reader",
    ranking_policy_version: "synthetic-ranked-v1",
    generated_at: "2026-11-05T12:00:00Z",
    items: [{
      rank: 1,
      case_id: CASE_ID,
      source_event_id: SOURCE_ID,
      source_context_ref: CONTEXT,
      scenario_ids: ["APP-01", "ATO-02"],
      status: stage,
      revision: events.length,
      created_at: events[0].recorded_at,
      updated_at: last.recorded_at,
      assignee_ref: last.assignee_ref,
      bank_execution: "unknown",
    }],
    bank_ranking_approved: false,
    enforcement_activated: false,
  };
  return { queue, history: { case_id: CASE_ID, enforcement_activated: false, events } };
}

function join(v = fixture(), caseId = CASE_ID) {
  return parseLinkedCaseHistory(v.queue, v.history, caseId, 25);
}

describe("Issue #45 inert ranked-queue/history consistency", () => {
  it.each(["create", "triage", "assign"] as const)(
    "joins one immutable, matching %s snapshot without authority or HTTP",
    (stage) => {
      const response = fixture(stage);
      const spy = vi.spyOn(globalThis, "fetch");
      try {
        const linked = join(response);
        expect(linked.selectedCase.status).toBe(stage);
        expect(linked.history.events).toHaveLength(response.queue.items[0].revision);
        expect(linked.queue.enforcement_activated).toBe(false);
        expect(linked.selectedCase.bank_execution).toBe("unknown");
        expect(Object.isFrozen(linked)).toBe(true);
        expect(Object.isFrozen(linked.selectedCase)).toBe(true);
        response.queue.items[0].source_event_id = OTHER_ID;
        expect(linked.selectedCase.source_event_id).toBe(SOURCE_ID);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("compares absolute instants across offsets and a DST fold, preserving micros", () => {
    const v = fixture();
    v.queue.items[0].created_at = "2026-11-05T05:00:00.000001-05:00";
    v.queue.items[0].updated_at = "2026-11-05T06:30:00.000003-05:00";
    expect(join(v).history.events).toHaveLength(3);
    v.queue.items[0].updated_at = "2026-11-05T06:30:00.000002-05:00";
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
  });

  it("refuses cross-case selection or a case omitted from the queue", () => {
    const v = fixture();
    expect(() => join(v, OTHER_ID)).toThrow("Invalid protected case-history projection");
    v.queue.items = [];
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
  });

  it("refuses a queue item substituted from a different source or context", () => {
    const v = fixture();
    v.queue.items[0].source_event_id = OTHER_ID;
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
    v.queue.items[0].source_event_id = SOURCE_ID;
    v.queue.items[0].source_context_ref = "d".repeat(64);
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
  });

  it("rejects a stale revision/status rather than displaying partial history", () => {
    const v = fixture();
    v.queue.items[0].revision = 2;
    v.queue.items[0].status = "triage";
    v.queue.items[0].assignee_ref = null;
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
    const other = fixture("triage");
    other.history.events.push({ ...fixture().history.events[2] });
    expect(() => join(other)).toThrow("Inconsistent protected case-queue/history projections");
  });

  it("refuses mismatched creation, update or snapshot time", () => {
    const v = fixture();
    v.queue.items[0].created_at = "2026-11-05T10:00:00.000002Z";
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
    v.queue.items[0].created_at = "2026-11-05T10:00:00.000001Z";
    v.queue.items[0].updated_at = "2026-11-05T11:30:00.000004Z";
    expect(() => join(v)).toThrow("Inconsistent protected case-queue/history projections");
    v.queue.items[0].updated_at = "2026-11-05T11:30:00.000003Z";
    v.queue.generated_at = "2026-11-05T11:00:00Z";
    expect(() => join(v)).toThrow("Invalid protected case-queue projection");
  });

  it("refuses raw customer fields and Bank-executed claims before joining", () => {
    const v = fixture();
    Object.assign(v.history.events[0], { customer_name: "not-for-view" });
    expect(() => join(v)).toThrow("Invalid protected case-history projection");
    const other = fixture();
    Object.assign(other.queue, { bank_ranking_approved: true });
    expect(() => join(other)).toThrow("Invalid protected case-queue projection");
  });
});

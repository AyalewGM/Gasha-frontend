import { describe, expect, it } from "vitest";
import { parseProtectedCaseQueue } from "./caseQueue";

const CASE_A = "00000000-0000-4000-8000-000000000041";
const CASE_B = "00000000-0000-4000-8000-000000000043";
const SOURCE_A = "00000000-0000-4000-8000-000000000042";
const SOURCE_B = "00000000-0000-4000-8000-000000000044";
const CONTEXT = "c".repeat(64);
const ASSIGNEE = "a".repeat(64);

function fixture() {
  return {
    tenant_scope: "authenticated_reader",
    ranking_policy_version: "synthetic-ranked-v1",
    generated_at: "2026-11-05T12:00:00+00:00",
    items: [{
      rank: 1,
      case_id: CASE_A,
      source_event_id: SOURCE_A,
      source_context_ref: CONTEXT,
      scenario_ids: ["APP-01", "ATO-02"],
      status: "create",
      revision: 1,
      created_at: "2026-11-05T11:00:00+00:00",
      updated_at: "2026-11-05T11:00:00+00:00",
      assignee_ref: null as string | null,
      bank_execution: "unknown",
    }],
    bank_ranking_approved: false,
    enforcement_activated: false,
  };
}

function mustReject(mutate: (payload: ReturnType<typeof fixture>) => void, limit = 25) {
  const payload = fixture();
  mutate(payload);
  expect(() => parseProtectedCaseQueue(payload, limit)).toThrow(
    "Invalid protected case-queue projection",
  );
}

describe("Issue #45 inert protected queue projection", () => {
  it("accepts a bounded synthetic queue, copies and freezes every field", () => {
    const response = fixture();
    const originalFetch = globalThis.fetch;
    const projected = parseProtectedCaseQueue(response, 25);
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0].scenario_ids).toEqual(["APP-01", "ATO-02"]);
    expect(projected.bank_ranking_approved).toBe(false);
    expect(projected.enforcement_activated).toBe(false);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.items)).toBe(true);
    expect(Object.isFrozen(projected.items[0])).toBe(true);
    expect(Object.isFrozen(projected.items[0].scenario_ids)).toBe(true);
    response.items[0].scenario_ids[0] = "APP-05";
    expect(projected.items[0].scenario_ids[0]).toBe("APP-01");
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("accepts empty snapshots and contiguous, distinct multi-scenario cases", () => {
    const empty = fixture();
    empty.items = [];
    expect(parseProtectedCaseQueue(empty, 25).items).toEqual([]);

    const two = fixture();
    two.items.push({
      ...two.items[0],
      rank: 2,
      case_id: CASE_B,
      source_event_id: SOURCE_B,
      scenario_ids: ["MM-01", "MM-02", "MM-05"],
    });
    expect(parseProtectedCaseQueue(two, 2).items.map((item) => item.rank)).toEqual([1, 2]);
    expect(() => parseProtectedCaseQueue(two, 1)).toThrow();
  });

  it("normalizes comparisons across timezone offsets and DST folds without discarding micros", () => {
    const payload = fixture();
    payload.generated_at = "2026-11-01T07:00:00Z";
    payload.items[0].created_at = "2026-11-01T01:30:00.000001-04:00";
    payload.items[0].updated_at = "2026-11-01T01:15:00.000002-05:00";
    expect(parseProtectedCaseQueue(payload, 25).items).toHaveLength(1);
    payload.items[0].updated_at = "2026-11-01T01:30:00.000000-04:00";
    expect(() => parseProtectedCaseQueue(payload, 25)).toThrow();
  });

  it("refuses unknown fields, including raw customer identity and unexpected scope", () => {
    mustReject((p) => Object.assign(p.items[0], { customer_name: "synthetic-only" }));
    mustReject((p) => Object.assign(p, { credential: "synthetic-only" }));
    mustReject((p) => { p.tenant_scope = "tenant-a"; });
    mustReject((p) => { p.ranking_policy_version = "bad\\nheader"; });
  });

  it("refuses any Bank authority, executed intervention or unverified ranking", () => {
    mustReject((p) => { p.enforcement_activated = true; });
    mustReject((p) => { p.bank_ranking_approved = true; });
    mustReject((p) => { p.items[0].bank_execution = "executed"; });
  });

  it("rejects duplicate and out-of-order ranks, cases, sources and scenario IDs", () => {
    mustReject((p) => { p.items[0].rank = 2; });
    mustReject((p) => { p.items[0].scenario_ids = ["ATO-02", "APP-01"]; });
    mustReject((p) => { p.items[0].scenario_ids = ["APP-01", "APP-01"]; });
    mustReject((p) => { p.items[0].scenario_ids = ["APP-99"]; });
    mustReject((p) => { p.items[0].source_context_ref = "raw-id"; });
    mustReject((p) => { p.items[0].case_id = "not-a-uuid"; });
    mustReject((p) => {
      p.items.push({ ...p.items[0], rank: 2, source_event_id: SOURCE_B });
    });
    mustReject((p) => {
      p.items.push({ ...p.items[0], rank: 2, case_id: CASE_B });
    });
  });

  it("rejects impossible lifecycle, assignee leakage and non-opaque references", () => {
    mustReject((p) => { p.items[0].status = "dispose"; });
    mustReject((p) => { p.items[0].revision = 2; });
    mustReject((p) => { p.items[0].assignee_ref = ASSIGNEE; });
    mustReject((p) => {
      p.items[0].status = "assign";
      p.items[0].revision = 3;
      p.items[0].assignee_ref = "person-id";
    });
    const assigned = fixture();
    assigned.items[0].status = "assign";
    assigned.items[0].revision = 3;
    assigned.items[0].assignee_ref = ASSIGNEE;
    expect(parseProtectedCaseQueue(assigned, 25).items[0].status).toBe("assign");
  });

  it("rejects naive, impossible, out-of-order, future and microsecond-reversed times", () => {
    mustReject((p) => { p.generated_at = "2026-11-05T12:00:00"; });
    mustReject((p) => { p.items[0].created_at = "2026-02-30T12:00:00Z"; });
    mustReject((p) => { p.items[0].updated_at = "2026-11-05T10:59:59Z"; });
    mustReject((p) => { p.items[0].updated_at = "2026-11-05T12:00:01Z"; });
    mustReject((p) => {
      p.items[0].created_at = "2026-11-05T11:00:00.000002Z";
      p.items[0].updated_at = "2026-11-05T11:00:00.000001Z";
    });
  });

  it("refuses invalid request limits without issuing a network request", () => {
    for (const limit of [0, 101, -1, 1.5, Number.NaN]) {
      expect(() => parseProtectedCaseQueue(fixture(), limit)).toThrow();
    }
  });
});

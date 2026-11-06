import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseHistoryPanel } from "./CaseHistoryPanel";
import { parseProtectedCaseHistory } from "./caseHistory";

const CASE_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_CASE = "00000000-0000-4000-8000-000000000003";
const ACTOR = "a".repeat(64);
const CONTEXT = "c".repeat(64);
const ASSIGNEE = "d".repeat(64);

function fixture() {
  const operations = ["create", "triage", "assign", "dispose", "correct", "reconcile"];
  const reasons = [
    "source_evaluation", "analyst_triage", "investigation_assigned",
    "fraud_evidence", "corrected_finding", "feedback_reconciled",
  ];
  return {
    case_id: CASE_ID,
    enforcement_activated: false,
    events: operations.map((operation, i) => ({
      revision: i + 1,
      previous_revision: i === 0 ? null : i,
      operation,
      recorded_at: "2026-11-01T12:0" + i + ":00+00:00",
      reason_code: reasons[i],
      disposition: i === 3 ? "confirmed_fraud" : i === 4 ? "confirmed_legitimate" : null,
      actor_ref: ACTOR,
      assignee_ref: i === 2 ? ASSIGNEE : null,
      source_event_id: EVENT_ID,
      source_context_ref: CONTEXT,
      bank_execution: "unknown",
    })),
  };
}

describe("inert protected case history projection, backend #45 v0.1", () => {
  it("accepts the documented immutable six-step synthetic lifecycle", () => {
    const result = parseProtectedCaseHistory(fixture(), CASE_ID);
    expect(result.events).toHaveLength(6);
    expect(result.enforcement_activated).toBe(false);
    expect(result.events[4].disposition).toBe("confirmed_legitimate");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
  });

  it("renders a read-only, pseudonymous, offset-aware case timeline with unknown execution", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const parsed = parseProtectedCaseHistory(fixture(), CASE_ID);
      const html = renderToStaticMarkup(createElement(CaseHistoryPanel, { history: parsed }));
      expect(html).toContain('aria-label="Read-only case history"');
      expect(html).toContain("Case events");
      expect(html).toContain("confirmed_fraud");
      expect(html).toContain("confirmed_legitimate");
      expect(html).toContain("Bank execution");
      expect(html).toContain("unknown");
      expect(html).toContain("2026-11-01T12:05:00+00:00");
      expect(html).toContain("Recorded (source offset; full precision)");
      expect(html).not.toContain(ACTOR);
      expect(html).not.toContain("Authorization");
      expect(html).not.toContain("<button");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("preserves submillisecond event order and original source offsets in the read-only view", () => {
    const value = fixture();
    value.events[0].recorded_at = "2026-11-01T12:00:00.000100Z";
    value.events[1].recorded_at = "2026-11-01T07:00:00.000900-05:00";
    const parsed = parseProtectedCaseHistory(value, CASE_ID);
    const html = renderToStaticMarkup(createElement(CaseHistoryPanel, { history: parsed }));
    expect(html).toContain(">2026-11-01T12:00:00.000100Z</time>");
    expect(html).toContain(">2026-11-01T07:00:00.000900-05:00</time>");
    expect(html).not.toContain(">2026-11-01T12:00:00.000Z</time>");
  });

  it("rejects a different requested case rather than displaying cross-case data", () => {
    expect(() => parseProtectedCaseHistory(fixture(), OTHER_CASE))
      .toThrow("Invalid protected case-history projection");
  });

  const corruptions: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ["claimed enforcement", (v) => { v.enforcement_activated = true; }],
    ["empty history", (v) => { v.events = []; }],
    ["raw customer field", (v) => { Object.assign(v.events[0], { customer_name: "not-for-view" }); }],
    ["unrecognized response authority", (v) => { Object.assign(v, { ready: true }); }],
    ["non-opaque actor", (v) => { v.events[0].actor_ref = "person-name"; }],
    ["non-opaque context", (v) => { v.events[0].source_context_ref = "raw-context"; }],
    ["claimed executed action", (v) => { v.events[0].bank_execution = "executed"; }],
    ["wrong revision", (v) => { v.events[1].revision = 3; }],
    ["missing previous link", (v) => { v.events[1].previous_revision = null; }],
    ["wrong transition", (v) => { v.events[1].operation = "dispose"; }],
    ["wrong reason", (v) => { v.events[1].reason_code = "fraud_evidence"; }],
    ["disposition/reason contradiction", (v) => { v.events[3].disposition = "confirmed_legitimate"; }],
    ["correction without change", (v) => { v.events[4].disposition = "confirmed_fraud"; }],
    ["assignment with no assignee", (v) => { v.events[2].assignee_ref = null; }],
    ["case source drift", (v) => { v.events[1].source_event_id = OTHER_CASE; }],
    ["DST-fold naive clock", (v) => { v.events[1].recorded_at = "2026-11-01T01:15:00"; }],
    ["impossible calendar", (v) => { v.events[1].recorded_at = "2026-02-30T12:01:00Z"; }],
    ["reversed UTC chronology", (v) => {
      v.events[0].recorded_at = "2026-11-01T01:15:00-05:00";
      v.events[1].recorded_at = "2026-11-01T01:30:00-04:00";
    }],
  ];

  it.each(corruptions)("fails closed on %s", (_name, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => parseProtectedCaseHistory(value, CASE_ID))
      .toThrow("Invalid protected case-history projection");
  });


  it("rejects reversed microsecond events within the same JavaScript millisecond", () => {
    const value = fixture();
    // Date.parse returns the same millisecond for these two instants.
    value.events[0].recorded_at = "2026-11-01T07:00:00.000900-05:00";
    value.events[1].recorded_at = "2026-11-01T12:00:00.000100Z";
    expect(Date.parse(value.events[0].recorded_at))
      .toBe(Date.parse(value.events[1].recorded_at));
    expect(() => parseProtectedCaseHistory(value, CASE_ID))
      .toThrow("Invalid protected case-history projection");
  });

  it("accepts increasing microsecond instants within one millisecond", () => {
    const value = fixture();
    value.events[0].recorded_at = "2026-11-01T12:00:00.000100Z";
    value.events[1].recorded_at = "2026-11-01T07:00:00.000900-05:00";
    expect(parseProtectedCaseHistory(value, CASE_ID).events).toHaveLength(6);
  });


  it.each([
    ["no fraction", "2026-11-01T12:00:00Z"],
    ["one fractional digit", "2026-11-01T12:00:00.1Z"],
    ["two fractional digits", "2026-11-01T12:00:00.12Z"],
    ["three fractional digits", "2026-11-01T12:00:00.123Z"],
    ["four fractional digits", "2026-11-01T12:00:00.1234Z"],
    ["five fractional digits", "2026-11-01T12:00:00.12345Z"],
    ["six fractional digits and offset", "2026-11-01T07:00:00.123456-05:00"],
  ])("accepts supported timestamp precision: %s", (_name, timestamp) => {
    const value = fixture();
    value.events[0].recorded_at = timestamp;
    expect(parseProtectedCaseHistory(value, CASE_ID).events).toHaveLength(6);
  });

  it.each([
    ["seven fractional digits in UTC", "2026-11-01T12:00:00.0000001Z"],
    ["nine fractional digits with negative offset", "2026-11-01T07:00:00.123456789-05:00"],
    ["seven fractional digits with positive offset", "2026-11-01T17:30:00.1234567+05:30"],
  ])("rejects off-contract submicrosecond timestamps: %s", (_name, timestamp) => {
    const value = fixture();
    value.events[0].recorded_at = timestamp;
    expect(() => parseProtectedCaseHistory(value, CASE_ID))
      .toThrow("Invalid protected case-history projection");
  });

  it("rejects reversed seven-digit instants across UTC offsets rather than truncating", () => {
    const value = fixture();
    value.events[0].recorded_at = "2026-11-01T12:00:00.0000009Z";
    value.events[1].recorded_at = "2026-11-01T07:00:00.0000001-05:00";
    expect(() => parseProtectedCaseHistory(value, CASE_ID))
      .toThrow("Invalid protected case-history projection");
  });

  it("orders DST-fold instants by absolute UTC rather than repeated local clock", () => {
    const value = fixture();
    value.events[0].recorded_at = "2026-11-01T01:30:00-04:00";
    value.events[1].recorded_at = "2026-11-01T01:15:00-05:00";
    const result = parseProtectedCaseHistory(value, CASE_ID);
    const html = renderToStaticMarkup(createElement(CaseHistoryPanel, { history: result }));
    expect(html).toContain(">2026-11-01T01:30:00-04:00</time>");
    expect(html).toContain(">2026-11-01T01:15:00-05:00</time>");
  });
});

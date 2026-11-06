import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseQueuePanel } from "./CaseQueuePanel";
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
    generated_at: "2026-11-05T12:00:00.000003+00:00",
    items: [{
      rank: 1,
      case_id: CASE_A,
      source_event_id: SOURCE_A,
      source_context_ref: CONTEXT,
      scenario_ids: ["APP-01", "ATO-02"],
      status: "triage",
      revision: 2,
      created_at: "2026-11-05T10:00:00+00:00",
      updated_at: "2026-11-05T11:00:00.000001+00:00",
      assignee_ref: null as string | null,
      bank_execution: "unknown",
    }],
    bank_ranking_approved: false,
    enforcement_activated: false,
  };
}

function render(response = fixture()) {
  const queue = parseProtectedCaseQueue(response, 25);
  return renderToStaticMarkup(createElement(CaseQueuePanel, { queue }));
}

describe("Issue #45 inert ranked-queue presentation", () => {
  it("shows only the accepted projection, labels unapproved ranking and unknown execution", () => {
    const html = render();
    expect(html).toContain('aria-label="Read-only analyst case queue"');
    expect(html).toContain("read-only");
    expect(html).toContain("Bank ranking approved");
    expect(html).toContain("Payment enforcement activated");
    expect(html).toContain("not approval");
    expect(html).toContain("synthetic-ranked-v1");
    expect(html).toContain("unknown");
    expect(html).toContain(CASE_A);
    expect(html).toContain("APP-01, ATO-02");
    expect(html).toContain("Triaged");
    expect(html).toContain('scope="col"');
    expect(html).toContain("2026-11-05T11:00:00.000001+00:00");
    expect(html).not.toContain(CONTEXT);
    expect(html).not.toContain(SOURCE_A);
  });

  it("preserves supplied rank without inventing a risk score or a case action", () => {
    const response = fixture();
    response.items.push({
      ...response.items[0],
      rank: 2,
      case_id: CASE_B,
      source_event_id: SOURCE_B,
      scenario_ids: ["MM-01", "MM-05"],
      status: "assign",
      revision: 3,
      assignee_ref: ASSIGNEE,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const html = render(response);
      expect(html.indexOf(CASE_A)).toBeLessThan(html.indexOf(CASE_B));
      expect(html).toContain("Assigned");
      expect(html).toContain("MM-01, MM-05");
      expect(html).toContain(ASSIGNEE.slice(0, 12));
      expect(html).not.toContain(ASSIGNEE);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("risk_score");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("renders an empty projection without implying a healthy installed reader", () => {
    const response = fixture();
    response.items = [];
    const html = render(response);
    expect(html).toContain("No open cases in this read-only projection.");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<table");
    expect(html).toContain("authenticated");
  });

  it("refuses a forged executed-Bank-action payload before displaying a row", () => {
    const response = fixture();
    response.items[0].bank_execution = "executed";
    expect(() => render(response)).toThrow("Invalid protected case-queue projection");
    const other = fixture();
    Object.assign(other.items[0], { customer_name: "not-for-view" });
    expect(() => render(other)).toThrow("Invalid protected case-queue projection");
  });
});

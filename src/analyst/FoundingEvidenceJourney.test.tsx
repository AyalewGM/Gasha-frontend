// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProtectedAnalystEntry } from "./ProtectedAnalystEntry";
import { foundingEvidence } from "./foundingEvidence.testFixtures";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const CONTEXT = "c".repeat(64);
const RECORDED = "2026-11-07T10:00:00.000001Z";
const created = {
  revision: 1, previous_revision: null, operation: "create", recorded_at: RECORDED,
  reason_code: "source_evaluation", disposition: null, actor_ref: "a".repeat(64),
  assignee_ref: null, source_event_id: SOURCE, source_context_ref: CONTEXT,
  bank_execution: "unknown",
};
const queue = {
  tenant_scope: "authenticated_reader", ranking_policy_version: "synthetic-v1",
  generated_at: "2026-11-07T12:00:00Z", bank_ranking_approved: false,
  enforcement_activated: false, items: [{
    rank: 1, case_id: CASE, source_event_id: SOURCE, source_context_ref: CONTEXT,
    scenario_ids: ["ATO-02"], status: "create", revision: 1, created_at: RECORDED,
    updated_at: RECORDED, assignee_ref: null, bank_execution: "unknown",
  }],
};
const history = { case_id: CASE, enforcement_activated: false, events: [created] };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(caption: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(caption));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
function fixture(evidence: unknown = foundingEvidence(CASE, CONTEXT)) {
  const events: string[] = [];
  const reader = {
    readQueue: vi.fn(async () => { events.push("queue"); return queue; }),
    readHistory: vi.fn(async () => { events.push("history"); return history; }),
    readFeatureEvidence: vi.fn(async () => { events.push("evidence"); return evidence; }),
  };
  const writer = { submit: vi.fn() };
  return { reader, writer, events, session: { epoch: "synthetic-epoch-1", reader, writer } };
}

it("verifies queue → history → feature evidence before exposing case actions", async () => {
  const f = fixture();
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: f.session })));
  await click("Refresh queue");
  expect(host.textContent).not.toContain("Triage case");
  await click("Open case");
  expect(f.events).toEqual(["queue", "history", "evidence"]);
  expect(host.textContent).toContain("Founding-event evidence");
  expect(host.textContent).toContain("synthetic; not Bank-attested");
  expect(host.textContent).toContain("Eligible observations7");
  expect(host.textContent).toContain("device_ref");
  expect(host.textContent).toContain("Triage case");
  expect(host.textContent).not.toContain("f".repeat(64));
  expect(host.textContent).not.toContain("d".repeat(64));
  expect(f.writer.submit).not.toHaveBeenCalled();
});

it("a missing evidence reader is not a permission to mutate", async () => {
  const f = fixture();
  const reader = { readQueue: f.reader.readQueue, readHistory: f.reader.readHistory };
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "no-feature-reader", reader, writer: f.writer },
  })));
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).not.toContain("Triage case");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain("Revision 1");
  expect(f.writer.submit).not.toHaveBeenCalled();
});

it.each([
  ["foreign case", { case_id: "00000000-0000-4000-8000-000000000051" }],
  ["foreign context", { feature_evidence: { ...foundingEvidence(CASE, CONTEXT).feature_evidence, context_ref: "e".repeat(64) } }],
  ["Bank attestation", { bank_source_attested: true }],
  ["enforcement claim", { enforcement_activated: true }],
  ["duplicate missing signal", { feature_evidence: { ...foundingEvidence(CASE, CONTEXT).feature_evidence, unavailable_signals: ["device_ref", "device_ref"] } }],
  ["unknown signal", { feature_evidence: { ...foundingEvidence(CASE, CONTEXT).feature_evidence, unavailable_signals: ["account_number"] } }],
  ["extra nested authority", { feature_evidence: { ...foundingEvidence(CASE, CONTEXT).feature_evidence, tenant_id: "tenant-b" } }],
  ["coerced counts", { feature_evidence: { ...foundingEvidence(CASE, CONTEXT).feature_evidence, eligible_observations: "7" } }],
] as [string, Record<string, unknown>][] )("rejects %s without rendering or allowing actions", async (_label, mutation) => {
  const f = fixture({ ...foundingEvidence(CASE, CONTEXT), ...mutation });
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: f.session })));
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).not.toContain("Triage case");
  expect(host.textContent).not.toContain("Founding-event evidence —");
  expect(host.textContent).not.toContain("account_number");
  expect(host.textContent).not.toContain("tenant-b");
  expect(f.writer.submit).not.toHaveBeenCalled();
});

it.each([401, 403, 404, 503])("feature-evidence %i failure removes actions and never leaks payloads", async (status) => {
  const f = fixture();
  f.reader.readFeatureEvidence.mockRejectedValueOnce(Object.assign(new Error("confidential_bank_value"), { status }));
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: f.session })));
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).not.toContain("Triage case");
  expect(host.textContent).not.toContain("confidential_bank_value");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(String(status));
  if (status === 503) {
    expect(host.textContent).toContain("Refresh case history");
    await click("Refresh case history");
    expect(host.textContent).toContain("Triage case");
    expect(host.textContent).toContain("Founding-event evidence");
  } else {
    expect(host.textContent).not.toContain("Refresh case history");
  }
});

it("rotation invalidates a late evidence response before it can restore case authority", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  const delayed = new Promise<unknown>((done) => { resolve = done; });
  f.reader.readFeatureEvidence.mockReturnValueOnce(delayed);
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: f.session })));
  await click("Refresh queue");
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Open case"))!;
    button.click();
  });
  expect(host.textContent).not.toContain("Triage case");
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { ...f.session, epoch: "synthetic-epoch-rotated" },
  })));
  await act(async () => resolve(foundingEvidence(CASE, CONTEXT)));
  expect(host.textContent).not.toContain("Triage case");
  expect(host.textContent).not.toContain("Founding-event evidence —");
  expect(f.writer.submit).not.toHaveBeenCalled();
});

it("not-recorded legacy feature envelope is explicit absence, never fabricated zero", async () => {
  const f = fixture({
    ...foundingEvidence(CASE, CONTEXT),
    feature_evidence: {
      ...Object.fromEntries(Object.keys(foundingEvidence(CASE, CONTEXT).feature_evidence).map((k) => [k, null])),
      schema: "gasha-synthetic-case-feature-view-v1", scope: "case_creation_source_only",
      availability: "not_recorded", source_assurance: "not_established", context_ref: CONTEXT,
    },
  });
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: f.session })));
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).toContain("observations were not recorded");
  expect(host.textContent).not.toContain("Eligible observations");
  expect(host.textContent).toContain("Triage case");
});

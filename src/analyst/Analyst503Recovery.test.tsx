// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProtectedAnalystEntry } from "./ProtectedAnalystEntry";
import { foundingEvidence } from "./foundingEvidence.testFixtures";
import type { InstalledProtectedAnalystSession } from "./installedProtectedSession";
import type { CaseTransitionProposal } from "./protectedCaseTransitionPort";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const CONTEXT = "c".repeat(64);
const ACTOR = "a".repeat(64);
const ASSIGNEE = "b".repeat(64);
const at = (minute: string) => `2026-11-07T10:${minute}:00.000001Z`;
const created = {
  revision: 1, previous_revision: null, operation: "create", recorded_at: at("00"),
  reason_code: "source_evaluation", disposition: null, actor_ref: ACTOR,
  assignee_ref: null, source_event_id: SOURCE, source_context_ref: CONTEXT,
  bank_execution: "unknown",
};
const events = [
  created,
  { ...created, revision: 2, previous_revision: 1, operation: "triage",
    reason_code: "analyst_triage", recorded_at: at("01") },
  { ...created, revision: 3, previous_revision: 2, operation: "assign",
    reason_code: "investigation_assigned", assignee_ref: ASSIGNEE, recorded_at: at("02") },
  { ...created, revision: 4, previous_revision: 3, operation: "dispose",
    reason_code: "fraud_evidence", disposition: "confirmed_fraud", recorded_at: at("03") },
  { ...created, revision: 5, previous_revision: 4, operation: "correct",
    reason_code: "corrected_finding", disposition: "confirmed_legitimate", recorded_at: at("04") },
  { ...created, revision: 6, previous_revision: 5, operation: "reconcile",
    reason_code: "feedback_reconciled", recorded_at: at("05") },
];
const assignedQueue = {
  tenant_scope: "authenticated_reader", ranking_policy_version: "synthetic-ranked-v1",
  generated_at: "2026-11-07T12:00:00Z", bank_ranking_approved: false,
  enforcement_activated: false, items: [{
    rank: 1, case_id: CASE, source_event_id: SOURCE, source_context_ref: CONTEXT,
    scenario_ids: ["ATO-02", "MM-01"], status: "assign", revision: 3,
    created_at: at("00"), updated_at: at("02"), assignee_ref: ASSIGNEE,
    bank_execution: "unknown",
  }],
};

let host: HTMLDivElement;
let root: Root;
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  expect(found).toBeTruthy();
  return found!;
}
async function click(label: string) {
  await act(async () => { button(label).click(); });
}
async function mount(session: InstalledProtectedAnalystSession) {
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session })));
}
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

/**
 * Server-owned synthetic fixtures exercise an injected protected port only.
 * No real Bank data, browser credentials, tenant authority or HTTP is installed.
 */
function recoveryFixture() {
  let revision = 3;
  const failures: number[] = [];
  let nextResult: unknown | undefined;
  let deferred: Promise<unknown> | null = null;
  const reader = {
    readFeatureEvidence: vi.fn(async (caseId: string) => foundingEvidence(caseId, CONTEXT)),
    readQueue: vi.fn(async () => ({
      ...assignedQueue, items: revision >= 4 ? [] : assignedQueue.items,
    })),
    readHistory: vi.fn(async () => {
      if (deferred) {
        const pending = deferred;
        deferred = null;
        return pending;
      }
      if (failures.length > 0) {
        throw Object.assign(new Error("confidential customer and tenant fields"), {
          status: failures.shift(),
        });
      }
      if (nextResult !== undefined) {
        const result = nextResult;
        nextResult = undefined;
        return result;
      }
      return { case_id: CASE, enforcement_activated: false, events: events.slice(0, revision) };
    }),
  };
  const writer = {
    submit: vi.fn(async (
      caseId: string, _history: unknown, proposal: CaseTransitionProposal, key: string,
    ) => {
      expect(caseId).toBe(CASE);
      expect(key).toMatch(/^[0-9a-f]{32}$/);
      expect(events[revision].operation).toBe(proposal.operation);
      expect(Object.keys(proposal).every((field) =>
        ["operation", "disposition", "assigneeSelector"].includes(field))).toBe(true);
      revision++;
      const disposition = "disposition" in proposal ? proposal.disposition : null;
      return {
        case_id: CASE, source_event_id: SOURCE, revision,
        operation: proposal.operation, disposition,
        bank_execution: "unknown" as const, enforcement_activated: false as const,
      };
    }),
  };
  const session: InstalledProtectedAnalystSession = {
    epoch: "synthetic-session-a", reader, writer,
  };
  return {
    session, reader, writer,
    fail: (...statuses: number[]) => failures.push(...statuses),
    replaceNext: (result: unknown) => { nextResult = result; },
    delayNext: (promise: Promise<unknown>) => { deferred = promise; },
  };
}

it("recovers a disposed case after 503 when it vanishes from the open queue, then corrects and reconciles", async () => {
  const fixture = recoveryFixture();
  const log = vi.spyOn(console, "log");
  try {
    await mount(fixture.session);
    await click("Refresh queue");
    await click("Open case");
    expect(host.textContent).toContain("Revision 3: assign");

    // The server commits disposition revision 4; only the follow-up GET fails.
    fixture.fail(503, 503);
    await click("Record disposition");
    expect(fixture.writer.submit).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
    expect(host.textContent).not.toContain("Revision 3: assign");
    expect(host.textContent).toContain("Refresh case history");

    // Refreshing the open queue must not destroy the retry-only reference.
    await click("Refresh queue");
    expect(host.textContent).toContain("Open cases on this page: 0");
    expect(host.textContent).toContain("Refresh case history");
    await click("Refresh case history"); // Second 503: still no writes or history.
    expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
    expect(host.textContent).toContain("Refresh case history");
    expect(fixture.writer.submit).toHaveBeenCalledTimes(1);

    await click("Refresh case history"); // Fresh, validated revision 4.
    expect(host.textContent).toContain("Revision 4: dispose");
    const selector = host.querySelector<HTMLSelectElement>('[aria-label="Case actions"] select');
    expect(selector).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(selector, "confirmed_legitimate");
      selector!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Correct disposition");
    expect(host.textContent).toContain("Revision 5: correct");
    await click("Reconcile feedback");
    expect(host.textContent).toContain("Revision 6: reconcile");
    expect(fixture.writer.submit.mock.calls.map((call) => call[2].operation)).toEqual([
      "dispose", "correct", "reconcile",
    ]);
    expect(host.textContent).not.toContain("confidential customer");
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it("a manual history 503 on an already disposed case is retry-only, never a permission to write", async () => {
  const fixture = recoveryFixture();
  await mount(fixture.session);
  await click("Refresh queue");
  await click("Open case");
  await click("Record disposition");
  expect(host.textContent).toContain("Revision 4: dispose");
  fixture.fail(503);
  await click("Refresh case history");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain("Revision 4: dispose");
  expect(host.textContent).toContain("Refresh case history");
  expect(fixture.writer.submit).toHaveBeenCalledTimes(1);
  await click("Refresh case history");
  expect(host.textContent).toContain("Revision 4: dispose");
  expect(host.textContent).toContain("Reconcile feedback");
  expect(fixture.writer.submit).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 404])("a %i denial after retry-only 503 destroys the case reference", async (status) => {
  const fixture = recoveryFixture();
  await mount(fixture.session);
  await click("Refresh queue");
  await click("Open case");
  fixture.fail(503, status);
  await click("Refresh case history");
  expect(host.textContent).toContain("Refresh case history");
  await click("Refresh case history");
  expect(host.textContent).not.toContain("Refresh case history");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain(CASE);
  expect(host.textContent).not.toContain("confidential customer");
  expect(fixture.writer.submit).not.toHaveBeenCalled();
});

it("a malformed recovery response cannot restore an actionable case or retry handle", async () => {
  const fixture = recoveryFixture();
  await mount(fixture.session);
  await click("Refresh queue");
  await click("Open case");
  fixture.fail(503);
  await click("Refresh case history");
  fixture.replaceNext({
    case_id: CASE, enforcement_activated: false,
    events: events.slice(0, 3).map((event, index) =>
      index === 0 ? { ...event, source_context_ref: "f".repeat(64) } : event),
  });
  await click("Refresh case history");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh case history");
  expect(host.textContent).not.toContain("confidential customer");
  expect(fixture.writer.submit).not.toHaveBeenCalled();
});

it("late retry history cannot restore an old epoch; logout also erases retry-only state", async () => {
  const fixture = recoveryFixture();
  await mount(fixture.session);
  await click("Refresh queue");
  await click("Open case");
  fixture.fail(503);
  await click("Refresh case history");
  let complete!: (value: unknown) => void;
  fixture.delayNext(new Promise<unknown>((resolve) => { complete = resolve; }));
  await act(async () => { button("Refresh case history").click(); });
  await mount({ ...fixture.session, epoch: "synthetic-session-b" });
  await act(async () => {
    complete({ case_id: CASE, enforcement_activated: false, events: events.slice(0, 3) });
  });
  expect(host.textContent).not.toContain(CASE);
  expect(host.textContent).not.toContain("Revision 3");
  expect(host.textContent).not.toContain("Refresh case history");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  await click("Refresh queue");
  await click("Open case");
  fixture.fail(503);
  await click("Refresh case history");
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: null })));
  expect(host.textContent).toContain("No trusted analyst session");
  expect(host.textContent).not.toContain("Refresh case history");
  expect(host.textContent).not.toContain(CASE);
  expect(fixture.writer.submit).not.toHaveBeenCalled();
});

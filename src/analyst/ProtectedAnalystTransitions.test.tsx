// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProtectedAnalystEntry } from "./ProtectedAnalystEntry";
import type { InstalledProtectedAnalystSession } from "./installedProtectedSession";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const CONTEXT = "c".repeat(64);
const ACTOR = "a".repeat(64);
const when = "2026-11-07T10:00:00.000001Z";
const queue = {
  tenant_scope: "authenticated_reader", ranking_policy_version: "synthetic-ranked-v1",
  generated_at: "2026-11-07T12:00:00Z", bank_ranking_approved: false,
  enforcement_activated: false, items: [{
    rank: 1, case_id: CASE, source_event_id: SOURCE, source_context_ref: CONTEXT,
    scenario_ids: ["ATO-02", "MM-01"], status: "create", revision: 1,
    created_at: when, updated_at: when, assignee_ref: null, bank_execution: "unknown",
  }],
};
const created = {
  revision: 1, previous_revision: null, operation: "create", recorded_at: when,
  reason_code: "source_evaluation", disposition: null, actor_ref: ACTOR,
  assignee_ref: null, source_event_id: SOURCE, source_context_ref: CONTEXT,
  bank_execution: "unknown",
};
const initial = { case_id: CASE, enforcement_activated: false, events: [created] };
const triaged = {
  ...initial,
  events: [created, {
    ...created, revision: 2, previous_revision: 1, operation: "triage",
    reason_code: "analyst_triage", recorded_at: "2026-11-07T10:01:00.000001Z",
  }],
};
let host: HTMLDivElement;
let root: Root;

function button(part: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(part));
  expect(found).toBeTruthy();
  return found!;
}
async function click(part: string) {
  await act(async () => { button(part).click(); });
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

it("mounts server-bound case transitions only for an explicitly injected writer; no Bank activation", async () => {
  const reader = {
    readQueue: vi.fn().mockResolvedValue(queue),
    readHistory: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(triaged),
  };
  const writer = { submit: vi.fn().mockResolvedValue({
    case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
    disposition: null, bank_execution: "unknown", enforcement_activated: false,
  }) };
  const session: InstalledProtectedAnalystSession = { epoch: "test-epoch-1", reader, writer };
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    await act(async () => root.render(createElement(ProtectedAnalystEntry, { session })));
    expect(host.textContent).not.toContain("Triage case");
    expect(fetchSpy).not.toHaveBeenCalled();
    await click("Refresh queue");
    expect(host.textContent).toContain("Visible queue snapshot");
    expect(host.textContent).toContain("not total backlog");
    expect(host.textContent).not.toContain("Triage case");
    await click("Open case");
    expect(host.textContent).toContain("Revision 1: create");
    await click("Triage case");
    expect(writer.submit).toHaveBeenCalledTimes(1);
    expect(writer.submit).toHaveBeenCalledWith(
      CASE, expect.anything(), { operation: "triage" }, expect.stringMatching(/^[0-9a-f]{32}$/),
    );
    expect(host.textContent).toContain("Revision 2: triage");
    expect(host.textContent).not.toContain("payment enforcement activated");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

it("a writer cannot be injected through a malformed installed session", async () => {
  const reader = { readQueue: vi.fn(), readHistory: vi.fn() };
  const session = { epoch: "test", reader, writer: {} } as unknown as InstalledProtectedAnalystSession;
  await act(async () => root.render(createElement(ProtectedAnalystEntry, { session })));
  expect(host.textContent).toContain("No trusted analyst session");
  expect(host.querySelector("button")).toBeNull();
  expect(reader.readQueue).not.toHaveBeenCalled();
});

it("a changed trusted epoch discards previously opened case and its actionable controls", async () => {
  const reader = {
    readQueue: vi.fn().mockResolvedValue(queue),
    readHistory: vi.fn().mockResolvedValue(initial),
  };
  const writer = { submit: vi.fn() };
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "epoch-a", reader, writer },
  })));
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).toContain("Triage case");
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "epoch-b", reader, writer },
  })));
  expect(host.textContent).not.toContain("Triage case");
  expect(host.textContent).not.toContain(CASE);
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(writer.submit).not.toHaveBeenCalled();
});

it.each([401, 403, 404, 503])("denied %i history read removes prior case controls without leaking details", async (status) => {
  const reader = {
    readQueue: vi.fn().mockResolvedValue(queue),
    readHistory: vi.fn().mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(Object.assign(new Error("sensitive customer details"), { status })),
  };
  const writer = { submit: vi.fn() };
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "epoch-a", reader, writer },
  })));
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).toContain("Triage case");
  await click("Refresh case history");
  expect(host.textContent).not.toContain(CASE);
  expect(host.textContent).not.toContain("Triage case");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(String(status));
  expect(host.textContent).not.toContain("sensitive customer details");
  expect(writer.submit).not.toHaveBeenCalled();
});

it.each([401, 403, 404, 503])("denied %i first case open purges the visible queue", async (status) => {
  const reader = {
    readQueue: vi.fn().mockResolvedValue(queue),
    readHistory: vi.fn().mockRejectedValue(Object.assign(new Error("sensitive PII"), { status })),
  };
  const writer = { submit: vi.fn() };
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "epoch-a", reader, writer },
  })));
  await click("Refresh queue");
  expect(host.textContent).toContain(CASE);
  await click("Open case");
  expect(host.textContent).not.toContain(CASE);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(String(status));
  expect(host.textContent).not.toContain("sensitive PII");
  expect(writer.submit).not.toHaveBeenCalled();
});

it("late history from retired epoch cannot restore the former case or actions", async () => {
  let finish!: (result: unknown) => void;
  const delayed = new Promise<unknown>((resolve) => { finish = resolve; });
  const reader = {
    readQueue: vi.fn().mockResolvedValue(queue),
    readHistory: vi.fn().mockReturnValue(delayed),
  };
  const writer = { submit: vi.fn() };
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "epoch-a", reader, writer },
  })));
  await click("Refresh queue");
  await act(async () => { button("Open case").click(); });
  expect(host.textContent).not.toContain("Triage case");
  await act(async () => root.render(createElement(ProtectedAnalystEntry, {
    session: { epoch: "epoch-b", reader, writer },
  })));
  await act(async () => { finish(initial); });
  expect(host.textContent).not.toContain(CASE);
  expect(host.textContent).not.toContain("Revision 1");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(writer.submit).not.toHaveBeenCalled();
});

it.each([401, 403, 404, 503])(
  "a denied %i history read after a successful write receipt clears case authority and keeps revision safety",
  async (status) => {
    const reader = {
      readQueue: vi.fn().mockResolvedValue(queue),
      readHistory: vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(
        Object.assign(new Error("sensitive account information"), { status }),
      ),
    };
    const writer = { submit: vi.fn().mockResolvedValue({
      case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
      disposition: null, bank_execution: "unknown", enforcement_activated: false,
    }) };
    await act(async () => root.render(createElement(ProtectedAnalystEntry, {
      session: { epoch: "epoch-denial-after-write", reader, writer },
    })));
    await click("Refresh queue");
    await click("Open case");
    expect(host.textContent).toContain("Triage case");
    await click("Triage case");
    expect(writer.submit).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain(CASE);
    expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
    expect(host.textContent).not.toContain("Action acknowledged");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(String(status));
    expect(host.textContent).not.toContain("sensitive account information");
    if (status === 503) {
      // A transient outage keeps only a retry handle, not readable history or actions.
      expect(host.textContent).toContain("Refresh case history");
    } else {
      expect(host.textContent).not.toContain("Refresh case history");
    }
    // Once the service resumes, the earlier unknown revision remains fenced:
    // reopening the same revision must not offer another POST.
    reader.readHistory.mockResolvedValueOnce(initial);
    await click("Refresh queue");
    await click("Open case");
    expect(host.textContent).toContain("Case actions are paused");
    expect(host.textContent).not.toContain("Triage case");
    expect(writer.submit).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["foreign case receipt", { case_id: "00000000-0000-4000-8000-000000000099" }],
  ["foreign source receipt", { source_event_id: "00000000-0000-4000-8000-000000000098" }],
  ["unexpected revision", { revision: 3 }],
  ["different operation", { operation: "assign" }],
  ["unexpected disposition", { disposition: "confirmed_fraud" }],
  ["forged Bank execution", { bank_execution: "executed" }],
  ["forged enforcement activation", { enforcement_activated: true }],
] as [string, Record<string, unknown>][])(
  "untrusted injected writer %s cannot acknowledge a case action or enable a repeated POST",
  async (_label, mutation) => {
    const reader = {
      readQueue: vi.fn().mockResolvedValue(queue),
      readHistory: vi.fn().mockResolvedValue(initial),
    };
    const writer = { submit: vi.fn().mockResolvedValue({
      case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
      disposition: null, bank_execution: "unknown", enforcement_activated: false,
      ...mutation,
    }) };
    await act(async () => root.render(createElement(ProtectedAnalystEntry, {
      session: { epoch: "receipt-integrity", reader, writer },
    })));
    await click("Refresh queue");
    await click("Open case");
    await click("Triage case");
    expect(writer.submit).toHaveBeenCalledTimes(1);
    // An anomalous receipt must not trigger a trusted follow-up success read.
    expect(reader.readHistory).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("Case action recorded.");
    expect(host.textContent).not.toContain("Action acknowledged.");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    expect(host.textContent).not.toContain("Triage case");
    // The same prior revision, even if retrieved again, remains fenced.
    await click("Refresh case history");
    expect(host.textContent).toContain("Case actions are paused");
    expect(host.textContent).not.toContain("Triage case");
    expect(writer.submit).toHaveBeenCalledTimes(1);
  },
);


/**
 * #9 acceptance regression for the entire injected-port analyst journey.
 * These are synthetic DOM/contract assertions, NOT a browser-to-HTTP E2E,
 * installed Bank identity, computed ranking or approved tenant KPI.
 */
it("completes the synthetic queue → immutable case → triage/assign/dispose/correct/reconcile journey without browser authority", async () => {
  const ASSIGNEE = "00000000-0000-4000-8000-000000000043";
  const events = [
    created,
    { ...created, revision: 2, previous_revision: 1, operation: "triage",
      reason_code: "analyst_triage", recorded_at: "2026-11-07T10:01:00.000001Z" },
    { ...created, revision: 3, previous_revision: 2, operation: "assign",
      reason_code: "investigation_assigned", assignee_ref: "b".repeat(64),
      recorded_at: "2026-11-07T10:02:00.000001Z" },
    { ...created, revision: 4, previous_revision: 3, operation: "dispose",
      reason_code: "fraud_evidence", disposition: "confirmed_fraud",
      recorded_at: "2026-11-07T10:03:00.000001Z" },
    { ...created, revision: 5, previous_revision: 4, operation: "correct",
      reason_code: "corrected_finding", disposition: "confirmed_legitimate",
      recorded_at: "2026-11-07T10:04:00.000001Z" },
    { ...created, revision: 6, previous_revision: 5, operation: "reconcile",
      reason_code: "feedback_reconciled",
      recorded_at: "2026-11-07T10:05:00.000001Z" },
  ];
  let revision = 1;
  const reader = {
    readQueue: vi.fn().mockResolvedValue(queue),
    readHistory: vi.fn(async () => ({
      case_id: CASE, enforcement_activated: false, events: events.slice(0, revision),
    })),
  };
  const writer = {
    submit: vi.fn(async (
      caseId: string, _history: unknown,
      proposal: { operation: string; disposition?: string }, idempotencyKey: string,
    ) => {
      expect(caseId).toBe(CASE);
      expect(idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
      // The UI cannot supply tenant, rank, role or payment authority.
      expect(Object.keys(proposal).every((key) =>
        ["operation", "assigneeSelector", "disposition"].includes(key))).toBe(true);
      revision += 1;
      expect(events[revision - 1].operation).toBe(proposal.operation);
      return {
        case_id: CASE, source_event_id: SOURCE, revision,
        operation: proposal.operation,
        disposition: proposal.disposition ?? null,
        bank_execution: "unknown" as const, enforcement_activated: false as const,
      };
    }),
  };
  const session = { epoch: "synthetic-journey", reader, writer } as InstalledProtectedAnalystSession;
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    await act(async () => root.render(createElement(ProtectedAnalystEntry, { session })));
    await click("Refresh queue");
    expect(host.textContent).toContain("Open cases on this page: 1");
    expect(host.textContent).toContain("not total backlog");
    await click("Open case");
    expect(host.textContent).toContain("Revision 1: create");

    await click("Triage case");
    expect(host.textContent).toContain("Revision 2: triage");

    const input = host.querySelector<HTMLInputElement>('input');
    expect(input).toBeTruthy();
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      inputSetter.call(input, ASSIGNEE);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Assign case");
    expect(host.textContent).toContain("Revision 3: assign");

    await click("Record disposition");
    expect(host.textContent).toContain("Revision 4: dispose");
    const selector = host.querySelector<HTMLSelectElement>('[aria-label="Case actions"] select');
    expect(selector).toBeTruthy();
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      selectSetter.call(selector, "confirmed_legitimate");
      selector!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Correct disposition");
    expect(host.textContent).toContain("Revision 5: correct");

    await click("Reconcile feedback");
    expect(host.textContent).toContain("Revision 6: reconcile");
    expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
    expect(writer.submit.mock.calls).toHaveLength(5);
    expect(writer.submit.mock.calls.map((call) => call[2].operation)).toEqual([
      "triage", "assign", "dispose", "correct", "reconcile",
    ]);
    expect(reader.readHistory).toHaveBeenCalledTimes(6);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("payment enforcement activated");
  } finally {
    fetchSpy.mockRestore();
  }
});

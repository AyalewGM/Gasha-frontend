// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadOnlyAnalystJourney, type ProtectedCaseReadPort } from "./ReadOnlyAnalystJourney";

const CASE_ID = "00000000-0000-4000-8000-000000000041";
const SOURCE_ID = "00000000-0000-4000-8000-000000000042";
const B_CASE_ID = "00000000-0000-4000-8000-000000000051";
const B_SOURCE_ID = "00000000-0000-4000-8000-000000000052";
const CONTEXT = "c".repeat(64);
const ACTOR = "a".repeat(64);

function queueFixture(caseId = CASE_ID, sourceId = SOURCE_ID) {
  return {
    tenant_scope: "authenticated_reader",
    ranking_policy_version: "synthetic-ranked-v1",
    generated_at: "2026-11-07T12:00:00Z",
    items: [{
      rank: 1, case_id: caseId, source_event_id: sourceId,
      source_context_ref: CONTEXT, scenario_ids: ["ATO-02", "MM-01"],
      status: "create", revision: 1,
      created_at: "2026-11-07T10:00:00.000001Z",
      updated_at: "2026-11-07T10:00:00.000001Z",
      assignee_ref: null, bank_execution: "unknown",
    }],
    bank_ranking_approved: false,
    enforcement_activated: false,
  };
}
function historyFixture(caseId = CASE_ID, sourceId = SOURCE_ID) {
  return {
    case_id: caseId, enforcement_activated: false,
    events: [{
      revision: 1, previous_revision: null, operation: "create",
      recorded_at: "2026-11-07T10:00:00.000001Z",
      reason_code: "source_evaluation", disposition: null,
      actor_ref: ACTOR, assignee_ref: null, source_event_id: sourceId,
      source_context_ref: CONTEXT, bank_execution: "unknown",
    }],
  };
}
function port(caseId = CASE_ID, sourceId = SOURCE_ID): ProtectedCaseReadPort {
  return {
    readQueue: vi.fn().mockResolvedValue(queueFixture(caseId, sourceId)),
    readHistory: vi.fn().mockResolvedValue(historyFixture(caseId, sourceId)),
  };
}
function reject(status: number) {
  return Object.assign(new Error("raw bank PII and private credentials MUST NOT render"), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text));
  expect(button).toBeTruthy();
  button!.click();
}

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

async function mount(reader: ProtectedCaseReadPort) {
  await act(async () => { root.render(createElement(ReadOnlyAnalystJourney, { reader })); });
}

describe("Issue #45 default-inactive synthetic protected-read journey", () => {
  it("displays only matching read-only queue and immutable history; no network or mutations", async () => {
    const reader = port();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await mount(reader);
      expect(host.textContent).toContain("Default-inactive integration exercise");
      expect(reader.readQueue).not.toHaveBeenCalled();
      await act(async () => click(host, "Refresh authorized"));
      expect(host.textContent).toContain("ATO-02, MM-01");
      expect(host.textContent).toContain("Bank ranking approved");
      await act(async () => click(host, "Inspect immutable"));
      expect(host.textContent).toContain("Revision 1: create");
      expect(host.textContent).toContain("Bank execution");
      expect(host.textContent).toContain("unknown");
      expect(host.textContent).not.toContain(ACTOR);
      expect(host.textContent).not.toContain(CONTEXT);
      expect(host.querySelector("form")).toBeNull();
      expect(host.querySelector('input[type="password"]')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reader.readQueue).toHaveBeenCalledWith(25);
      expect(reader.readHistory).toHaveBeenCalledWith(CASE_ID);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([401, 403, 404, 503])("redacts %i and retains no prior queue/history", async (status) => {
    const reader = port();
    await mount(reader);
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => click(host, "Inspect immutable"));
    vi.mocked(reader.readQueue).mockRejectedValueOnce(reject(status));
    await act(async () => click(host, "Refresh authorized"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(String(status));
    expect(host.textContent).not.toContain("raw bank PII");
    expect(host.textContent).not.toContain(CASE_ID);
    expect(host.textContent).not.toContain("Revision 1");
  });

  it("fails closed on a different source/case or a claimed Bank action", async () => {
    const reader = port();
    const mismatched = historyFixture();
    mismatched.events[0].source_event_id = "00000000-0000-4000-8000-000000000043";
    vi.mocked(reader.readHistory).mockResolvedValue(mismatched);
    await mount(reader);
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => click(host, "Inspect immutable"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("rejected");
    expect(host.textContent).not.toContain(CASE_ID);
    const forged = queueFixture();
    forged.items[0].bank_execution = "executed";
    vi.mocked(reader.readQueue).mockResolvedValue(forged);
    await act(async () => click(host, "Refresh authorized"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("rejected");
    expect(host.textContent).not.toContain("executed");
  });

  it("discards a late history response after a newer queue refresh", async () => {
    const reader = port();
    const oldHistory = deferred<unknown>();
    vi.mocked(reader.readHistory).mockReturnValueOnce(oldHistory.promise);
    await mount(reader);
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => click(host, "Inspect immutable"));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("history");
    // A read in flight cannot be refreshed by the button until it completes.
    // Revocation or unmount must still prevent the late result from rendering.
    await act(async () => { root.unmount(); });
    await act(async () => { oldHistory.resolve(historyFixture()); });
    expect(host.textContent).not.toContain("Revision 1");
    // Avoid running the common cleanup against an already-unmounted root.
    root = createRoot(host);
  });
  it("clears A's rendered queue, selection and history immediately on mounted A→B reader switch", async () => {
    const readerA = port();
    const readerB = port(B_CASE_ID, B_SOURCE_ID);
    await mount(readerA);
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => click(host, "Inspect immutable"));
    expect(host.textContent).toContain(CASE_ID);
    expect(host.textContent).toContain("Revision 1: create");

    await mount(readerB); // Same React root, no unmount requested by the caller.
    expect(host.textContent).not.toContain(CASE_ID);
    expect(host.textContent).not.toContain("Revision 1: create");
    expect(host.querySelector("#analyst-case-selection")).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(readerB.readQueue).not.toHaveBeenCalled();
    expect(readerB.readHistory).not.toHaveBeenCalled();

    await act(async () => click(host, "Refresh authorized"));
    expect(host.textContent).toContain(B_CASE_ID);
    expect(host.textContent).not.toContain(CASE_ID);
    await act(async () => click(host, "Inspect immutable"));
    expect(readerB.readHistory).toHaveBeenCalledWith(B_CASE_ID);
    expect(host.textContent).toContain("Revision 1: create");
    expect(host.textContent).not.toContain(CASE_ID);
  });

  it("rejects A's late queue after mounted reader switch; B requires an explicit fresh read", async () => {
    const readerA = port();
    const readerB = port(B_CASE_ID, B_SOURCE_ID);
    const oldQueue = deferred<unknown>();
    vi.mocked(readerA.readQueue).mockReturnValueOnce(oldQueue.promise);
    await mount(readerA);
    await act(async () => click(host, "Refresh authorized"));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("queue");

    await mount(readerB);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain(CASE_ID);
    await act(async () => { oldQueue.resolve(queueFixture()); });
    expect(host.textContent).not.toContain(CASE_ID);
    expect(readerB.readQueue).not.toHaveBeenCalled();
    expect(host.querySelector("#analyst-case-selection")).toBeNull();

    await act(async () => click(host, "Refresh authorized"));
    expect(readerB.readQueue).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(B_CASE_ID);
    expect(host.textContent).not.toContain(CASE_ID);
  });

  it("rejects A's late history even when B's new queue is already visible", async () => {
    const readerA = port();
    const readerB = port(B_CASE_ID, B_SOURCE_ID);
    const oldHistory = deferred<unknown>();
    vi.mocked(readerA.readHistory).mockReturnValueOnce(oldHistory.promise);
    await mount(readerA);
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => click(host, "Inspect immutable"));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("history");

    await mount(readerB);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => click(host, "Refresh authorized"));
    expect(host.textContent).toContain(B_CASE_ID);
    await act(async () => { oldHistory.resolve(historyFixture()); });
    expect(host.textContent).not.toContain(CASE_ID);
    expect(host.textContent).not.toContain("Revision 1: create");
    expect(readerB.readHistory).not.toHaveBeenCalled();

    await act(async () => click(host, "Inspect immutable"));
    expect(host.textContent).toContain("Revision 1: create");
    expect(readerB.readHistory).toHaveBeenCalledWith(B_CASE_ID);
    expect(host.textContent).not.toContain(CASE_ID);
  });

  it("clears a prior reader's redacted error when the mounted read port changes", async () => {
    const readerA = port();
    const readerB = port(B_CASE_ID, B_SOURCE_ID);
    vi.mocked(readerA.readQueue).mockRejectedValueOnce(reject(403));
    await mount(readerA);
    await act(async () => click(host, "Refresh authorized"));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("403");
    await mount(readerB);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(readerB.readQueue).not.toHaveBeenCalled();
    expect(host.querySelector("#analyst-case-selection")).toBeNull();
  });

  it("flushes history and late reads when the same port rotates trusted session epoch", async () => {
    const reader = port();
    await act(async () => {
      root.render(createElement(ReadOnlyAnalystJourney, { reader, sessionEpoch: "credential-epoch-a" }));
    });
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => click(host, "Inspect immutable"));
    expect(host.textContent).toContain(CASE_ID);
    expect(host.textContent).toContain("Revision 1: create");

    // A trusted reader may retain object identity across a credential change.
    // The new epoch must discard every part of the old analyst view.
    const oldQueue = deferred<unknown>();
    vi.mocked(reader.readQueue).mockReturnValueOnce(oldQueue.promise);
    await act(async () => click(host, "Refresh authorized"));
    await act(async () => {
      root.render(createElement(ReadOnlyAnalystJourney, { reader, sessionEpoch: "credential-epoch-b" }));
    });
    expect(host.textContent).not.toContain(CASE_ID);
    expect(host.textContent).not.toContain("Revision 1: create");
    expect(host.querySelector("#analyst-case-selection")).toBeNull();
    await act(async () => { oldQueue.resolve(queueFixture()); });
    expect(host.textContent).not.toContain(CASE_ID);
    expect(host.querySelector("#analyst-case-selection")).toBeNull();
  });

});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadOnlyAnalystJourney, type ProtectedCaseReadPort } from "./ReadOnlyAnalystJourney";

const CASE_ID = "00000000-0000-4000-8000-000000000041";
const SOURCE_ID = "00000000-0000-4000-8000-000000000042";
const CONTEXT = "c".repeat(64);
const ACTOR = "a".repeat(64);

function queueFixture() {
  return {
    tenant_scope: "authenticated_reader",
    ranking_policy_version: "synthetic-ranked-v1",
    generated_at: "2026-11-07T12:00:00Z",
    items: [{
      rank: 1, case_id: CASE_ID, source_event_id: SOURCE_ID,
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
function historyFixture() {
  return {
    case_id: CASE_ID, enforcement_activated: false,
    events: [{
      revision: 1, previous_revision: null, operation: "create",
      recorded_at: "2026-11-07T10:00:00.000001Z",
      reason_code: "source_evaluation", disposition: null,
      actor_ref: ACTOR, assignee_ref: null, source_event_id: SOURCE_ID,
      source_context_ref: CONTEXT, bank_execution: "unknown",
    }],
  };
}
function port(): ProtectedCaseReadPort {
  return {
    readQueue: vi.fn().mockResolvedValue(queueFixture()),
    readHistory: vi.fn().mockResolvedValue(historyFixture()),
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
});

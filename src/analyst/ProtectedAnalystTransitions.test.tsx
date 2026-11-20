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
    expect(host.textContent).not.toContain("Refresh case history");
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

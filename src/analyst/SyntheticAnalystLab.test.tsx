// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyntheticAnalystLab } from "./SyntheticAnalystLab";
import { foundingEvidence } from "./foundingEvidence.testFixtures";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const CONTEXT = "c".repeat(64);
const AT = "2026-11-15T00:00:00Z";
const CREDENTIAL = "synthetic-test-credential";
const PATH = `/__gasha_analyst_lab/v1/tenants/tenant-a/cases`;
const INITIAL = {
  revision: 1, previous_revision: null, operation: "create", recorded_at: AT,
  reason_code: "source_evaluation", disposition: null, actor_ref: "a".repeat(64),
  assignee_ref: null, source_event_id: SOURCE, source_context_ref: CONTEXT,
  bank_execution: "unknown",
};

function queue() {
  return {
    tenant_scope: "authenticated_reader", ranking_policy_version: "synthetic-v1",
    generated_at: AT, bank_ranking_approved: false, enforcement_activated: false,
    items: [{
      rank: 1, case_id: CASE, source_event_id: SOURCE, source_context_ref: CONTEXT,
      scenario_ids: ["MM-02"], status: "create", revision: 1, created_at: AT, updated_at: AT,
      assignee_ref: null, bank_execution: "unknown",
    }],
  };
}

function history(triaged = false) {
  return {
    case_id: CASE, enforcement_activated: false,
    events: triaged ? [INITIAL, {
      ...INITIAL, revision: 2, previous_revision: 1, operation: "triage", reason_code: "analyst_triage",
    }] : [INITIAL],
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Synthetic lab HTTP fixture: only feature-evidence GETs are generated from a
 * known synthetic envelope. Ordinary queued GET/POST responses remain explicit.
 * The request spy retains the real per-request path for gate assertions.
 */
function spyLabFetch() {
  const planned = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    void input;
    void init;
    return Promise.reject(new Error("Unexpected synthetic lab request"));
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/feature-evidence")) {
      const caseId = url.split("/").at(-2) ?? "";
      return Promise.resolve(json(foundingEvidence(caseId, CONTEXT)));
    }
    return planned(input, init);
  });
  return planned;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SyntheticAnalystLab)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function click(caption: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === caption);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

async function enterSession() {
  const input = host.querySelector<HTMLInputElement>("input[type=password]")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, CREDENTIAL);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Open synthetic session");
}

it("opens only user-selected synthetic cases and reloads authenticated history after a write", async () => {
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(queue()))
    .mockResolvedValueOnce(json(history()))
    .mockResolvedValueOnce(json({
      case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
      disposition: null, bank_execution: "unknown", enforcement_activated: false,
    }))
    .mockResolvedValueOnce(json(history(true)));
  await enterSession();
  expect(fetchMock).not.toHaveBeenCalled();
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).toContain("Revision 1: create");
  await click("Triage case");
  expect(host.textContent).toContain("Revision 2: triage");
  expect(host.textContent).toContain("Case action recorded.");
  expect(host.textContent).not.toContain(CREDENTIAL);
  const expectedHistoryPath = `${PATH}/${CASE}/history`;
  expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
    `${PATH}/queue?limit=25`, expectedHistoryPath, `${PATH}/${CASE}/transitions/triage`, expectedHistoryPath,
  ]);
  const write = fetchMock.mock.calls[2][1]!;
  expect(write).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
  expect(new Headers(write.headers).get("Authorization")).toBe(`Bearer ${CREDENTIAL}`);
  expect(JSON.parse(write.body as string)).toMatchObject({
    source_event_id: SOURCE, expected_revision: 1, reason_code: "analyst_triage",
  });
  await click("End session");
  expect(host.textContent).not.toContain(CASE);
});

it("requires a history refresh after a conflict and retires the complete session on 401", async () => {
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(queue()))
    .mockResolvedValueOnce(json(history()))
    .mockResolvedValueOnce(json({ detail: "sensitive conflict detail" }, 409))
    .mockResolvedValueOnce(json({ detail: "sensitive credential detail" }, 401));
  await enterSession();
  await click("Refresh queue");
  await click("Open case");
  await click("Triage case");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Refresh its history");
  expect(host.textContent).not.toContain("Triage case");
  expect(host.textContent).not.toContain("sensitive");
  await click("Refresh case history");
  expect(host.textContent).toContain("Synthetic session expired or was rejected.");
  expect(host.textContent).not.toContain(CASE);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("blocks a fresh idempotency key while an uncertain write may still be processing", async () => {
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(queue()))
    .mockResolvedValueOnce(json(history()))
    .mockRejectedValueOnce(new Error("lost response after dispatch"))
    .mockResolvedValueOnce(json(history()))
    .mockResolvedValueOnce(json(history(true)));
  await enterSession();
  await click("Refresh queue");
  await click("Open case");
  await click("Triage case");
  expect(host.textContent).toContain("Case actions are paused");
  await click("Refresh case history");
  expect(host.textContent).toContain("Revision 1: create");
  expect(host.textContent).not.toContain("Triage case");
  expect(host.textContent).toContain("Case actions are paused");
  await click("Refresh case history");
  expect(host.textContent).toContain("Revision 2: triage");
  expect(host.textContent).toContain("Assign case");
  expect(host.textContent).not.toContain("Case actions are paused");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

const OTHER_CASE = "00000000-0000-4000-8000-000000000051";
const OTHER_SOURCE = "00000000-0000-4000-8000-000000000052";

function otherQueue() {
  const result = queue();
  return {
    ...result,
    items: [{ ...result.items[0], case_id: OTHER_CASE, source_event_id: OTHER_SOURCE }],
  };
}

function twoCaseQueue() {
  const result = queue();
  return {
    ...result,
    items: [
      result.items[0],
      { ...result.items[0], rank: 2, case_id: OTHER_CASE, source_event_id: OTHER_SOURCE },
    ],
  };
}

function otherHistory() {
  return {
    ...history(),
    case_id: OTHER_CASE,
    events: [{ ...INITIAL, source_event_id: OTHER_SOURCE }],
  };
}

it("removes A's previously opened case and actions when a refreshed queue omits A", async () => {
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(queue()))
    .mockResolvedValueOnce(json(history()))
    .mockResolvedValueOnce(json({ ...queue(), items: [] }));
  await enterSession();
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).toContain("Triage case");
  await click("Refresh queue");
  expect(host.textContent).not.toContain(CASE);
  expect(host.textContent).not.toContain("Revision 1: create");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh case history");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

it("invalidates A's opened case when the analyst selects B, until B history is verified", async () => {
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(twoCaseQueue()))
    .mockResolvedValueOnce(json(history()))
    .mockResolvedValueOnce(json(otherHistory()));
  await enterSession();
  await click("Refresh queue");
  await click("Open case");
  expect(host.textContent).toContain("Revision 1: create");
  const select = host.querySelector<HTMLSelectElement>('select');
  expect(select).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, OTHER_CASE);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("Revision 1: create");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh case history");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await click("Open case");
  expect(fetchMock.mock.calls[2][0]).toBe(PATH + "/" + OTHER_CASE + "/history");
  expect(host.textContent).toContain("Revision 1: create");
  expect(host.textContent).toContain(OTHER_CASE);
});

it("clears A immediately while a replacement queue GET is delayed; no stale POST can start", async () => {
  let finishQueue!: (response: Response) => void;
  const pendingQueue = new Promise<Response>((resolve) => { finishQueue = resolve; });
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(queue()))
    .mockResolvedValueOnce(json(history()))
    .mockReturnValueOnce(pendingQueue);
  await enterSession();
  await click("Refresh queue");
  await click("Open case");
  await click("Refresh queue");
  expect(host.textContent).not.toContain("Revision 1: create");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(host.textContent).not.toContain("Refresh case history");
  expect(host.textContent).toContain("Protected case request in progress.");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await act(async () => { finishQueue(json(otherQueue())); });
  expect(host.textContent).toContain(OTHER_CASE);
  expect(host.textContent).not.toContain(CASE);
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
});

it("serializes a delayed POST before refresh and never restores old actions after a B-only queue", async () => {
  let finishWrite!: (response: Response) => void;
  const pendingWrite = new Promise<Response>((resolve) => { finishWrite = resolve; });
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json(queue()))
    .mockResolvedValueOnce(json(history()))
    .mockReturnValueOnce(pendingWrite)
    .mockResolvedValueOnce(json(history(true)))
    .mockResolvedValueOnce(json(otherQueue()));
  await enterSession();
  await click("Refresh queue");
  await click("Open case");
  await click("Triage case");
  const refresh = [...host.querySelectorAll("button")].find((b) => b.textContent === "Refresh queue");
  expect(refresh?.disabled).toBe(true);
  await click("Refresh queue"); // Disabled: no overlapping refresh or second write.
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(async () => {
    finishWrite(json({
      case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
      disposition: null, bank_execution: "unknown", enforcement_activated: false,
    }));
  });
  expect(host.textContent).toContain("Revision 2: triage");
  await click("Refresh queue");
  expect(host.textContent).toContain(OTHER_CASE);
  expect(host.textContent).not.toContain(CASE);
  expect(host.textContent).not.toContain("Revision 2: triage");
  expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("keeps a disposed case retry-only after fetch loses the connection; an empty queue cannot strand it", async () => {
  const assignee = "b".repeat(64);
  const assigned = [
    INITIAL,
    { ...INITIAL, revision: 2, previous_revision: 1, operation: "triage",
      reason_code: "analyst_triage" },
    { ...INITIAL, revision: 3, previous_revision: 2, operation: "assign",
      reason_code: "investigation_assigned", assignee_ref: assignee },
  ];
  const disposed = [...assigned, {
    ...INITIAL, revision: 4, previous_revision: 3, operation: "dispose",
    reason_code: "needs_review", disposition: "unresolved",
  }];
  const initialQueue = queue();
  const fetchMock = spyLabFetch()
    .mockResolvedValueOnce(json({
      ...initialQueue,
      items: [{ ...initialQueue.items[0], status: "assign", revision: 3,
        assignee_ref: assignee }],
    }))
    .mockResolvedValueOnce(json({ case_id: CASE, enforcement_activated: false, events: assigned }))
    .mockResolvedValueOnce(json({
      case_id: CASE, source_event_id: SOURCE, revision: 4, operation: "dispose",
      disposition: "unresolved", bank_execution: "unknown", enforcement_activated: false,
    }))
    .mockRejectedValueOnce(new TypeError("synthetic confidential connection failure"))
    .mockResolvedValueOnce(json({ ...initialQueue, items: [] }))
    .mockResolvedValueOnce(json({ case_id: CASE, enforcement_activated: false, events: disposed }));
  const log = vi.spyOn(console, "log");
  try {
    await enterSession();
    await click("Refresh queue");
    await click("Open case");
    expect(host.textContent).toContain("Revision 3: assign");
    // An unlabeled synthetic anomaly must never default to confirmed fraud.
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Case actions"] select')?.value).toBe("unresolved");
    await click("Record disposition");
    const write = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(write).toBeDefined();
    expect(JSON.parse(write![1]!.body as string)).toMatchObject({
      disposition: "unresolved", reason_code: "needs_review",
    });
    expect(host.textContent).not.toContain("Revision 3: assign");
    expect(host.querySelector('[aria-label="Case actions"]')).toBeNull();
    expect(host.textContent).toContain("Refresh case history");
    expect(host.textContent).not.toContain("confidential");
    await click("Refresh queue");
    expect(host.textContent).toContain("Open cases on this page: 0");
    expect(host.textContent).toContain("Refresh case history");
    await click("Refresh case history");
    expect(host.textContent).toContain("Revision 4: dispose");
    expect(host.textContent).toContain("Reconcile feedback");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyntheticAnalystLab } from "./SyntheticAnalystLab";

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
  const fetchMock = vi.spyOn(globalThis, "fetch")
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
  const fetchMock = vi.spyOn(globalThis, "fetch")
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
  const fetchMock = vi.spyOn(globalThis, "fetch")
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

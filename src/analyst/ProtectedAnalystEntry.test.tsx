// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectedAnalystEntry } from "./ProtectedAnalystEntry";
import type { InstalledProtectedAnalystSession } from "./installedProtectedSession";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("Issue #9 default-off protected analyst composition", () => {
  it("fails closed without an installed verifier/reader; never fetches", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      await act(async () => { root.render(createElement(ProtectedAnalystEntry)); });
      expect(host.textContent).toContain("No trusted analyst session is installed");
      expect(host.querySelector("button")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an empty credential epoch instead of mounting a read port", async () => {
    const reader = {
      readQueue: vi.fn().mockResolvedValue({}),
      readHistory: vi.fn().mockResolvedValue({}),
    };
    const invalid: InstalledProtectedAnalystSession = { epoch: "", reader };
    await act(async () => {
      root.render(createElement(ProtectedAnalystEntry, { session: invalid }));
    });
    expect(host.textContent).toContain("No trusted analyst session is installed");
    expect(reader.readQueue).not.toHaveBeenCalled();
    expect(reader.readHistory).not.toHaveBeenCalled();
  });

  it("renders a strictly read-only journey only with an installed session", async () => {
    const reader = {
      readQueue: vi.fn().mockRejectedValue(Object.assign(new Error("secret PII"), { status: 401 })),
      readHistory: vi.fn().mockResolvedValue({}),
    };
    const session: InstalledProtectedAnalystSession = { epoch: "synthetic-session-1", reader };
    await act(async () => {
      root.render(createElement(ProtectedAnalystEntry, { session }));
    });
    expect(host.textContent).toContain("Read-only, server-ordered");
    expect(reader.readQueue).not.toHaveBeenCalled();
    const button = host.querySelector("button");
    expect(button?.textContent).toContain("Refresh authorized");
    await act(async () => { button!.click(); });
    expect(reader.readQueue).toHaveBeenCalledWith(25);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("401");
    expect(host.textContent).not.toContain("secret PII");
    expect(host.querySelector("form")).toBeNull();
    expect(reader.readHistory).not.toHaveBeenCalled();
  });
  it("remounts a writable investigation when a verified host replaces the session with an unchanged epoch", async () => {
    const caseId = "00000000-0000-4000-8000-000000000041";
    const sourceId = "00000000-0000-4000-8000-000000000042";
    const queue = {
      tenant_scope: "authenticated_reader",
      ranking_policy_version: "synthetic-ranked-v1",
      generated_at: "2026-11-05T12:00:00Z",
      bank_ranking_approved: false,
      enforcement_activated: false,
      items: [{
        rank: 1, case_id: caseId, source_event_id: sourceId,
        source_context_ref: "c".repeat(64), scenario_ids: ["ATO-02"],
        status: "triage", revision: 2,
        created_at: "2026-11-05T10:00:00Z",
        updated_at: "2026-11-05T11:00:00Z",
        assignee_ref: null, bank_execution: "unknown",
      }],
    };
    const oldReader = {
      readQueue: vi.fn().mockResolvedValue(queue),
      readHistory: vi.fn(),
    };
    const freshReader = {
      readQueue: vi.fn().mockResolvedValue({ ...queue, items: [] }),
      readHistory: vi.fn(),
    };
    const writer = { submit: vi.fn() };
    const first: InstalledProtectedAnalystSession = {
      epoch: "host-accidentally-reused-epoch", reader: oldReader, writer,
    };
    const rotated: InstalledProtectedAnalystSession = {
      epoch: "host-accidentally-reused-epoch", reader: freshReader, writer,
    };

    await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: first })));
    const refresh = () => [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Refresh queue"),
    )!;
    await act(async () => refresh().click());
    expect(host.textContent).toContain(caseId);
    expect(host.textContent).toContain("Open cases on this page: 1");

    await act(async () => root.render(createElement(ProtectedAnalystEntry, { session: rotated })));
    // No old tenant/case evidence or stale action can survive a host session swap.
    expect(host.textContent).not.toContain(caseId);
    expect(host.textContent).not.toContain("Open cases on this page: 1");
    expect(freshReader.readQueue).not.toHaveBeenCalled();
    await act(async () => refresh().click());
    expect(freshReader.readQueue).toHaveBeenCalledExactlyOnceWith(25);
    expect(oldReader.readQueue).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Open cases on this page: 0");
    expect(host.textContent).not.toContain(caseId);
    expect(writer.submit).not.toHaveBeenCalled();
  });

});

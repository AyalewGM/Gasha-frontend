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
});

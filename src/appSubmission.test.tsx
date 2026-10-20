// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FakeBackend {
  nextDecisionStatus: number;
}

function installFetch(backend: FakeBackend) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health/live")) {
      return jsonResponse(200, { status: "live" });
    }
    if (url.endsWith("/v1/decisions") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        transaction: { tenant_id: string; event_id: string; correlation_id: string };
      };
      if (backend.nextDecisionStatus !== 200) {
        return jsonResponse(backend.nextDecisionStatus, { detail: "backend rejected" });
      }
      return jsonResponse(200, {
        tenant_id: body.transaction.tenant_id,
        event_id: body.transaction.event_id,
        correlation_id: body.transaction.correlation_id,
        action: "review",
        risk_score: 0.5,
        reason_codes: ["RC-1"],
        policy_version: "decision-policy-5",
        configuration_version: "cfg",
        rule_version: "rules",
        decided_at: new Date().toISOString(),
      });
    }
    return jsonResponse(404, { detail: `unhandled: ${url}` });
  });
}

describe("App decision lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let backend: FakeBackend;

  beforeEach(async () => {
    backend = { nextDecisionStatus: 200 };
    vi.stubGlobal("fetch", installFetch(backend));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function clickSubmit() {
    const button = container.querySelector<HTMLButtonElement>("button.submit");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
  }

  it("success A then failure B: B's failure clears A's decision and surfaces the error", async () => {
    await clickSubmit();
    // Success A rendered in the DOM
    const action = container.querySelector(".decision-action");
    expect(action?.textContent).toContain("review");
    expect(action?.classList.contains("action-review")).toBe(true);

    backend.nextDecisionStatus = 500;
    await clickSubmit();

    // Failure B: A's decision must not linger, and the error is shown
    expect(container.querySelector(".decision-action")).toBeNull();
    const error = container.querySelector(".error");
    expect(error?.textContent).toContain("Decision request failed (500)");
  });

  it("pending B replaces A's decision immediately (fail-closed before the fetch resolves)", async () => {
    await clickSubmit();
    expect(container.querySelector(".decision-action")).not.toBeNull();

    // A slow request B: while pending, the panel shows the pending state,
    // not A's stale decision.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            const url = String(input);
            if (url.endsWith("/v1/decisions") && init?.method === "POST") {
              setTimeout(
                () => resolve(jsonResponse(500, { detail: "late failure" })),
                50,
              );
            } else {
              resolve(jsonResponse(200, { status: "live" }));
            }
          }),
      ),
    );

    const button = container.querySelector<HTMLButtonElement>("button.submit")!;
    act(() => {
      button.click();
    });

    // Mid-flight: no stale decision visible
    expect(container.querySelector(".decision-action")).toBeNull();
    expect(container.textContent).toContain("Decision pending");

    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // Failure landed: still no stale decision, error shown, button re-enabled
    expect(container.querySelector(".decision-action")).toBeNull();
    expect(container.querySelector(".error")?.textContent).toContain("500");
    expect(button.disabled).toBe(false);
  });
});

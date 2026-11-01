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
      return jsonResponse(200, { status: "ok" });
    }
    if (url.endsWith("/v1/decisions") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        transaction: { tenant_id: string; event_id: string; correlation_id: string };
        policy: {
          configuration_version: string;
          policy_version: string;
          rule_version: string;
          model_version?: string | null;
        };
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
        policy_version: body.policy.policy_version,
        configuration_version: body.policy.configuration_version,
        rule_version: body.policy.rule_version,
        model_version: body.policy.model_version ?? null,
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

  it("associates each transaction field label with its editable control", () => {
    const labels = Array.from(container.querySelectorAll<HTMLLabelElement>(".row .field > label"));
    expect(labels).toHaveLength(11);
    const ids = new Set<string>();
    for (const label of labels) {
      const control = label.parentElement?.querySelector("input, select");
      expect(control).not.toBeNull();
      expect(label.htmlFor).toBe(control?.id);
      expect(label.control).toBe(control);
      ids.add(label.htmlFor);
    }
    expect(ids.size).toBe(labels.length);
  });

  it("shows the editable UC-03 synthetic device identifier without submitting a request", async () => {
    const picker = container.querySelector<HTMLSelectElement>("#synthetic-scenario")!;
    const requestsBefore = vi.mocked(fetch).mock.calls.length;
    await act(async () => {
      picker.value = "uc03";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const device = container.querySelector<HTMLInputElement>("#tx-device-id");
    expect(device?.value).toBe("synthetic-new-device-03");
    expect(container.querySelector<HTMLLabelElement>('label[for="tx-device-id"]')?.control).toBe(device);
    expect(container.querySelector(".decision-action")).toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requestsBefore);
  });

  it("reports the actual synthetic FastAPI JSON liveness as API up", () => {
    expect(container.querySelector(".health")?.textContent).toBe("API up");
  });

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
              resolve(jsonResponse(200, { status: "ok" }));
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
  it("loading a synthetic preset is local, updates the inputs and clears an earlier recommendation", async () => {
    await clickSubmit();
    expect(container.querySelector(".decision-action")).not.toBeNull();
    const requestsBefore = vi.mocked(fetch).mock.calls.length;
    const picker = container.querySelector<HTMLSelectElement>("#synthetic-scenario")!;
    await act(async () => {
      picker.value = "uc02";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picker.value).toBe("uc02");
    expect(container.textContent).toContain("no cross-bank or receiving-bank records");
    expect(container.querySelector(".risks")?.textContent).toContain("0.98");
    expect(container.querySelector(".decision-action")).toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requestsBefore);
  });

  it("clears a scored preset when switching back to manual without a network request", async () => {
    const picker = container.querySelector<HTMLSelectElement>("#synthetic-scenario")!;
    await act(async () => {
      picker.value = "uc02";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await clickSubmit();
    expect(container.querySelector(".decision-action")).not.toBeNull();
    const requestsBefore = vi.mocked(fetch).mock.calls.length;

    await act(async () => {
      picker.value = "manual";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picker.value).toBe("manual");
    // The selected values remain editable, but they no longer carry an old verdict.
    expect(container.querySelector(".risks")?.textContent).toContain("0.98");
    expect(container.querySelector(".decision-action")).toBeNull();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requestsBefore);
  });

  it("discards an in-flight success when the transaction is edited before the reply", async () => {
    const normalFetch = installFetch(backend);
    let releaseDecision: () => Promise<void> = async () => {
      throw new Error("Decision request was not issued");
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/decisions") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseDecision = async () => {
            resolve(await normalFetch(input, init));
          };
        });
      }
      return normalFetch(input, init);
    }));

    const button = container.querySelector<HTMLButtonElement>("button.submit")!;
    act(() => {
      button.click();
    });
    expect(container.textContent).toContain("Decision pending");

    // Transaction fields remain editable while a synthetic request is pending.
    // The eventual success belongs to the old input snapshot, not this form.
    const beneficiaryType = container.querySelector<HTMLSelectElement>(".row select")!;
    act(() => {
      beneficiaryType.value = "wallet";
      beneficiaryType.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(beneficiaryType.value).toBe("wallet");

    await act(async () => {
      await releaseDecision();
    });
    expect(container.querySelector(".decision-action")).toBeNull();
    expect(container.querySelector(".error")).toBeNull();
    expect(button.disabled).toBe(false);
  });

});

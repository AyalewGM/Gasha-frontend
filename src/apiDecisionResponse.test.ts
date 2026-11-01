import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecision, type DecisionRequest } from "./api";

const validDecision = {
  tenant_id: "synthetic-tenant",
  event_id: "d0615702-503b-4d56-9128-a2b2e55150be",
  correlation_id: "ui-synthetic-test",
  action: "review",
  risk_score: 0.67,
  reason_codes: ["HIGH_VELOCITY_RISK"],
  configuration_version: "synthetic-cfg",
  policy_version: "synthetic-policy",
  rule_version: "synthetic-rules",
  decided_at: "2026-10-31T12:00:00Z",
};

const request = { transaction: {
  tenant_id: validDecision.tenant_id,
  event_id: validDecision.event_id,
  correlation_id: validDecision.correlation_id,
} } as unknown as DecisionRequest;

function stubResponse(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ));
}

afterEach(() => vi.unstubAllGlobals());

describe("synthetic decision HTTP response validation", () => {
  it("accepts and preserves a complete well-formed recommendation", async () => {
    stubResponse(validDecision);
    await expect(createDecision(request)).resolves.toEqual(validDecision);
    expect(fetch).toHaveBeenCalledWith("/api/v1/decisions", expect.objectContaining({
      method: "POST",
      redirect: "error",
    }));
  });

  it.each([
    ["unrecognized action", { ...validDecision, action: "execute_payment" }],
    ["out-of-range risk", { ...validDecision, risk_score: 1.2 }],
    ["non-numeric risk", { ...validDecision, risk_score: "0.67" }],
    ["missing reason codes", { ...validDecision, reason_codes: undefined }],
    ["malformed reason codes", { ...validDecision, reason_codes: ["OK", 7] }],
    ["missing provenance", { ...validDecision, policy_version: null }],
    ["invalid timestamp", { ...validDecision, decided_at: "not-a-timestamp" }],
    ["timezone-naive DST-fold timestamp", { ...validDecision, decided_at: "2026-11-01T01:15:00" }],
    ["timestamp without ISO separator", { ...validDecision, decided_at: "2026-11-01 01:15:00Z" }],
    ["invalid UTC offset", { ...validDecision, decided_at: "2026-11-01T01:15:00+14:30" }],
    ["normalized invalid February day", { ...validDecision, decided_at: "2026-02-30T12:00:00Z" }],
    ["non-leap-year February 29", { ...validDecision, decided_at: "2025-02-29T12:00:00Z" }],
    ["normalized invalid April day with offset", { ...validDecision, decided_at: "2026-04-31T12:00:00+03:00" }],
    ["invalid month", { ...validDecision, decided_at: "2026-13-01T12:00:00Z" }],
    ["invalid zero day", { ...validDecision, decided_at: "2026-01-00T12:00:00Z" }],
    ["invalid hour", { ...validDecision, decided_at: "2026-11-01T24:00:00Z" }],
    ["invalid second", { ...validDecision, decided_at: "2026-11-01T01:15:60Z" }],
    ["unexpected model version", { ...validDecision, model_version: 3 }],
    ["wrong top-level shape", [validDecision]],
  ])("fails closed on %s instead of exposing an invalid recommendation", async (_name, payload) => {
    stubResponse(payload);
    await expect(createDecision(request)).rejects.toThrow("Invalid synthetic decision response");
  });

  it("accepts explicitly offset-aware synthetic provenance across DST fall-back", async () => {
    const withOffset = { ...validDecision, decided_at: "2026-11-01T01:15:00-05:00" };
    stubResponse(withOffset);
    await expect(createDecision(request)).resolves.toEqual(withOffset);
  });

  it("accepts a valid Gregorian leap-day instant with an explicit UTC offset", async () => {
    const leapDay = { ...validDecision, decided_at: "2024-02-29T23:59:59+05:30" };
    stubResponse(leapDay);
    await expect(createDecision(request)).resolves.toEqual(leapDay);
  });

  it("rejects redirects without following them for synthetic decision requests", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("redirect blocked"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createDecision(request)).rejects.toThrow("redirect blocked");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/decisions", expect.objectContaining({
      method: "POST", redirect: "error",
    }));
  });

  it("does not expose untrusted transaction details from a synthetic HTTP error", async () => {
    const untrustedDetail = "synthetic-sensitive-customer-field";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: untrustedDetail }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    await expect(createDecision(request)).rejects.toThrow(/^Decision request failed \(422\)$/);
  });

  it("fails closed when an HTTP 200 contains Vite HTML rather than JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html>SPA fallback</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    ));
    await expect(createDecision(request)).rejects.toThrow("Invalid synthetic decision response");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkHealth } from "./api";

afterEach(() => vi.unstubAllGlobals());

function response(status: number, body: string, contentType = "application/json") {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

describe("synthetic API liveness indicator", () => {
  it("accepts only the synthetic FastAPI /health/live JSON contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, '{"status":"ok"}', "application/json; charset=utf-8"),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkHealth()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/health/live", { redirect: "error" });
  });

  it.each([
    ["Vite SPA HTML fallback", response(200, "<!doctype html><html></html>", "text/html")],
    ["unrelated JSON success", response(200, '{"status":"ready"}')],
    ["JSON array", response(200, '[{"status":"ok"}]')],
    ["invalid JSON", response(200, "{broken")],
    ["server error", response(503, '{"status":"ok"}')],
  ])("does not report API up for %s", async (_description, reply) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
    expect(await checkHealth()).toBe(false);
  });

  it("fails closed on a redirected liveness response", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("redirect blocked"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkHealth()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/health/live", { redirect: "error" });
  });

  it("does not report API up when the synthetic backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await checkHealth()).toBe(false);
  });
});

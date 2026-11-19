import { describe, expect, it } from "vitest";
import { classifyGashaRoute, classifyGashaBrowserRoute, isLoopbackBrowserHost } from "./routeBoundary";

describe("default-off protected versus loopback synthetic route isolation", () => {
  it.each(["/analyst", "/analyst/", "/analyst/cases", "/analyst/cases/123"])(
    "reserves %s for the protected route, including nested and trailing-slash paths",
    (pathname) => expect(classifyGashaRoute(pathname)).toBe("analyst"),
  );

  it.each(["/", "/index.html"])(
    "allows the synthetic console only at %s",
    (pathname) => expect(classifyGashaRoute(pathname)).toBe("synthetic"),
  );

  it.each(["/analyst-old", "/analystx", "/ANALYST", "/%61nalyst",
    "/api/v1/decisions", "/unknown", "/demo", "/index.html/analyst", ""])(
    "fails closed at unknown/ambiguous path %s instead of mounting the synthetic console",
    (pathname) => expect(classifyGashaRoute(pathname)).toBe("unavailable"),
  );
});


describe("synthetic console browser-host isolation", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows the anonymous synthetic console only on canonical loopback host %s",
    (hostname) => {
      expect(isLoopbackBrowserHost(hostname)).toBe(true);
      expect(classifyGashaBrowserRoute("/", hostname)).toBe("synthetic");
      expect(classifyGashaBrowserRoute("/index.html", hostname)).toBe("synthetic");
    },
  );

  it.each([
    "bank.example", "gasha.example", "localhost.example", "127.0.0.1.evil.example",
    "192.168.1.12", "10.0.0.5", "0.0.0.0", "127.0.0.2",
    "::1", "LOCALHOST", "localhost.", "",
  ])("does not mount the synthetic console at non-loopback or ambiguous host %s", (hostname) => {
    expect(isLoopbackBrowserHost(hostname)).toBe(false);
    expect(classifyGashaBrowserRoute("/", hostname)).toBe("unavailable");
    expect(classifyGashaBrowserRoute("/index.html", hostname)).toBe("unavailable");
  });

  it("keeps the analyst route reserved and unknown paths refused across hosts", () => {
    expect(classifyGashaBrowserRoute("/analyst", "bank.example")).toBe("analyst");
    expect(classifyGashaBrowserRoute("/analyst/cases", "bank.example")).toBe("analyst");
    expect(classifyGashaBrowserRoute("/%61nalyst", "localhost")).toBe("unavailable");
  });
});

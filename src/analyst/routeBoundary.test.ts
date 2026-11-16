import { describe, expect, it } from "vitest";
import { classifyGashaRoute } from "./routeBoundary";

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

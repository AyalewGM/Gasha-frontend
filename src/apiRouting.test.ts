import { describe, expect, it } from "vitest";
import { apiBasePath } from "./apiRouting";

describe("secure API routing", () => {
  it("defaults to a same-origin reverse proxy", () => expect(apiBasePath()).toBe("/api"));
  it("permits configurable same-origin prefixes", () => expect(apiBasePath("/fraud/api/")).toBe("/fraud/api"));
  it.each(["https://bank.example", "//evil.example", "/", "/api?token=x", "/api#fragment"])("rejects unsafe API base %s", (value) => {
    expect(() => apiBasePath(value)).toThrow();
  });
});

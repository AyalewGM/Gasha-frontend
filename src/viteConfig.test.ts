import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const originalCwd = process.cwd();
let temp: string | undefined;
afterEach(() => {
  process.chdir(originalCwd);
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

describe("dev and preview API proxy configuration", () => {
  it.each([
    ["default", "", "/api", "http://127.0.0.1:8000"],
    ["custom", "VITE_API_BASE_PATH=/fraud/api/\nGASHA_LOCAL_API_TARGET=http://127.0.0.1:9999\n", "/fraud/api", "http://127.0.0.1:9999"],
  ])("loads %s routing from mode environment files", async (_name, envFile, prefix, target) => {
    temp = mkdtempSync(join(tmpdir(), "gasha-routing-"));
    writeFileSync(join(temp, ".env.gasha_test"), envFile);
    process.chdir(temp);
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "gasha_test" },
      resolve(originalCwd, "vite.config.ts"),
    );
    expect(loaded).not.toBeNull();
    const config = loaded!.config;
    for (const proxy of [config.server?.proxy, config.preview?.proxy]) {
      const entry = proxy?.[prefix];
      expect(entry).toBeDefined();
      expect(typeof entry).toBe("object");
      if (typeof entry === "object") {
        expect(entry.target).toBe(target);
        expect(entry.rewrite?.(prefix + "/v1/decisions")).toBe("/v1/decisions");
        expect(entry.rewrite?.(prefix + "/health/live")).toBe("/health/live");
        expect(entry.rewrite?.("/unrelated")).toBe("/unrelated");
      }
    }
  });

  it.each([
    ["localhost", "http://localhost:9000"],
    ["IPv6 loopback", "http://[::1]:9000"],
    ["HTTPS loopback", "https://localhost:8443"],
  ])("permits %s only as a synthetic proxy target", async (_label, backendTarget) => {
    temp = mkdtempSync(join(tmpdir(), "gasha-routing-"));
    writeFileSync(join(temp, ".env.gasha_test"), `GASHA_LOCAL_API_TARGET="${backendTarget}"\n`);
    process.chdir(temp);
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "gasha_test" },
      resolve(originalCwd, "vite.config.ts"),
    );
    expect(loaded).not.toBeNull();
    for (const proxy of [loaded!.config.server?.proxy, loaded!.config.preview?.proxy]) {
      const entry = proxy?.["/api"];
      expect(entry).toBeDefined();
      if (typeof entry === "object") expect(entry.target).toBe(backendTarget);
    }
  });

  it.each([
    ["remote bank domain", "https://bank.example:443"],
    ["remote IPv4", "http://192.0.2.25:8000"],
    ["remote IPv6", "http://[2001:db8::1]:8000"],
    ["lookalike hostname", "http://localhost.bank.example:8000"],
    ["userinfo at remote target", "http://localhost@bank.example:8000"],
    ["credentials at local target", "http://user:password@localhost:8000"],
    ["encoded credentials", "http://user%40other@localhost:8000"],
    ["redirect in query", "http://localhost:8000/?next=https%3A%2F%2Fbank.example"],
    ["encoded redirect in path", "http://localhost:8000/%2F%2Fbank.example"],
    ["redirect in fragment", "http://localhost:8000/#https%3A%2F%2Fbank.example"],
  ])("rejects %s before creating any synthetic proxy", async (_label, backendTarget) => {
    temp = mkdtempSync(join(tmpdir(), "gasha-routing-"));
    writeFileSync(join(temp, ".env.gasha_test"), `GASHA_LOCAL_API_TARGET="${backendTarget}"\n`);
    process.chdir(temp);
    await expect(
      loadConfigFromFile(
        { command: "serve", mode: "gasha_test" },
        resolve(originalCwd, "vite.config.ts"),
      ),
    ).rejects.toThrow();
  });

});

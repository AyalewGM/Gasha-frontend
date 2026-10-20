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
});

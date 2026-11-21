import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile, type Plugin, type PreviewServer, type ViteDevServer } from "vite";
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
      const entry = proxy?.[`^${prefix}/(?:health/live|v1/decisions)$`];
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

  it("uses only the scoped dev proxy when the analyst lab is enabled", async () => {
    temp = mkdtempSync(join(tmpdir(), "gasha-analyst-lab-"));
    writeFileSync(join(temp, ".env.gasha_test"),
      "VITE_GASHA_ANALYST_PHASE_A=true\nVITE_GASHA_ANALYST_SYNTHETIC_LAB=true\n");
    process.chdir(temp);
    const configPath = resolve(originalCwd, "vite.config.ts");
    const loaded = await loadConfigFromFile({ command: "serve", mode: "gasha_test" }, configPath);
    const config = loaded!.config;
    expect(Object.keys(config.server?.proxy ?? {})).toEqual(["/__gasha_analyst_lab"]);
    expect(config.preview?.proxy).toEqual({});
    const plugin = (config.plugins as Plugin[]).find((item) => item.name === "synthetic-analyst-loopback-boundary");
    expect(plugin).toBeDefined();
    const use = vi.fn();
    const configure = plugin!.configureServer;
    if (typeof configure !== "function") throw new Error("Missing analyst lab boundary");
    configure.call({} as ThisParameterType<typeof configure>, { middlewares: { use } } as unknown as ViteDevServer);
    const handle = use.mock.calls[0][0];

    for (const path of [
      "/api/v1/tenants/tenant-a/cases/queue?limit=25",
      "/api/%76%31/tenants/tenant-a/cases/queue?limit=25",
      "/api/v1/%74enants/tenant-a/cases/queue?limit=25",
      "/__gasha_analyst_lab/v1/%74enants/tenant-a/cases/queue?limit=25",
    ]) {
      const end = vi.fn();
      const writeHead = vi.fn().mockReturnValue({ end });
      const next = vi.fn();
      handle({ url: path, method: "GET", headers: {
        host: "127.0.0.1:5173", authorization: "Bearer synthetic-test",
      }, socket: { remoteAddress: "127.0.0.1" } }, { writeHead }, next);
      if (next.mock.calls.length) {
        // An encoded generic prefix may reach Vite fallback, but no proxy
        // entry forwards it to the protected backend.
        expect(Object.keys(config.server?.proxy ?? {}).some((prefix) => path.startsWith(prefix))).toBe(false);
      } else {
        expect(writeHead).toHaveBeenCalledWith(403, { "Cache-Control": "no-store" });
      }
    }

    const preview = await loadConfigFromFile(
      { command: "serve", mode: "gasha_test", isPreview: true }, configPath,
    );
    expect(preview!.config.preview?.proxy).toEqual({});
    const build = await loadConfigFromFile({ command: "build", mode: "gasha_test" }, configPath);
    expect(config.define?.__GASHA_SYNTHETIC_ANALYST_LAB__).toBe("true");
    expect(preview!.config.define?.__GASHA_SYNTHETIC_ANALYST_LAB__).toBe("false");
    expect(build!.config.define?.__GASHA_SYNTHETIC_ANALYST_LAB__).toBe("false");
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
      const entry = proxy?.["^/api/(?:health/live|v1/decisions)$"];
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


  it("rejects remote/ambiguous peers and hosts at the synthetic decision proxy in dev and preview", async () => {
    temp = mkdtempSync(join(tmpdir(), "gasha-local-boundary-"));
    process.chdir(temp);
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "gasha_test" },
      resolve(originalCwd, "vite.config.ts"),
    );
    const plugin = (loaded!.config.plugins as Plugin[]).find(
      (item) => item.name === "synthetic-decision-proxy-boundary",
    );
    expect(plugin).toBeDefined();

    for (const hookName of ["configureServer", "configurePreviewServer"] as const) {
      const use = vi.fn();
      const server = { middlewares: { use } };
      if (hookName === "configureServer") {
        const configure = plugin!.configureServer;
        if (typeof configure !== "function") throw new Error("Missing synthetic dev boundary");
        configure.call(
          {} as ThisParameterType<typeof configure>, server as unknown as ViteDevServer,
        );
      } else {
        const configure = plugin!.configurePreviewServer;
        if (typeof configure !== "function") throw new Error("Missing synthetic preview boundary");
        configure.call(
          {} as ThisParameterType<typeof configure>, server as unknown as PreviewServer,
        );
      }
      const handle = use.mock.calls[0][0];
      expect(typeof handle).toBe("function");

      const peers = [
        ["127.0.0.1:5173", "127.0.0.1", true],
        ["localhost:4173", "::1", true],
        ["[::1]:5173", "::ffff:127.0.0.1", true],
        ["bank.example", "127.0.0.1", false],
        ["localhost.bank.example", "127.0.0.1", false],
        ["192.168.1.4:5173", "127.0.0.1", false],
        ["127.0.0.1:5173", "192.0.2.15", false],
        ["localhost:5173", "::ffff:192.0.2.15", false],
        ["", "127.0.0.1", false],
        ["127.0.0.1:5173", "", false],
      ] as const;

      for (const [host, remoteAddress, allowed] of peers) {
        for (const [url, method] of [
          ["/api/v1/decisions", "POST"],
          ["/api/health/live", "GET"],
        ] as const) {
          const headers: Record<string, string> = {
            host, authorization: "Bearer must-not-forward", cookie: "bank-session=must-not-forward",
          };
          const next = vi.fn();
          const end = vi.fn();
          const writeHead = vi.fn().mockReturnValue({ end });
          handle({ url, method, headers, socket: { remoteAddress } }, { writeHead }, next);
          if (allowed) {
            expect(next).toHaveBeenCalledOnce();
            expect(writeHead).not.toHaveBeenCalled();
            expect(headers.authorization).toBeUndefined();
            expect(headers.cookie).toBeUndefined();
          } else {
            expect(next).not.toHaveBeenCalled();
            expect(writeHead).toHaveBeenCalledWith(403, { "Cache-Control": "no-store" });
            expect(end).toHaveBeenCalledOnce();
          }
        }
      }

      const next = vi.fn();
      const end = vi.fn();
      const writeHead = vi.fn().mockReturnValue({ end });
      handle({
        url: "/api/v1/tenants/tenant-a/cases/queue?limit=25",
        method: "GET", headers: { host: "127.0.0.1:5173" },
        socket: { remoteAddress: "127.0.0.1" },
      }, { writeHead }, next);
      expect(next).not.toHaveBeenCalled();
      expect(writeHead).toHaveBeenCalledWith(403, { "Cache-Control": "no-store" });
    }
  });


  it("restricts founding-feature GET to the exact loopback synthetic lab boundary", async () => {
    temp = mkdtempSync(join(tmpdir(), "gasha-lab-evidence-boundary-"));
    writeFileSync(join(temp, ".env.gasha_test"),
      "VITE_GASHA_ANALYST_PHASE_A=true\nVITE_GASHA_ANALYST_SYNTHETIC_LAB=true\n");
    process.chdir(temp);
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "gasha_test" },
      resolve(originalCwd, "vite.config.ts"),
    );
    expect(loaded).not.toBeNull();
    const config = loaded!.config;
    expect(Object.keys(config.server?.proxy ?? {})).toEqual(["/__gasha_analyst_lab"]);
    expect(config.preview?.proxy).toEqual({});
    const plugin = (config.plugins as Plugin[]).find((item) =>
      item.name === "synthetic-analyst-loopback-boundary");
    expect(plugin).toBeDefined();
    const use = vi.fn();
    const configure = plugin!.configureServer;
    if (typeof configure !== "function") throw new Error("Missing synthetic analyst boundary");
    configure.call(
      {} as ThisParameterType<typeof configure>,
      { middlewares: { use } } as unknown as ViteDevServer,
    );
    const handle = use.mock.calls[0][0];
    const caseId = "00000000-0000-4000-8000-000000000041";
    const root = "/__gasha_analyst_lab/v1/tenants/tenant-a/cases/";
    const feature = root + caseId + "/feature-evidence";
    function dispatch(
      path: string,
      method = "GET",
      headers: Record<string, string> = {},
      host = "127.0.0.1:5173",
      remoteAddress = "127.0.0.1",
    ) {
      const next = vi.fn();
      const end = vi.fn();
      const writeHead = vi.fn().mockReturnValue({ end });
      handle({
        url: path, method, headers: {
          host, authorization: "Bearer synthetic-test", ...headers,
        }, socket: { remoteAddress },
      }, { writeHead }, next);
      return { next, writeHead, end };
    }
    for (const path of [
      root + "queue?limit=1", root + "queue?limit=100",
      root + caseId + "/history", feature,
    ]) {
      const forwarded = dispatch(path, "GET", { origin: "http://127.0.0.1:5173" });
      expect(forwarded.next, path).toHaveBeenCalledOnce();
      expect(forwarded.writeHead, path).not.toHaveBeenCalled();
    }
    // Neither a tenant or operation extension nor a query/canonicalization
    // variant may extend the offline synthetic-only proxy's authority.
    const deniedPaths = [
      "/api/v1/tenants/tenant-a/cases/" + caseId + "/feature-evidence",
      "/__gasha_analyst_lab/v1/tenants/tenant-b/cases/" + caseId + "/feature-evidence",
      root + "queue?limit=0", root + "queue?limit=101",
      feature + "?limit=25", feature + "/", feature + "?tenant_id=tenant-b",
      root + caseId + "/%66eature-evidence",
      root + caseId + "/feature%2devidence",
      root + caseId + "/feature-evidence%2f",
      root + "AAAAAAAA-0000-4000-8000-000000000041/feature-evidence",
      root + "not-a-uuid/feature-evidence",
    ];
    for (const path of deniedPaths) {
      const denied = dispatch(path);
      expect(denied.next, path).not.toHaveBeenCalled();
      expect(denied.writeHead, path).toHaveBeenCalledWith(403, { "Cache-Control": "no-store" });
      expect(denied.end, path).toHaveBeenCalledOnce();
    }
    const deniedRequests: Array<[string, string, Record<string, string>, string?, string?]> = [
      [feature, "POST", { origin: "http://127.0.0.1:5173", "content-type": "application/json" }],
      [feature, "PUT", {}],
      [feature, "GET", { authorization: "" }],
      [feature, "GET", { authorization: "Bearer invalid.token" }],
      [feature, "GET", { cookie: "bank-session=do-not-forward" }],
      [feature, "GET", { origin: "https://bank.example" }],
      [feature, "GET", {}, "bank.example", "127.0.0.1"],
      [feature, "GET", {}, "localhost.bank.example", "127.0.0.1"],
      [feature, "GET", {}, "127.0.0.1:5173", "192.0.2.10"],
    ];
    for (const [path, method, headers, host, peer] of deniedRequests) {
      const denied = dispatch(path, method, headers, host, peer);
      expect(denied.next).not.toHaveBeenCalled();
      expect(denied.writeHead).toHaveBeenCalledWith(403, { "Cache-Control": "no-store" });
    }
  });
});

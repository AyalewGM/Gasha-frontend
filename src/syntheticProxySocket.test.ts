import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { type Server as TcpServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, preview, type PreviewServer, type ViteDevServer } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const originalCwd = process.cwd();
let workDir: string | undefined;

afterEach(() => {
  process.chdir(originalCwd);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function portOf(server: TcpServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP listener");
  return address.port;
}

async function listen(server: TcpServer, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return portOf(server);
}

function closeServer(server: TcpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

type HttpResult = { status: number; cacheControl: string | undefined; body: string };
function send(hostname: string, port: number, hostHeader: string, path: string, method: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname,
      port,
      method,
      path,
      setHost: false,
      headers: {
        Host: hostHeader,
        Cookie: "bank-session=should-not-forward",
        Authorization: "Bearer should-not-forward",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        cacheControl: res.headers["cache-control"],
        body,
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

function localNonLoopbackIPv4(): string {
  const address = Object.values(networkInterfaces()).flat().find(
    (item) => item?.family === "IPv4" && !item.internal,
  )?.address;
  if (!address) throw new Error("Socket ingress regression requires a non-loopback runner interface");
  return address;
}

describe("synthetic decision proxy TCP ingress (no Bank services)", () => {
  it("keeps dev and preview synthetic routes local over actual HTTP sockets", async () => {
    workDir = mkdtempSync(join(tmpdir(), "gasha-socket-"));
    const seen: Array<{ path: string; cookie?: string; authorization?: string }> = [];
    const backend = createHttpServer((req, res) => {
      seen.push({
        path: req.url ?? "",
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"synthetic":true}');
    });

    let dev: ViteDevServer | undefined;
    let previewServer: PreviewServer | undefined;
    let devIpv6: ViteDevServer | undefined;
    let previewIpv6: PreviewServer | undefined;
    try {
      const backendPort = await listen(backend, "127.0.0.1");
      writeFileSync(
        join(workDir, ".env.gasha_socket"),
        "GASHA_LOCAL_API_TARGET=http://127.0.0.1:" + backendPort + "\n",
      );
      mkdirSync(join(workDir, "dist"));
      writeFileSync(join(workDir, "dist", "index.html"), "<html><body>synthetic socket test</body></html>");
      process.chdir(workDir);
      const configFile = join(projectRoot, "vite.config.ts");
      dev = await createServer({
        configFile,
        mode: "gasha_socket",
        root: projectRoot,
        server: { host: "0.0.0.0", port: 0, strictPort: false },
      });
      await dev.listen();
      previewServer = await preview({
        configFile,
        mode: "gasha_socket",
        root: projectRoot,
        build: { outDir: join(workDir, "dist") },
        preview: { host: "0.0.0.0", port: 0, strictPort: false },
      });

      // A real IPv6 listener is required: mocking remoteAddress = "::1"
      // would not verify Vite's socket/proxy behavior on IPv6.
      devIpv6 = await createServer({
        configFile,
        mode: "gasha_socket",
        root: projectRoot,
        server: { host: "::", port: 0, strictPort: false },
      });
      await devIpv6.listen();
      previewIpv6 = await preview({
        configFile,
        mode: "gasha_socket",
        root: projectRoot,
        build: { outDir: join(workDir, "dist") },
        preview: { host: "::", port: 0, strictPort: false },
      });

      const nonlocalIp = localNonLoopbackIPv4();
      for (const [kind, port] of [
        ["dev", portOf(dev.httpServer!)],
        ["preview", portOf(previewServer.httpServer)],
      ] as const) {
        for (const [path, method, forwardedPath] of [
          ["/api/v1/decisions", "POST", "/v1/decisions"],
          ["/api/health/live", "GET", "/health/live"],
        ] as const) {
          const success = await send("127.0.0.1", port, `127.0.0.1:${port}`, path, method);
          expect(success.status, `${kind} ${method} ${path}`).toBe(200);
          expect(success.body).toContain('"synthetic":true');
          expect(seen.at(-1)).toEqual({
            path: forwardedPath, cookie: undefined, authorization: undefined,
          });
        }

        for (const [connectHost, header, path, method] of [
          [nonlocalIp, `127.0.0.1:${port}`, "/api/v1/decisions", "POST"],
          ["127.0.0.1", `bank.example:${port}`, "/api/v1/decisions", "POST"],
          ["127.0.0.1", `127.0.0.1:${port}`, "/api/v1/tenants/tenant-a/cases/queue?limit=25", "GET"],
          ["127.0.0.1", `127.0.0.1:${port}`, "/api/unknown", "GET"],
        ] as const) {
          const before = seen.length;
          const denied = await send(connectHost, port, header, path, method);
          expect(denied.status, `${kind} ${connectHost} / ${header} / ${path}`).toBe(403);
          expect(seen, "denied request must never reach local decision backend").toHaveLength(before);
          if (header.startsWith("127.0.0.1:")) {
            expect(denied.cacheControl).toBe("no-store");
          }
        }
      }

      for (const [kind, port] of [
        ["dev IPv6", portOf(devIpv6.httpServer!)],
        ["preview IPv6", portOf(previewIpv6.httpServer)],
      ] as const) {
        for (const [path, method, forwardedPath] of [
          ["/api/v1/decisions", "POST", "/v1/decisions"],
          ["/api/health/live", "GET", "/health/live"],
        ] as const) {
          const allowed = await send("::1", port, `[::1]:${port}`, path, method);
          expect(allowed.status, `${kind} ${method} ${path}`).toBe(200);
          expect(seen.at(-1)).toEqual({
            path: forwardedPath, cookie: undefined, authorization: undefined,
          });

          // A spoofed remote Host over a genuine ::1 socket must not
          // reach the synthetic backend even though the TCP peer is local.
          const before = seen.length;
          const denied = await send("::1", port, `bank.example:${port}`, path, method);
          expect(denied.status, `${kind} spoofed Host`).toBe(403);
          expect(seen).toHaveLength(before);
        }
      }
    } finally {
      if (devIpv6) await devIpv6.close();
      if (previewIpv6) await closeServer(previewIpv6.httpServer);
      if (dev) await dev.close();
      if (previewServer) await closeServer(previewServer.httpServer);
      await closeServer(backend);
    }
  }, 45_000);
});

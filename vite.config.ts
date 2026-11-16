import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { apiBasePath } from "./src/apiRouting";

const ANALYST_LAB_PREFIX = "/__gasha_analyst_lab";
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/;
const LOCAL_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const CASES = "/v1/tenants/tenant-a/cases/";
const CASE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GET_CASE = new RegExp(`^${CASES}(?:queue\\?limit=(?:[1-9]|[1-9][0-9]|100)|${CASE}/history)$`);
const POST_CASE = new RegExp(`^${CASES}${CASE}/transitions/(?:triage|assign|dispose|correct|reconcile)$`);

function syntheticProxyBoundary(apiPrefix: string): Plugin {
  function configure(server: Pick<ViteDevServer, "middlewares">) {
    server.middlewares.use((request, response, next) => {
      const path = request.url ?? "";
      if (path !== apiPrefix && !path.startsWith(apiPrefix + "/")) return next();
      if (
        (path === apiPrefix + "/health/live" && request.method === "GET") ||
        (path === apiPrefix + "/v1/decisions" && request.method === "POST")
      ) {
        // The decision demo is anonymous. Never forward browser credentials.
        delete request.headers.authorization;
        delete request.headers.cookie;
        next();
        return;
      }
      response.writeHead(403, { "Cache-Control": "no-store" }).end();
    });
  }
  return {
    name: "synthetic-decision-proxy-boundary",
    configureServer: configure,
    configurePreviewServer: configure,
  };
}

function analystLabBoundary(apiPrefix: string): Plugin {
  return {
    name: "synthetic-analyst-loopback-boundary",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url ?? "";
        const syntheticProxy = path.startsWith(`${apiPrefix}/v1/tenants/`);
        if (!path.startsWith(ANALYST_LAB_PREFIX) && !syntheticProxy) return next();
        const host = request.headers.host ?? "";
        const route = path.slice(ANALYST_LAB_PREFIX.length);
        const sameOrigin = request.headers.origin === `http://${host}`;
        const scopedRead = request.method === "GET" && GET_CASE.test(route) &&
          (!request.headers.origin || sameOrigin);
        const scopedWrite = request.method === "POST" && POST_CASE.test(route) &&
          sameOrigin && request.headers["content-type"] === "application/json";
        if (syntheticProxy || !LOCAL_HOST.test(host) ||
          !LOCAL_PEERS.has(request.socket.remoteAddress ?? "") ||
          (!scopedRead && !scopedWrite) || request.headers.cookie ||
          !/^Bearer [A-Za-z0-9_-]+$/.test(request.headers.authorization ?? "")
        ) {
          response.writeHead(403, { "Cache-Control": "no-store" }).end();
          return;
        }
        next();
      });
    },
  };
}

/** Explicitly load Vite's mode-specific environment for both browser and proxy. */
export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPrefix = apiBasePath(env.VITE_API_BASE_PATH);
  const backendTarget = env.GASHA_LOCAL_API_TARGET || "http://127.0.0.1:8000";
  const target = new URL(backendTarget);
  // Synthetic input is caller-controlled: never proxy it outside this host.
  // URL.hostname normalizes IPv6 loopback to "[::1]".
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    !loopbackHosts.has(target.hostname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/"
  ) {
    throw new Error("GASHA_LOCAL_API_TARGET must be a credential-free loopback HTTP(S) origin");
  }
  const syntheticRoute = `^${apiPrefix}/(?:health/live|v1/decisions)$`;
  const proxy = {
    [syntheticRoute]: {
      target: target.origin,
      changeOrigin: false,
      rewrite: (path: string) =>
        path === apiPrefix ? "/" : path.startsWith(apiPrefix + "/") ? path.slice(apiPrefix.length) : path,
    },
  };
  const labRequested = env.VITE_GASHA_ANALYST_PHASE_A === "true" &&
    env.VITE_GASHA_ANALYST_SYNTHETIC_LAB === "true";
  const analystLab = command === "serve" && !isPreview && labRequested;
  return {
    define: { __GASHA_SYNTHETIC_ANALYST_LAB__: JSON.stringify(analystLab) },
    plugins: analystLab
      ? [react(), analystLabBoundary(apiPrefix)]
      : labRequested ? [react()] : [react(), syntheticProxyBoundary(apiPrefix)],
    server: { proxy: analystLab ? {
      [ANALYST_LAB_PREFIX]: {
        target: target.origin,
        changeOrigin: false,
        rewrite: (path: string) => path.slice(ANALYST_LAB_PREFIX.length),
      },
    } : proxy },
    preview: { proxy: labRequested ? {} : proxy },
  };
});

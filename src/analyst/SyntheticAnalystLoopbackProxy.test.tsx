// @vitest-environment jsdom
/**
 * Regression for the actual Vite middleware/proxy and the real synthetic
 * analyst transport. The test backend is a loopback HTTP fixture, not a
 * FastAPI/PostgreSQL or Bank integration, and no browser response is stubbed.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { ViteDevServer } from "vite";
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SyntheticAnalystLab } from "./SyntheticAnalystLab";
import { foundingEvidence } from "./foundingEvidence.testFixtures";
import { getInstalledProtectedAnalystSession } from "./installedProtectedSession";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const CONTEXT = "c".repeat(64);
const AT = "2026-11-15T00:00:00Z";
const API = "/v1/tenants/tenant-a/cases/";
const CREDENTIAL = "synthetic-test-credential";
const INITIAL = {
  revision: 1, previous_revision: null, operation: "create", recorded_at: AT,
  reason_code: "source_evaluation", disposition: null, actor_ref: "a".repeat(64),
  assignee_ref: null, source_event_id: SOURCE, source_context_ref: CONTEXT,
  bank_execution: "unknown",
};
const queue = {
  tenant_scope: "authenticated_reader", ranking_policy_version: "synthetic-v1",
  generated_at: AT, bank_ranking_approved: false, enforcement_activated: false,
  items: [{
    rank: 1, case_id: CASE, source_event_id: SOURCE, source_context_ref: CONTEXT,
    scenario_ids: ["MM-02"], status: "create", revision: 1,
    created_at: AT, updated_at: AT, assignee_ref: null, bank_execution: "unknown",
  }],
};
const history = { case_id: CASE, enforcement_activated: false, events: [INITIAL] };
const requests: string[] = [];
const authorityHeaders: string[] = [];
let backend: HttpServer | undefined;
let vite: ViteDevServer | undefined;
let base: string;
const keys = [
  "VITE_GASHA_ANALYST_PHASE_A",
  "VITE_GASHA_ANALYST_SYNTHETIC_LAB",
  "GASHA_LOCAL_API_TARGET",
] as const;
const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  // jsdom supplies different-realm typed arrays. esbuild requires its Node
  // TextEncoder and Uint8Array to share a realm; defer Vite import until fixed.
  const nodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor as typeof Uint8Array;
  Object.assign(globalThis, { Uint8Array: nodeUint8Array, TextEncoder, TextDecoder });
  const { createServer: createViteServer, loadConfigFromFile } = await import("vite");
  backend = createHttpServer((request, response) => {
    const path = request.url ?? "";
    requests.push((request.method ?? "") + " " + path);
    if (["x-tenant-id", "x-role", "x-capability", "x-user-id"].some(
      (header) => request.headers[header] !== undefined,
    )) authorityHeaders.push(path);
    if (request.headers.authorization !== "Bearer " + CREDENTIAL) {
      response.writeHead(401).end();
      return;
    }
    const body: unknown =
      request.method === "GET" && path === API + "queue?limit=25" ? queue
      : request.method === "GET" && path === API + CASE + "/history" ? history
      : request.method === "GET" && path === API + CASE + "/feature-evidence"
        ? foundingEvidence(CASE, CONTEXT) : null;
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((done) => backend!.listen(0, "127.0.0.1", done));
  const backendPort = (backend.address() as AddressInfo).port;
  process.env.VITE_GASHA_ANALYST_PHASE_A = "true";
  process.env.VITE_GASHA_ANALYST_SYNTHETIC_LAB = "true";
  process.env.GASHA_LOCAL_API_TARGET = "http://127.0.0.1:" + backendPort;
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "gasha_live_proxy_test" },
    resolve(process.cwd(), "vite.config.ts"),
  );
  if (!loaded) throw new Error("Missing synthetic lab Vite configuration");
  vite = await createViteServer({
    ...loaded.config,
    root: process.cwd(),
    configFile: false,
    logLevel: "silent",
    server: { ...loaded.config.server, host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  base = "http://127.0.0.1:" + (vite.httpServer!.address() as AddressInfo).port;
  const realFetch = globalThis.fetch.bind(globalThis);
  // Only resolve the relative browser URL. The request still uses real HTTP
  // against the actual Vite boundary and its loopback backend adapter.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(String(input), base), init));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (vite) await vite.close();
  if (backend) {
    backend.closeAllConnections();
    await new Promise<void>((done) => backend!.close(() => done()));
  }
  for (const key of keys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

it("reaches queue → history → evidence through the real loopback proxy and unlocks only verified synthetic triage", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  expect(getInstalledProtectedAnalystSession()).toBeNull();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(SyntheticAnalystLab)));
    const input = host.querySelector<HTMLInputElement>("input[type=password]")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, CREDENTIAL);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    async function click(label: string) {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
      expect(button, label).toBeTruthy();
      await act(async () => button!.click());
    }
    await click("Open synthetic session");
    await click("Refresh queue");
    expect(requests, "the actual Vite proxy must reach the loopback backend; UI=" + host.textContent)
      .toEqual(["GET " + API + "queue?limit=25"]);
    expect(host.textContent).not.toContain("Triage case");
    expect(host.textContent).toContain("Open case");
    await click("Open case");
    expect(requests).toEqual([
      "GET " + API + "queue?limit=25",
      "GET " + API + CASE + "/history",
      "GET " + API + CASE + "/feature-evidence",
    ]);
    expect(authorityHeaders).toEqual([]);
    expect(host.textContent).toContain("Founding-event evidence");
    expect(host.textContent).toContain("synthetic; not Bank-attested");
    expect(host.textContent).toContain("Triage case");
    expect(host.textContent).not.toContain(CREDENTIAL);
    await click("End session");
    expect(host.textContent).not.toContain(CASE);
    expect(getInstalledProtectedAnalystSession()).toBeNull();
    // A foreign-tenant URL is blocked by Vite before it reaches the adapter.
    const denied = await globalThis.fetch(
      "/__gasha_analyst_lab/v1/tenants/tenant-b/cases/" + CASE + "/feature-evidence",
      { headers: { Authorization: "Bearer " + CREDENTIAL } },
    );
    expect(denied.status).toBe(403);
    expect(requests).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}, 30000);

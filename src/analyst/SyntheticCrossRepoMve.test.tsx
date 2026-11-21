// @vitest-environment jsdom
/**
 * #9 actual, disposable PostgreSQL -> authenticated FastAPI -> Vite dev HTTP
 * -> React synthetic analyst journey, followed by persisted audit verification.
 *
 * Deliberately opt-in: never runs in ordinary UI/Bank builds. The DOM is jsdom,
 * not a real Chromium browser; all protected responses are real FastAPI/PG HTTP,
 * never fixture responses, and no Bank session is installed.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { TextEncoder, TextDecoder } from "node:util";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SyntheticAnalystLab } from "./SyntheticAnalystLab";
import { getInstalledProtectedAnalystSession } from "./installedProtectedSession";

const ENABLED = process.env.GASHA_CROSS_REPO_MVE === "true";
const run = ENABLED ? it : it.skip;
const PYTHON = "integration/synthetic_mve_server.py";
const ENV_KEYS = [
  "VITE_GASHA_ANALYST_PHASE_A", "VITE_GASHA_ANALYST_SYNTHETIC_LAB",
  "GASHA_LOCAL_API_TARGET",
] as const;

interface Manifest {
  scenario: "uc02";
  token: string;
  foreign_token: string;
  no_read_token: string;
  expired_token: string;
  revoked_token: string;
  case: string;
  source_event: string;
  source_context: string;
  assignee: string;
  schema: string;
  initial_alerts: number;
}

let fixturePath: string;
let fixtureDir: string;
let fixture: Manifest;
let backendProcess: ChildProcess | undefined;
let vite: ViteDevServer | undefined;
let backendUrl: string;
let viteUrl: string;
let originalFetch: typeof fetch;
const envBefore = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let firstWrite: { path: string; body: string } | null = null;
const attempts: Array<{ method: string; path: string; status?: number }> = [];

function python(action: string): void {
  const result = spawnSync("python", [PYTHON, action, "--manifest", fixturePath], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30000,
  });
  // The fixture contains private synthetic bearer tokens. Never echo the
  // spawned command's stdout/stderr or exception to an operator log.
  if (result.status !== 0 || result.error) {
    // Only emit known constant stage/reason identifiers, never raw stdout,
    // stderr, connection URLs, synthetic bearer tokens or DB record values.
    const stage = result.stdout?.match(/SYNTHETIC_INTERNAL_[A-Z_]+/g)?.at(-1)
      ?? "SYNTHETIC_INTERNAL_SETUP";
    const reason = result.stderr?.match(/AssertionError: (metrics_[a-z_]+)/)?.[1]
      ?? result.stderr?.match(/(?:CaseMetricsRejected|TypeError|ValueError|AssertionError)/)?.[0]
      ?? "unclassified";
    throw new Error("Disposable synthetic PostgreSQL fixture step failed: " +
      action + " at " + stage + " (" + reason + ")");
  }
}

async function freePort(): Promise<number> {
  const socket = createHttpServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}

async function awaitServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 70; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await originalFetch(url + "/health/live", { cache: "no-store" });
      if (response.status === 200) return;
    } catch { /* server has not yet bound the loopback socket */ }
    await new Promise<void>((done) => setTimeout(done, 200));
  }
  throw new Error("Synthetic FastAPI did not become healthy on loopback");
}

beforeAll(async () => {
  if (!ENABLED) return;
  if (!process.env.GASHA_TEST_POSTGRES_DSN ||
      !process.env.GASHA_MVE_BACKEND ||
      !process.env.GASHA_MVE_BACKEND_SHA) {
    throw new Error("Disposable PG DSN and pinned backend checkout/SHA required");
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const nativeArray = Object.getPrototypeOf(Buffer.prototype).constructor as typeof Uint8Array;
  Object.assign(globalThis, { Uint8Array: nativeArray, TextEncoder, TextDecoder });
  originalFetch = globalThis.fetch.bind(globalThis);
  fixtureDir = mkdtempSync(join(tmpdir(), "gasha-uc02-"));
  fixturePath = join(fixtureDir, "private-synthetic.json");
  python("seed");
  fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Manifest;
  expect(fixture.scenario).toBe("uc02");
  expect(fixture.initial_alerts).toBe(2);
  const backendPort = await freePort();
  backendUrl = "http://127.0.0.1:" + backendPort;
  backendProcess = spawn("python", [
    PYTHON, "serve", "--manifest", fixturePath, "--port", String(backendPort),
  ], { cwd: process.cwd(), env: process.env, stdio: "ignore" });
  await awaitServer(backendUrl, backendProcess);
  process.env.VITE_GASHA_ANALYST_PHASE_A = "true";
  process.env.VITE_GASHA_ANALYST_SYNTHETIC_LAB = "true";
  process.env.GASHA_LOCAL_API_TARGET = backendUrl;
  const { createServer: createViteServer, loadConfigFromFile } = await import("vite");
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "cross_repo_pg_http_test" },
    resolve(process.cwd(), "vite.config.ts"),
  );
  if (!loaded) throw new Error("Missing synthetic loopback Vite configuration");
  vite = await createViteServer({
    ...loaded.config, root: process.cwd(), configFile: false, logLevel: "silent",
    server: { ...loaded.config.server, host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  viteUrl = "http://127.0.0.1:" + (vite.httpServer!.address() as AddressInfo).port;
  // JSdom's Node fetch has no browser origin and accepts relative URLs only
  // after resolution. Supply the browser's actual Origin on POST, preserving
  // every HTTP method, body and credential in real Vite -> FastAPI requests.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") {
      headers.set("Origin", viteUrl);
      if (firstWrite === null && path.includes("/transitions/triage")) {
        firstWrite = { path, body: String(init.body) };
      }
    }
    const response = await originalFetch(new URL(path, viteUrl), { ...init, headers });
    attempts.push({ method: init?.method ?? "GET", path, status: response.status });
    return response;
  });
}, 60000);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (vite) await vite.close();
  if (backendProcess && backendProcess.exitCode === null) {
    backendProcess.kill("SIGTERM");
    await new Promise<void>((done) => {
      backendProcess!.once("exit", () => done());
      setTimeout(done, 1500);
    });
    if (backendProcess.exitCode === null) backendProcess.kill("SIGKILL");
  }
  if (fixturePath) {
    try { python("cleanup"); } catch { /* no leaked credentials in logs */ }
  }
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
}, 30000);

function findButton(host: HTMLDivElement, title: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((value) => value.textContent === title);
  expect(button, "Expected synthetic action " + title).toBeTruthy();
  return button!;
}

async function click(host: HTMLDivElement, title: string): Promise<void> {
  await act(async () => findButton(host, title).click());
}

async function enter(host: HTMLDivElement, token: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, token);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(host, "Open synthetic session");
}

async function awaitAction(host: HTMLDivElement, label: string): Promise<void> {
  await vi.waitFor(() => {
    expect(findButton(host, label).disabled).toBe(false);
  }, { timeout: 15000 });
}

function headers(token: string): HeadersInit {
  return { Authorization: "Bearer " + token };
}

async function direct(path: string, token?: string): Promise<Response> {
  return originalFetch(backendUrl + path, {
    headers: token ? headers(token) : undefined, cache: "no-store",
  });
}

run("UC-02 recovered worker → real PG/FastAPI/Vite/React → disposition, feedback and security negatives", async () => {
  expect(getInstalledProtectedAnalystSession()).toBeNull();
  const path = "/v1/tenants/tenant-a/cases/";
  const casePath = path + fixture.case;
  const exposed = "/__gasha_analyst_lab" + path;
  const rootHost = document.createElement("div");
  document.body.appendChild(rootHost);
  const root = createRoot(rootHost);
  try {
    // Backend authorization is checked by its installed verifier, not a
    // caller-defined tenant, rank, role, policy or synthetic browser flag.
    expect((await direct(path + "queue")).status).toBe(401);
    expect((await direct(path + "queue", fixture.expired_token)).status).toBe(401);
    expect((await direct(path + "queue", fixture.revoked_token)).status).toBe(401);
    expect((await direct(path + "queue", fixture.no_read_token)).status).toBe(403);
    expect((await direct(path + "queue", fixture.foreign_token)).status).toBe(404);
    expect((await direct(casePath + "/feature-evidence", fixture.foreign_token)).status).toBe(404);
    const spoof = await originalFetch(backendUrl + path + "queue", {
      headers: { Authorization: "Bearer " + fixture.no_read_token,
        "X-Tenant-Id": "tenant-a", "X-Role": "admin", "X-Capability": "case.read" },
    });
    expect(spoof.status).toBe(403);
    const first = await direct(path + "queue", fixture.token);
    expect(first.status).toBe(200);
    const snapshot: unknown = await first.json();
    expect(snapshot).toMatchObject({
      enforcement_activated: false, bank_ranking_approved: false,
      items: [{ case_id: fixture.case, source_event_id: fixture.source_event,
        scenario_ids: ["MM-02"], rank: 1 }],
    });

    const boundary = exposed + fixture.case + "/feature-evidence";
    expect((await originalFetch(viteUrl + boundary)).status).toBe(403);
    expect((await originalFetch(viteUrl + boundary, {
      headers: { ...headers(fixture.token), Origin: "https://untrusted.example" },
    })).status).toBe(403);
    expect((await originalFetch(viteUrl + boundary, {
      headers: { ...headers(fixture.token), Cookie: "session=forbidden" },
    })).status).toBe(403);
    expect((await originalFetch(viteUrl + boundary, {
      method: "PUT", headers: headers(fixture.token),
    })).status).toBe(403);
    expect((await originalFetch(viteUrl + "/__gasha_analyst_lab/v1/tenants/tenant-b/cases/queue?limit=25", {
      headers: headers(fixture.token),
    })).status).toBe(403);

    await act(async () => root.render(createElement(SyntheticAnalystLab)));
    await enter(rootHost, fixture.token);
    await click(rootHost, "Refresh queue");
    await awaitAction(rootHost, "Open case");
    expect(rootHost.textContent).toContain("MM-02");
    expect(rootHost.textContent).toContain("Open cases on this page: 1");
    expect(rootHost.textContent).not.toContain("Triage case");
    await click(rootHost, "Open case");
    await awaitAction(rootHost, "Triage case");
    expect(rootHost.textContent).toContain("Founding-event evidence");
    expect(rootHost.textContent).toContain("synthetic; not Bank-attested");
    expect(rootHost.textContent).toContain("Revision 1: create");
    await click(rootHost, "Triage case");
    await awaitAction(rootHost, "Assign case");
    expect(rootHost.textContent).toContain("Revision 2: triage");
    const assignee = [...rootHost.querySelectorAll("input")].find(
      (element) => element.closest("label")?.textContent?.includes("Assignee reference"),
    ) as HTMLInputElement | undefined;
    expect(assignee).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(assignee, fixture.assignee);
      assignee!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(rootHost, "Assign case");
    await awaitAction(rootHost, "Record disposition");
    expect(rootHost.textContent).toContain("Revision 3: assign");
    await click(rootHost, "Record disposition");
    await awaitAction(rootHost, "Reconcile feedback");
    expect(rootHost.textContent).toContain("Revision 4: dispose");
    await click(rootHost, "Reconcile feedback");
    await vi.waitFor(() => expect(rootHost.textContent).toContain("Revision 5: reconcile"),
      { timeout: 15000 });
    expect(rootHost.textContent).toContain("Case action recorded.");
    expect(rootHost.textContent).toContain("unknown");
    expect(rootHost.textContent).not.toContain(fixture.token);
    expect(rootHost.textContent).not.toContain(fixture.source_context);
    expect(getInstalledProtectedAnalystSession()).toBeNull();

    const performed = attempts.filter((a) => a.method === "POST");
    expect(performed.map((a) => a.path.split("/").at(-1))).toEqual([
      "triage", "assign", "dispose", "reconcile",
    ]);
    expect(performed.every((a) => a.status === 200)).toBe(true);
    const savedWrite = firstWrite;
    expect(savedWrite).toBeTruthy();
    const repeat = await originalFetch(viteUrl + savedWrite!.path, {
      method: "POST", body: savedWrite!.body,
      headers: { ...headers(fixture.token), Origin: viteUrl,
        "Content-Type": "application/json" },
    });
    expect(repeat.status).toBe(200);
    expect((await repeat.json()) as unknown).toMatchObject({ revision: 2, operation: "triage" });
    python("verify");

    // Fail the real committed authentication audit path. This must deny the
    // entire protected read rather than expose a previously cached projection.
    python("audit-deny");
    try {
      expect((await direct(path + "queue", fixture.token)).status).toBe(503);
      const protectedFailure = await originalFetch(viteUrl + exposed + "queue?limit=25", {
        headers: headers(fixture.token),
      });
      expect(protectedFailure.status).toBe(503);
      expect((await protectedFailure.text())).not.toContain("items");
    } finally {
      python("audit-restore");
    }
    await click(rootHost, "End session");
    expect(rootHost.textContent).not.toContain(fixture.case);
    await enter(rootHost, fixture.revoked_token);
    await click(rootHost, "Refresh queue");
    await vi.waitFor(() => expect(rootHost.textContent).toContain(
      "Synthetic session expired or was rejected."), { timeout: 10000 });
    expect(rootHost.textContent).not.toContain(fixture.case);
    expect(rootHost.textContent).not.toContain("Triage case");
    python("verify");
    // Counts are synthetic page/local workflow evidence, not Bank KPIs.
    process.stdout.write(
      "SYNTHETIC_MVE_PASS scenario=UC-02 http=Vite+FastAPI postgres=real " +
      "alerts=2 case_events=5 browser_posts=4 replay_duplicate=0 " +
      "bank_execution=unknown enforcement_activated=false\n",
    );
  } finally {
    await act(async () => root.unmount());
    rootHost.remove();
  }
}, 120000);

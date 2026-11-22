/**
 * Opt-in, synthetic-only Chromium analyst lifecycle evidence (#9).
 * Chromium executes the actual React bundle and sends native browser inputs
 * over Vite -> FastAPI -> disposable PostgreSQL. No Bank session or payment.
 * No additional browser automation dependency: Node 22's WebSocket uses CDP.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PIN = "8e053ec0e973a4baf27400abad94bb1ac68676e3";
const SCRIPT = "integration/synthetic_mve_server.py";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let step = "requirements", fixtureDir, manifest, fixture, chromeDir;
let api, chrome, socket, vite, auditDenied = false;
function python(command) {
  const run = spawnSync("python", [SCRIPT, command, "--manifest", manifest], {
    cwd: ROOT, env: process.env, stdio: "ignore", timeout: 60000,
  });
  assert.equal(run.status, 0, "fixture_" + command);
}
function prerequisites() {
  assert.equal(process.env.GASHA_CROSS_REPO_MVE, "true");
  assert.ok(process.env.GASHA_TEST_POSTGRES_DSN);
  assert.ok(process.env.GASHA_MVE_BACKEND);
  assert.equal(process.env.GASHA_MVE_BACKEND_SHA, PIN);
  const check = spawnSync("git", [
    "-C", process.env.GASHA_MVE_BACKEND, "rev-parse", "HEAD",
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(check.status, 0);
  assert.equal(check.stdout.trim(), PIN);
}
async function port() {
  const server = httpServer();
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const number = server.address().port;
  await new Promise(done => server.close(done));
  return number;
}
async function waitFor(condition, name, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await delay(120);
  }
  throw Error(name);
}
async function apiReady(url) {
  await waitFor(async () => {
    if (api.exitCode !== null) throw Error("fastapi_stopped");
    try { return (await fetch(url + "/health/live")).status === 200; }
    catch { return false; }
  }, "fastapi_not_ready");
}
function browserBinary() {
  for (const name of [
    process.env.CHROME_BIN, "/usr/bin/google-chrome", "google-chrome",
    "chromium", "chromium-browser",
  ].filter(Boolean)) {
    if (spawnSync(name, ["--version"], { stdio: "ignore", timeout: 4000 }).status === 0)
      return name;
  }
  throw Error("missing_chromium");
}
async function openBrowser(url) {
  chromeDir = mkdtempSync(join(tmpdir(), "gasha-chromium-"));
  const args = [
    "--headless=new", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-extensions",
    "--no-first-run", "--no-proxy-server", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--user-data-dir=" + chromeDir, "about:blank",
  ];
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  chrome = spawn(browserBinary(), args, { stdio: "ignore" });
  let debugPort;
  await waitFor(async () => {
    if (chrome.exitCode !== null) throw Error("chromium_stopped");
    const file = join(chromeDir, "DevToolsActivePort");
    if (!existsSync(file)) return false;
    const candidate = readFileSync(file, "utf8").split("\n")[0];
    if (!/^[0-9]{2,5}$/.test(candidate)) return false;
    debugPort = Number(candidate);
    return true;
  }, "chromium_port_missing");
  const response = await fetch(
    "http://127.0.0.1:" + debugPort + "/json/new?" + encodeURIComponent(url),
    { method: "PUT" },
  );
  assert.equal(response.status, 200);
  const tab = await response.json();
  assert.ok(/^ws:\/\/127\.0\.0\.1:\d+\//.test(tab.webSocketDebuggerUrl));
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((done, fail) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", () => fail(Error("cdp_connection")), { once: true });
    }),
    delay(10000).then(() => { throw Error("cdp_connection_timeout"); }),
  ]);
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", message => {
    let result;
    try { result = JSON.parse(message.data); } catch { return; }
    const done = pending.get(result.id);
    if (done) { pending.delete(result.id); done(result); }
  });
  async function send(method, params = {}) {
    const key = ++id;
    const response = await Promise.race([
      new Promise(done => {
        pending.set(key, done);
        socket.send(JSON.stringify({ id: key, method, params }));
      }),
      delay(12000).then(() => { throw Error("cdp_timeout"); }),
    ]);
    assert.ok(!response.error, "cdp_command");
    return response.result;
  }
  async function evalPage(expression) {
    const response = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    assert.ok(!response.exceptionDetails, "cdp_eval");
    return response.result?.value;
  }
  await send("Runtime.enable");
  return { send, evalPage };
}
async function inPage(page, expression, name) {
  await waitFor(() => page.evalPage(expression), name);
}
async function click(page, name) {
  const target = "(() => { const b = [...document.querySelectorAll('button')].find(" +
    "b => b.textContent.trim() === " + JSON.stringify(name) + "); " +
    "if (!b || b.disabled) return null; b.scrollIntoView({block:'center'}); " +
    "const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()";
  let point;
  await waitFor(async () => { point = await page.evalPage(target); return !!point; },
    "button_" + name.replaceAll(" ", "_"));
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", button: "left", clickCount: 1, ...point,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", button: "left", clickCount: 1, ...point,
  });
}
async function type(page, selector, input) {
  assert.match(input, /^[A-Za-z0-9_-]+$/); // bounded invented token/UUID only
  const focused = await page.evalPage("(() => { const e=document.querySelector(" +
    JSON.stringify(selector) + "); if(!e) return false; " +
    "e.scrollIntoView({block:'center'});e.focus();return document.activeElement===e; })()");
  assert.equal(focused, true, "browser_input_focus");
  await page.send("Input.insertText", { text: input });
  await inPage(page, "document.querySelector(" + JSON.stringify(selector) +
    ")?.value === " + JSON.stringify(input), "browser_input");
}
async function httpStatus(url, token, options = {}) {
  const headers = { ...(token ? { Authorization: "Bearer " + token } : {}), ...options.headers };
  return (await fetch(url, { ...options, headers, cache: "no-store" })).status;
}
async function execute() {
  prerequisites();
  fixtureDir = mkdtempSync(join(tmpdir(), "gasha-chromium-fixture-"));
  manifest = join(fixtureDir, "manifest.json");
  step = "seed"; python("seed");
  fixture = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(fixture.scenario, "uc02");
  assert.equal(fixture.initial_alerts, 2);
  const apiUrl = "http://127.0.0.1:" + await port();
  api = spawn("python", [
    SCRIPT, "serve", "--manifest", manifest,
    "--port", new URL(apiUrl).port,
  ], { cwd: ROOT, env: process.env, stdio: "ignore" });
  step = "api"; await apiReady(apiUrl);
  process.env.VITE_GASHA_ANALYST_PHASE_A = "true";
  process.env.VITE_GASHA_ANALYST_SYNTHETIC_LAB = "true";
  process.env.GASHA_LOCAL_API_TARGET = apiUrl;
  const { createServer, loadConfigFromFile } = await import("vite");
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "synthetic_chromium" }, resolve(ROOT, "vite.config.ts"),
  );
  assert.ok(loaded);
  vite = await createServer({
    ...loaded.config, root: ROOT, configFile: false, logLevel: "silent",
    server: { ...loaded.config.server, host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const uiUrl = "http://127.0.0.1:" + vite.httpServer.address().port;
  const prefix = "/v1/tenants/tenant-a/cases/";
  const queue = prefix + "queue";
  const boundary = "/__gasha_analyst_lab" + queue + "?limit=25";
  step = "api_denials";
  assert.equal(await httpStatus(apiUrl + queue), 401);
  assert.equal(await httpStatus(apiUrl + queue, fixture.expired_token), 401);
  assert.equal(await httpStatus(apiUrl + queue, fixture.revoked_token), 401);
  assert.equal(await httpStatus(apiUrl + queue, fixture.no_read_token), 403);
  assert.equal(await httpStatus(apiUrl + queue, fixture.foreign_token), 404);
  assert.equal(await httpStatus(apiUrl + prefix + fixture.case + "/history", fixture.foreign_token), 404);
  assert.equal(await httpStatus(apiUrl + prefix + fixture.case + "/feature-evidence", fixture.foreign_token), 404);
  assert.equal(await httpStatus(apiUrl + prefix + fixture.case + "/feature-evidence", fixture.no_read_token), 403);
  assert.equal(await httpStatus(apiUrl + queue, fixture.no_read_token, {
    headers: { "X-Tenant-Id": "tenant-a", "X-Role": "admin", "X-Capability": "case.read" },
  }), 403);
  step = "proxy_denials";
  assert.equal(await httpStatus(uiUrl + boundary), 403);
  assert.equal(await httpStatus(uiUrl + boundary, fixture.token, {
    headers: { Origin: "https://untrusted.example" },
  }), 403);
  assert.equal(await httpStatus(uiUrl + boundary, fixture.token, {
    headers: { Cookie: "synthetic=blocked" },
  }), 403);
  assert.equal(await httpStatus(uiUrl + boundary, fixture.token, { method: "PUT" }), 403);
  assert.equal(await httpStatus(
    uiUrl + "/__gasha_analyst_lab/v1/tenants/tenant-b/cases/queue?limit=25",
    fixture.token,
  ), 403);
  step = "chromium_mount";
  const page = await openBrowser(uiUrl + "/analyst");
  await inPage(page, "document.body?.innerText?.includes('Gasha analyst lab')", "mount");
  step = "chromium_queue";
  await type(page, 'input[type="password"]', fixture.token);
  await click(page, "Open synthetic session");
  await click(page, "Refresh queue");
  await inPage(page, "document.body.innerText.includes('Open cases on this page: 1')", "queue");
  await inPage(page, "document.body.innerText.includes('MM-02')", "ranking");
  await click(page, "Open case");
  await inPage(page, "document.body.innerText.includes('Founding-event evidence')", "evidence");
  await inPage(page, "(() => { const e = document.querySelector('section[aria-label=\"Founding-event evidence\"]'); if (!e) return false; const label = [...e.querySelectorAll('dt')].find(n => n.textContent.trim() === 'Eligible observations'); return label?.nextElementSibling?.textContent.trim() === '5' && e.innerText.includes('sender_beneficiary_history_coverage'); })()", "redis_founding_evidence");
  const evidenceReply = await fetch(apiUrl + prefix + fixture.case + "/feature-evidence", {
    headers: { Authorization: "Bearer " + fixture.token }, cache: "no-store",
  });
  assert.equal(evidenceReply.status, 200);
  const evidenceView = await evidenceReply.json();
  assert.equal(evidenceView.bank_source_attested, false);
  assert.equal(evidenceView.enforcement_activated, false);
  assert.equal(evidenceView.feature_evidence.source_assurance, "synthetic_unattested");
  assert.equal(evidenceView.feature_evidence.eligible_observations, 5);
  assert.ok(evidenceView.feature_evidence.unavailable_signals.includes(
    "sender_beneficiary_history_coverage"
  ));
  await inPage(page, "document.body.innerText.includes('Revision 1: create')", "history");
  await inPage(page, "document.body.innerText.includes('synthetic; not Bank-attested')", "provenance");
  step = "chromium_actions";
  await click(page, "Triage case");
  await inPage(page, "document.body.innerText.includes('Revision 2: triage')", "triage");
  await type(page, 'input:not([type="password"])', fixture.assignee);
  await click(page, "Assign case");
  await inPage(page, "document.body.innerText.includes('Revision 3: assign')", "assignment");
  const disposition = await page.evalPage(
    "(() => [...document.querySelectorAll('label')].find(" +
    "e=>e.textContent.includes('Disposition'))?.querySelector('select')?.value)()",
  );
  assert.equal(disposition, "unresolved");
  await click(page, "Record disposition");
  await inPage(page, "document.body.innerText.includes('Revision 4: dispose')", "disposition");
  await click(page, "Reconcile feedback");
  await inPage(page, "document.body.innerText.includes('Revision 5: reconcile')", "feedback");
  assert.equal(await page.evalPage(
    "document.body.innerText.includes(" + JSON.stringify(fixture.token) + ")",
  ), false);
  assert.equal(await page.evalPage(
    "document.body.innerText.includes(" + JSON.stringify(fixture.source_context) + ")",
  ), false);
  step = "durable_metrics"; python("verify");
  step = "browser_revocation";
  await click(page, "End session");
  await inPage(page, "!!document.querySelector('input[type=\"password\"]')", "logout");
  assert.equal(await page.evalPage(
    "document.body.innerText.includes('Revision 5: reconcile')",
  ), false);
  await type(page, 'input[type="password"]', fixture.revoked_token);
  await click(page, "Open synthetic session");
  await click(page, "Refresh queue");
  await inPage(page,
    "document.body.innerText.includes('Synthetic session expired or was rejected.')",
    "revocation");
  step = "audit_outage"; python("audit-deny"); auditDenied = true;
  assert.equal(await httpStatus(apiUrl + queue, fixture.token), 503);
  python("audit-restore"); auditDenied = false;
  console.log("SYNTHETIC_REDIS_CHROMIUM_PASS: UC-02 Redis to PostgreSQL to protected Chromium; Bank disabled");
}
async function stop(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([new Promise(done => processHandle.once("exit", done)), delay(2000)]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}
async function cleanup() {
  try { socket?.close(); } catch { /* no secrets in output */ }
  await stop(chrome);
  try { await vite?.close(); } catch { /* best effort */ }
  await stop(api);
  if (auditDenied) { try { python("audit-restore"); } catch { /* best effort */ } }
  if (fixture) { try { python("cleanup"); } catch { /* disposable schema inspection */ } }
  for (const directory of [chromeDir, fixtureDir]) {
    if (!directory) continue;
    for (let i = 0; i < 4; i++) {
      try { rmSync(directory, { recursive: true, force: true }); break; }
      catch { await delay(350); }
    }
  }
}
try { await execute(); }
catch {
  // The only failure output is a constant stage: no bearer, DB DSN, PII,
  // browser console, backend exception, or request payload can be logged.
  console.error("SYNTHETIC_CHROMIUM_FAILED stage=" + step);
  process.exitCode = 1;
} finally { await cleanup(); }

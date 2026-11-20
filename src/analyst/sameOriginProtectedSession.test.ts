import { afterEach, expect, it, vi } from "vitest";
import {
  createSameOriginAnalystSession,
  type HostVerifiedAnalystBinding,
} from "./sameOriginProtectedSession";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const created = {
  revision: 1, previous_revision: null, operation: "create",
  recorded_at: "2026-11-07T10:00:00.000001Z",
  reason_code: "source_evaluation", disposition: null,
  actor_ref: "a".repeat(64), assignee_ref: null,
  source_event_id: SOURCE, source_context_ref: "c".repeat(64),
  bank_execution: "unknown",
};
const history = { case_id: CASE, enforcement_activated: false, events: [created] };
const receipt = {
  case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
  disposition: null, bank_execution: "unknown", enforcement_activated: false,
};

function binding(override: Partial<HostVerifiedAnalystBinding> = {}): HostVerifiedAnalystBinding {
  return {
    tenantId: "tenant-a", epoch: "verified-session-1",
    csrfToken: () => "session-csrf-token-2026",
    onUnauthorized: vi.fn(),
    ...override,
  };
}
function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}
afterEach(() => vi.unstubAllGlobals());

it("is not an installed Bank session and rejects malformed host authority", () => {
  expect(() => createSameOriginAnalystSession(binding({ epoch: " " }))).toThrow();
  expect(() => createSameOriginAnalystSession(binding({ tenantId: "../tenant-b" }))).toThrow();
  expect(() => createSameOriginAnalystSession(binding({ tenantId: "tenant-a?role=admin" }))).toThrow();
});

it("uses only same-origin cookie transport, fresh CSRF and server-bound case paths", async () => {
  const fetchStub = vi.fn().mockResolvedValue(json(200, receipt));
  vi.stubGlobal("fetch", fetchStub);
  const session = createSameOriginAnalystSession(binding());
  expect(session.epoch).toBe("verified-session-1");
  await expect(session.writer.submit(CASE, history, { operation: "triage" }, "b".repeat(32)))
    .resolves.toMatchObject(receipt);
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [path, options] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/v1/tenants/tenant-a/cases/" + CASE + "/transitions/triage");
  expect(options).toMatchObject({
    method: "POST", credentials: "same-origin", mode: "same-origin",
    cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
  });
  const headers = new Headers(options.headers);
  expect(headers.get("X-CSRF-Token")).toBe("session-csrf-token-2026");
  expect(headers.get("Authorization")).toBeNull();
  expect(headers.get("X-Tenant-Id")).toBeNull();
  expect(headers.get("X-Role")).toBeNull();
  expect(JSON.parse(options.body as string)).toMatchObject({
    source_event_id: SOURCE, expected_revision: 1, idempotency_key: "b".repeat(32),
    reason_code: "analyst_triage",
  });
});

it("requires a valid host CSRF token before any POST and never logs it", async () => {
  const fetchStub = vi.fn();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchStub);
  try {
    for (const csrfToken of [() => null, () => "line\ninjection", () => { throw Error("secret"); }]) {
      const session = createSameOriginAnalystSession(binding({ csrfToken }));
      await expect(session.writer.submit(CASE, history, { operation: "triage" }, "b".repeat(32)))
        .rejects.toMatchObject({ kind: "access_denied" });
    }
    expect(fetchStub).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

it.each([401, 403, 404, 503])("redacts read denial %i without returning case evidence", async (status) => {
  const fetchStub = vi.fn().mockResolvedValue(json(status, { detail: "sensitive-customer-data" }));
  vi.stubGlobal("fetch", fetchStub);
  const session = createSameOriginAnalystSession(binding());
  await expect(session.reader.readQueue(25)).rejects.toMatchObject({ status });
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [path, options] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/v1/tenants/tenant-a/cases/queue?limit=25");
  expect(options.method).toBe("GET");
  expect(new Headers(options.headers).get("X-CSRF-Token")).toBeNull();
});

it("retires both ports on revoked session; a new verified epoch is separate", async () => {
  const fetchStub = vi.fn().mockResolvedValueOnce(json(401));
  vi.stubGlobal("fetch", fetchStub);
  const revoked = vi.fn();
  const first = createSameOriginAnalystSession(binding({ onUnauthorized: revoked }));
  await expect(first.reader.readQueue(25)).rejects.toMatchObject({ status: 401 });
  await expect(first.reader.readQueue(25)).rejects.toMatchObject({ status: 401 });
  await expect(first.writer.submit(CASE, history, { operation: "triage" }, "b".repeat(32)))
    .rejects.toMatchObject({ kind: "session_unavailable" });
  expect(fetchStub).toHaveBeenCalledTimes(1);
  expect(revoked).toHaveBeenCalledTimes(1);
  fetchStub.mockResolvedValueOnce(json(200, { ok: true }));
  const rotated = createSameOriginAnalystSession(binding({ epoch: "verified-session-2" }));
  expect(rotated.epoch).not.toBe(first.epoch);
  await expect(rotated.reader.readQueue(25)).resolves.toEqual({ ok: true });
  first.close();
  rotated.close();
});

it("fences late successful POST responses after concurrent 401 revocation", async () => {
  let resolvePost!: (response: Response) => void;
  const inFlight = new Promise<Response>((resolve) => { resolvePost = resolve; });
  const fetchStub = vi.fn().mockImplementationOnce(() => inFlight)
    .mockResolvedValueOnce(json(401));
  vi.stubGlobal("fetch", fetchStub);
  const revoked = vi.fn();
  const session = createSameOriginAnalystSession(binding({ onUnauthorized: revoked }));
  const writing = session.writer.submit(CASE, history, { operation: "triage" }, "b".repeat(32));
  await expect(session.reader.readQueue(25)).rejects.toMatchObject({ status: 401 });
  resolvePost(json(200, receipt));
  await expect(writing).rejects.toMatchObject({ kind: "outcome_unknown" });
  expect(revoked).toHaveBeenCalledTimes(1);
  expect(fetchStub).toHaveBeenCalledTimes(2);
});

import { afterEach, expect, it, vi } from "vitest";
import { openSyntheticLabSession } from "./syntheticLabTransport";

const CASE = "00000000-0000-4000-8000-000000000041";
const SOURCE = "00000000-0000-4000-8000-000000000042";
const initial = {
  case_id: CASE,
  enforcement_activated: false,
  events: [{
    revision: 1, previous_revision: null, operation: "create",
    recorded_at: "2026-11-07T10:00:00.000001Z",
    reason_code: "source_evaluation", disposition: null,
    actor_ref: "a".repeat(64), assignee_ref: null,
    source_event_id: SOURCE, source_context_ref: "c".repeat(64),
    bank_execution: "unknown",
  }],
};
const receipt = {
  case_id: CASE, source_event_id: SOURCE, revision: 2, operation: "triage",
  disposition: null, bank_execution: "unknown", enforcement_activated: false,
};
const key = "b".repeat(32);

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("fences a late successful POST when an overlapping 401 revokes the synthetic session", async () => {
  let finishPost!: (response: Response) => void;
  const pendingPost = new Promise<Response>((resolve) => { finishPost = resolve; });
  const fetched = vi.fn().mockReturnValueOnce(pendingPost).mockResolvedValueOnce(json(401, {
    detail: "never expose sensitive authentication details",
  }));
  vi.stubGlobal("fetch", fetched);
  const unauthorized = vi.fn();
  const session = openSyntheticLabSession("fictional-bearer", unauthorized);
  const writing = session.writer.submit(CASE, initial, { operation: "triage" }, key);
  await expect(session.reader.readQueue(25)).rejects.toMatchObject({ status: 401 });
  finishPost(json(200, receipt));
  // The server may have committed before revocation; a late ACK is not
  // permission to retry or confirm the action in a retired browser session.
  await expect(writing).rejects.toMatchObject({ kind: "outcome_unknown" });
  expect(unauthorized).toHaveBeenCalledTimes(1);
  expect(fetched).toHaveBeenCalledTimes(2);
  await expect(session.writer.submit(CASE, initial, { operation: "triage" }, key))
    .rejects.toMatchObject({ kind: "session_unavailable" });
  expect(fetched).toHaveBeenCalledTimes(2);
});

it("treats an already dispatched POST with a lost response after logout as outcome unknown", async () => {
  let loseReply!: (reason: Error) => void;
  const pendingPost = new Promise<Response>((_, reject) => { loseReply = reject; });
  const fetched = vi.fn().mockReturnValueOnce(pendingPost);
  vi.stubGlobal("fetch", fetched);
  const session = openSyntheticLabSession("fictional-bearer", vi.fn());
  const writing = session.writer.submit(CASE, initial, { operation: "triage" }, key);
  session.close();
  loseReply(new Error("sensitive network message"));
  await expect(writing).rejects.toMatchObject({ kind: "outcome_unknown" });
  expect(fetched).toHaveBeenCalledTimes(1);
});

it("discards a late protected read after logout instead of exposing its payload", async () => {
  let finishRead!: (response: Response) => void;
  const pendingRead = new Promise<Response>((resolve) => { finishRead = resolve; });
  const fetched = vi.fn().mockReturnValueOnce(pendingRead);
  vi.stubGlobal("fetch", fetched);
  const session = openSyntheticLabSession("fictional-bearer", vi.fn());
  const reading = session.reader.readQueue(25);
  session.close();
  finishRead(json(200, { items: [{ details: "sensitive fictional record" }] }));
  await expect(reading).rejects.toMatchObject({ status: 401 });
  expect(fetched).toHaveBeenCalledTimes(1);
});

it("preserves the definitive server 401 behavior for a directly rejected POST", async () => {
  const fetched = vi.fn().mockResolvedValue(json(401, { detail: "not for browser display" }));
  vi.stubGlobal("fetch", fetched);
  const unauthorized = vi.fn();
  const session = openSyntheticLabSession("fictional-bearer", unauthorized);
  await expect(session.writer.submit(CASE, initial, { operation: "triage" }, key))
    .rejects.toMatchObject({ kind: "session_unavailable" });
  expect(unauthorized).toHaveBeenCalledTimes(1);
  expect(fetched).toHaveBeenCalledTimes(1);
});

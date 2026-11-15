import { useEffect, useRef, useState } from "react";
import { CaseHistoryPanel } from "./CaseHistoryPanel";
import { CaseQueuePanel } from "./CaseQueuePanel";
import { parseProtectedCaseQueue, type CaseQueueProjection } from "./caseQueue";
import { parseLinkedCaseHistory, type LinkedCaseProjection } from "./caseQueueHistory";

/**
 * Issue #45: a deliberately unmounted read-only browser journey.
 *
 * The supplied port MUST be installed by a separately reviewed authenticated
 * same-origin client. This component cannot create a session, infer a tenant,
 * assert a role, send a bearer token, or authorize a case/payment action.
 * The current synthetic App MUST NOT import or mount it.
 */
export interface ProtectedCaseReadPort {
  readQueue(limit: number): Promise<unknown>;
  readHistory(caseId: string): Promise<unknown>;
}

const LIMIT = 25;

// A key per read-port object forces a fresh, empty subtree before a different
// reader/session can render. WeakMap avoids retaining old reader credentials or
// ports; returning to an earlier object still remounts because its old subtree
// was unmounted on the intervening switch.
const readerViewKeys = new WeakMap<ProtectedCaseReadPort, number>();
let nextReaderViewKey = 0;
function readerViewKey(reader: ProtectedCaseReadPort): number {
  const previous = readerViewKeys.get(reader);
  if (previous !== undefined) return previous;
  const created = ++nextReaderViewKey;
  readerViewKeys.set(reader, created);
  return created;
}

function redactedFailure(error: unknown): string {
  // Never display backend bodies, exception messages, tokens, or identifiers.
  const status = typeof error === "object" && error !== null &&
    "status" in error ? error.status : null;
  switch (status) {
    case 401: return "Protected session unavailable (401).";
    case 403: return "Case read permission denied (403).";
    case 404: return "Case unavailable for this session (404).";
    case 503: return "Protected case reader unavailable (503).";
    default: return "Protected case response rejected or unavailable.";
  }
}

function ReaderScopedJourney({ reader }: { readonly reader: ProtectedCaseReadPort }) {
  const revision = useRef(0);
  const [queue, setQueue] = useState<CaseQueueProjection | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [linked, setLinked] = useState<LinkedCaseProjection | null>(null);
  const [pending, setPending] = useState<"queue" | "history" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ignore results from requests that outlive the view.
  useEffect(() => () => { revision.current += 1; }, []);

  function clearView() {
    setQueue(null);
    setSelectedId("");
    setLinked(null);
  }

  async function refreshQueue() {
    const request = ++revision.current;
    clearView();
    setError(null);
    setPending("queue");
    try {
      const response = await reader.readQueue(LIMIT);
      if (request !== revision.current) return;
      const candidate = parseProtectedCaseQueue(response, LIMIT);
      setQueue(candidate);
      setSelectedId(candidate.items[0]?.case_id ?? "");
    } catch (reason: unknown) {
      if (request !== revision.current) return;
      clearView();
      setError(redactedFailure(reason));
    } finally {
      if (request === revision.current) setPending(null);
    }
  }

  function selectCase(caseId: string) {
    ++revision.current;
    setPending(null);
    setError(null);
    setLinked(null);
    setSelectedId(caseId);
  }

  async function loadHistory() {
    if (!queue || !queue.items.some((item) => item.case_id === selectedId)) return;
    const request = ++revision.current;
    setLinked(null);
    setError(null);
    setPending("history");
    try {
      const historyResponse = await reader.readHistory(selectedId);
      if (request !== revision.current) return;
      const candidate = parseLinkedCaseHistory(queue, historyResponse, selectedId, LIMIT);
      setLinked(candidate);
    } catch (reason: unknown) {
      if (request !== revision.current) return;
      // Even a successful earlier queue cannot authorize a newer failed read.
      clearView();
      setError(redactedFailure(reason));
    } finally {
      if (request === revision.current) setPending(null);
    }
  }

  return (
    <section aria-label="Inactive read-only analyst journey">
      <h2>Analyst queue and investigation history — read-only</h2>
      <p>
        Default-inactive integration exercise. No Bank authentication, ranking
        approval, case mutation, payment execution or enforcement is supplied.
      </p>
      <button type="button" onClick={() => void refreshQueue()} disabled={pending !== null}>
        Refresh authorized read-only queue
      </button>
      {pending && <p role="status">Protected {pending} read pending…</p>}
      {error && <p role="alert">{error}</p>}
      {queue && <CaseQueuePanel queue={queue} />}
      {queue && queue.items.length > 0 && (
        <div>
          <label htmlFor="analyst-case-selection">Case to inspect (pseudonymous)</label>
          <select
            id="analyst-case-selection"
            value={selectedId}
            disabled={pending !== null}
            onChange={(event) => selectCase(event.target.value)}
          >
            {queue.items.map((item) => (
              <option key={item.case_id} value={item.case_id}>{item.case_id}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending !== null || !selectedId}
            onClick={() => void loadHistory()}
          >
            Inspect immutable case history
          </button>
        </div>
      )}
      {linked && <CaseHistoryPanel history={linked.history} />}
    </section>
  );
}

// A mounted reader identity change is a hard data boundary: React discards the
// old state (queue, selection, history, pending, error) before committing the
// next reader's empty view. Unmount cleanup above invalidates late A results.
// Real Bank session/tenant refresh without changing port identity remains a
// separate contract to be verified before any authenticated mount.
export function ReadOnlyAnalystJourney({
  reader,
  sessionEpoch,
}: {
  readonly reader: ProtectedCaseReadPort;
  /** Rotated by the installed session adapter on every tenant/credential change. */
  readonly sessionEpoch?: string;
}) {
  // The same read-port object can be rebound by a trusted adapter after
  // credential rotation. Its cached React subtree must never survive that
  // boundary, even when reader identity stays constant.
  return <ReaderScopedJourney key={`${readerViewKey(reader)}:${sessionEpoch ?? "inert"}`} reader={reader} />;
}

import { useEffect, useRef, useState } from "react";
import { CaseHistoryPanel } from "./CaseHistoryPanel";
import { CaseQueuePanel } from "./CaseQueuePanel";
import { parseProtectedCaseHistory, type CaseDisposition, type CaseHistoryProjection } from "./caseHistory";
import { parseProtectedCaseQueue, type CaseQueueProjection } from "./caseQueue";
import { parseLinkedCaseHistory } from "./caseQueueHistory";
import { CaseTransitionFailure, type CaseTransitionProposal, type CaseTransitionReceipt } from "./protectedCaseTransitionPort";
import type { ProtectedCaseReadPort } from "./ReadOnlyAnalystJourney";
import "./syntheticAnalystLab.css";

const LIMIT = 25;
type CaseReference = { caseId: string; sourceEventId: string; contextRef: string };

/** Neutral analyst workflow: no credentials, tenant assertion, transport or bank authority. */
export interface ProtectedCaseWritePort {
  submit(caseId: string, history: unknown, proposal: CaseTransitionProposal, idempotencyKey: string):
    Promise<CaseTransitionReceipt>;
}
export interface AnalystInvestigationSession {
  readonly reader: ProtectedCaseReadPort;
  readonly writer?: ProtectedCaseWritePort;
}

function terminalReadFailure(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  return status === 401 || status === 403 || status === 404 || status === 503;
}

function readError(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (status === 401) return "Protected session unavailable (401).";
  if (status === 403) return "Case read permission denied (403).";
  if (status === 404) return "Case unavailable for this session (404).";
  if (status === 503) return "Protected case service unavailable (503).";
  return "Case data could not be verified. Refresh and try again.";
}

export function AnalystInvestigation({ session }: { readonly session: AnalystInvestigationSession }) {
  const [queue, setQueue] = useState<CaseQueueProjection | null>(null);
  const [selected, setSelected] = useState("");
  const [uncertainWrites, setUncertainWrites] = useState<ReadonlyMap<string, number>>(new Map());
  const [reference, setReference] = useState<CaseReference | null>(null);
  const [history, setHistory] = useState<CaseHistoryProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assignee, setAssignee] = useState("");
  const [disposition, setDisposition] = useState<CaseDisposition>("confirmed_fraud");
  const requestPending = useRef(false);
  const activeView = useRef(true);

  useEffect(() => {
    activeView.current = true;
    return () => { activeView.current = false; };
  }, []);

  async function run(task: () => Promise<void>, failure: (reason: unknown) => void) {
    if (requestPending.current) return;
    requestPending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (reason: unknown) {
      if (activeView.current) failure(reason);
    } finally {
      requestPending.current = false;
      if (activeView.current) setBusy(false);
    }
  }

  async function readHistory(ref: CaseReference) {
    const projection = parseProtectedCaseHistory(await session.reader.readHistory(ref.caseId), ref.caseId);
    const initial = projection.events[0];
    if (initial.source_event_id !== ref.sourceEventId || initial.source_context_ref !== ref.contextRef) {
      throw new Error("Unexpected case source");
    }
    return projection;
  }

  // Queue refresh and case selection are hard display/action boundaries.
  // Preserve uncertainWrites: an ambiguous POST must remain blocked even when
  // the queue is reloaded or the case is selected again.
  function clearOpenedCase() {
    setReference(null);
    setHistory(null);
    setAssignee("");
    setDisposition("confirmed_fraud");
  }

  function refreshQueue() {
    void run(async () => {
      setQueue(null);
      setSelected("");
      clearOpenedCase();
      const projection = parseProtectedCaseQueue(await session.reader.readQueue(LIMIT), LIMIT);
      if (!activeView.current) return;
      setQueue(projection);
      setSelected(projection.items[0]?.case_id ?? "");
    }, (reason) => {
      setHistory(null);
      setReference(null);
      setError(readError(reason));
    });
  }

  function openCase() {
    if (!queue || !selected) return;
    void run(async () => {
      setHistory(null);
      setReference(null);
      const candidate = parseLinkedCaseHistory(
        queue, await session.reader.readHistory(selected), selected, LIMIT,
      );
      if (!activeView.current) return;
      setReference({
        caseId: selected,
        sourceEventId: candidate.selectedCase.source_event_id,
        contextRef: candidate.selectedCase.source_context_ref,
      });
      setHistory(candidate.history);
      setAssignee("");
      setDisposition("confirmed_fraud");
    }, (reason) => {
      if (terminalReadFailure(reason)) {
        setQueue(null);
        setSelected("");
        clearOpenedCase();
      }
      setError(readError(reason));
    });
  }

  function refreshHistory() {
    if (!reference) return;
    void run(async () => {
      setHistory(null);
      const projection = await readHistory(reference);
      if (activeView.current) setHistory(projection);
    }, (reason) => {
      if (terminalReadFailure(reason)) {
        setQueue(null);
        setSelected("");
        clearOpenedCase();
      }
      setError(readError(reason));
    });
  }

  function submit(proposal: CaseTransitionProposal) {
    if (!history || !reference || writesPaused || !session.writer) return;
    const writer = session.writer;
    const { caseId } = reference;
    const priorRevision = history.events.length;
    function requireAdvancingHistory() {
      setUncertainWrites((previous) => new Map(previous).set(caseId, priorRevision));
    }
    void run(async () => {
      setHistory(null);
      setQueue(null);
      setSelected("");
      const receipt = await writer.submit(
        reference.caseId, history, proposal, crypto.randomUUID().replaceAll("-", ""),
      );
      if (!activeView.current) return;
      try {
        const updated = await readHistory(reference);
        const event = updated.events[receipt.revision - 1];
        if (event?.operation !== receipt.operation || event?.disposition !== receipt.disposition) {
          throw new Error("Missing recorded case action");
        }
        if (activeView.current) setHistory(updated);
      } catch (reason: unknown) {
        if (activeView.current) {
          // A validated write receipt is not proof that the session can still
          // read this case. Keep the revision fence, but discard identifiers
          // and controls immediately on a terminal authorization/read failure.
          requireAdvancingHistory();
          if (terminalReadFailure(reason)) {
            setQueue(null);
            setSelected("");
            clearOpenedCase();
            setError(readError(reason));
          } else {
            setNotice("Action acknowledged. Refresh case history before continuing.");
          }
        }
        return;
      }
      if (activeView.current) setNotice("Case action recorded.");
    }, (reason) => {
      if (reason instanceof CaseTransitionFailure &&
          (reason.kind === "session_unavailable" || reason.kind === "access_denied")) {
        setQueue(null);
        setSelected("");
        clearOpenedCase();
      }
      if (!(reason instanceof CaseTransitionFailure) || reason.kind === "outcome_unknown") {
        requireAdvancingHistory();
      }
      setError(reason instanceof CaseTransitionFailure
        ? reason.message : "The action could not be confirmed. Refresh case history before retrying.");
    });
  }

  const latest = history?.events.at(-1);
  const canWrite = typeof session.writer?.submit === "function";
  const uncertainRevision = reference ? uncertainWrites.get(reference.caseId) : undefined;
  const writesPaused = uncertainRevision !== undefined && (latest?.revision ?? 0) <= uncertainRevision;
  return (
    <>
      <div className="analyst-lab-actions">
        <button type="button" disabled={busy} onClick={refreshQueue}>Refresh queue</button>
        {reference && (
          <button type="button" disabled={busy} onClick={refreshHistory}>Refresh case history</button>
        )}
      </div>
      {busy && <p role="status">Protected case request in progress.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {queue && <CaseQueuePanel queue={queue} />}
      {queue && (
        <section aria-label="Visible queue snapshot counts">
          <h3>Visible queue snapshot</h3>
          <p>Open cases on this page: {queue.items.length} (requested maximum: {LIMIT})</p>
          <p>Created: {queue.items.filter((item) => item.status === "create").length};
            triaged: {queue.items.filter((item) => item.status === "triage").length};
            assigned: {queue.items.filter((item) => item.status === "assign").length}</p>
          <p>These page-only counts are not total backlog, fraud-detection accuracy,
            turnaround performance or Bank-approved KPIs.</p>
        </section>
      )}
      {queue && queue.items.length > 0 && (
        <div className="analyst-lab-actions">
          <label>Case to investigate
            <select disabled={busy} value={selected} onChange={(event) => {
              setSelected(event.target.value);
              clearOpenedCase();
            }}>
              {queue.items.map((item) => <option key={item.case_id} value={item.case_id}>{item.case_id}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !selected} onClick={openCase}>Open case</button>
        </div>
      )}
      {history && <CaseHistoryPanel history={history} />}
      {canWrite && writesPaused && <p role="status">Case actions are paused until a newer revision appears in case history.</p>}
      {canWrite && latest && !writesPaused && (
        <section aria-label="Case actions" className="analyst-lab-actions">
          {latest.operation === "create" && (
            <button type="button" disabled={busy} onClick={() => submit({ operation: "triage" })}>
              Triage case
            </button>
          )}
          {latest.operation === "triage" && (
            <form onSubmit={(event) => {
              event.preventDefault();
              submit({ operation: "assign", assigneeSelector: assignee });
            }}>
              <label>Assignee reference
                <input value={assignee} onChange={(event) => setAssignee(event.target.value)} required />
              </label>
              <button type="submit" disabled={busy}>Assign case</button>
            </form>
          )}
          {(latest.operation === "assign" || latest.operation === "dispose" || latest.operation === "correct") && (
            <form onSubmit={(event) => {
              event.preventDefault();
              submit({ operation: latest.operation === "assign" ? "dispose" : "correct", disposition });
            }}>
              <label>Disposition
                <select value={disposition} onChange={(event) => setDisposition(event.target.value as CaseDisposition)}>
                  <option value="confirmed_fraud">Confirmed fraud</option>
                  <option value="confirmed_legitimate">Confirmed legitimate</option>
                  <option value="unresolved">Unresolved</option>
                </select>
              </label>
              <button type="submit" disabled={busy || latest.disposition === disposition}>
                {latest.operation === "assign" ? "Record disposition" : "Correct disposition"}
              </button>
            </form>
          )}
          {(latest.operation === "dispose" || latest.operation === "correct") && (
            <button type="button" disabled={busy} onClick={() => submit({ operation: "reconcile" })}>
              Reconcile feedback
            </button>
          )}
        </section>
      )}
    </>
  );
}


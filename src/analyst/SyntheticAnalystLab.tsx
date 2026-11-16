import { useEffect, useRef, useState, type FormEvent } from "react";
import { CaseHistoryPanel } from "./CaseHistoryPanel";
import { CaseQueuePanel } from "./CaseQueuePanel";
import { parseProtectedCaseHistory, type CaseDisposition, type CaseHistoryProjection } from "./caseHistory";
import { parseProtectedCaseQueue, type CaseQueueProjection } from "./caseQueue";
import { parseLinkedCaseHistory } from "./caseQueueHistory";
import { CaseTransitionFailure, type CaseTransitionProposal } from "./protectedCaseTransitionPort";
import { openSyntheticLabSession } from "./syntheticLabTransport";
import "./syntheticAnalystLab.css";

const LIMIT = 25;
type Session = ReturnType<typeof openSyntheticLabSession>;
type CaseReference = { caseId: string; sourceEventId: string; contextRef: string };

function readError(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (status === 403) return "Case read permission denied.";
  if (status === 404) return "Case unavailable for this session.";
  return "Case data could not be verified. Refresh and try again.";
}

function Investigation({ session }: { readonly session: Session }) {
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

  function refreshQueue() {
    void run(async () => {
      setQueue(null);
      setSelected("");
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
    }, (reason) => setError(readError(reason)));
  }

  function refreshHistory() {
    if (!reference) return;
    void run(async () => {
      setHistory(null);
      const projection = await readHistory(reference);
      if (activeView.current) setHistory(projection);
    }, (reason) => setError(readError(reason)));
  }

  function submit(proposal: CaseTransitionProposal) {
    if (!history || !reference || writesPaused) return;
    const { caseId } = reference;
    const priorRevision = history.events.length;
    function requireAdvancingHistory() {
      setUncertainWrites((previous) => new Map(previous).set(caseId, priorRevision));
    }
    void run(async () => {
      setHistory(null);
      setQueue(null);
      setSelected("");
      const receipt = await session.writer.submit(
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
      } catch {
        if (activeView.current) {
          requireAdvancingHistory();
          setNotice("Action acknowledged. Refresh case history before continuing.");
        }
        return;
      }
      if (activeView.current) setNotice("Case action recorded.");
    }, (reason) => {
      if (!(reason instanceof CaseTransitionFailure) || reason.kind === "outcome_unknown") {
        requireAdvancingHistory();
      }
      setError(reason instanceof CaseTransitionFailure
        ? reason.message : "The action could not be confirmed. Refresh case history before retrying.");
    });
  }

  const latest = history?.events.at(-1);
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
      {queue && queue.items.length > 0 && (
        <div className="analyst-lab-actions">
          <label>Case to investigate
            <select disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)}>
              {queue.items.map((item) => <option key={item.case_id} value={item.case_id}>{item.case_id}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !selected} onClick={openCase}>Open case</button>
        </div>
      )}
      {history && <CaseHistoryPanel history={history} />}
      {writesPaused && <p role="status">Case actions are paused until a newer revision appears in case history.</p>}
      {latest && !writesPaused && (
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

export function SyntheticAnalystLab() {
  const [session, setSession] = useState<Session | null>(null);
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState("");

  function openSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credential || /\s/.test(credential)) {
      setMessage("Enter a synthetic bearer credential without whitespace.");
      return;
    }
    setSession(openSyntheticLabSession(credential, () => {
      setSession(null);
      setMessage("Synthetic session expired or was rejected.");
    }));
    setCredential("");
    setMessage("");
  }

  function closeSession() {
    session?.close();
    setSession(null);
    setMessage("Synthetic session ended.");
  }

  return (
    <main className="analyst-lab" aria-label="Synthetic analyst lab">
      <header>
        <h1>Gasha analyst lab</h1>
        <p>Synthetic cases for tenant-a. Case actions have no payment execution authority.</p>
      </header>
      {message && <p role="status">{message}</p>}
      {session ? (
        <>
          <button type="button" onClick={closeSession}>End session</button>
          <Investigation session={session} />
        </>
      ) : (
        <form onSubmit={openSession} className="analyst-lab-actions">
          <label>Synthetic bearer credential
            <input type="password" autoComplete="off" maxLength={200} required value={credential}
              onChange={(event) => setCredential(event.target.value)} />
          </label>
          <button type="submit">Open synthetic session</button>
        </form>
      )}
    </main>
  );
}

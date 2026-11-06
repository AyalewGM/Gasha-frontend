import type { CaseHistoryProjection } from "./caseHistory";

/**
 * Unmounted, read-only analyst history view. Not linked from the current
 * loopback synthetic decision console; no fetch, credentials or case mutation.
 */
export function CaseHistoryPanel({ history }: { history: CaseHistoryProjection }) {
  return (
    <section aria-label="Read-only case history">
      <h2>Analyst case history — read-only</h2>
      <p>
        This history is not proof of a Bank-executed intervention, settlement,
        prevented loss, or payment enforcement.
      </p>
      <p>Recorded times retain their original timezone offsets and up to six fractional digits.</p>
      <p>Case reference: <code>{history.case_id}</code></p>
      <ol aria-label="Case events">
        {history.events.map((event) => (
          <li key={event.revision}>
            <h3>Revision {event.revision}: {event.operation}</h3>
            <dl>
              <dt>Recorded (source offset; full precision)</dt>
              <dd>
                <time dateTime={event.recorded_at}>{event.recorded_at}</time>
              </dd>
              <dt>Reason</dt>
              <dd>{event.reason_code}</dd>
              <dt>Disposition</dt>
              <dd>{event.disposition ?? "not recorded"}</dd>
              <dt>Actor reference (pseudonymous)</dt>
              <dd><code>{event.actor_ref.slice(0, 12)}…</code></dd>
              <dt>Bank execution</dt>
              <dd>{event.bank_execution}</dd>
            </dl>
          </li>
        ))}
      </ol>
      <p>No edit, assign, disposition, feedback or bank-action control is available in this view.</p>
    </section>
  );
}

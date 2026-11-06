import type { CaseQueueProjection, CaseQueueStatus } from "./caseQueue";

const STATUS_LABELS: Readonly<Record<CaseQueueStatus, string>> = {
  create: "Created",
  triage: "Triaged",
  assign: "Assigned",
};

/**
 * Inert, accessible presentation of a previously decoded #45 case queue.
 * Not imported by the synthetic App. No HTTP, identity, sessions, local
 * storage, case transitions or Bank-action controls are implemented here.
 * An installed trusted reader and independently reviewed authenticated
 * ingress are separate prerequisites before any protected UI is mounted.
 */
export function CaseQueuePanel({ queue }: { readonly queue: CaseQueueProjection }) {
  return (
    <section aria-label="Read-only analyst case queue">
      <h2>Analyst case queue — read-only</h2>
      <p>
        Reader-supplied order is illustrative until a Bank-approved ranking
        policy and authenticated source are independently verified. This
        projection does not prove fraud, payment execution or prevented loss.
      </p>
      <dl>
        <dt>Ranking policy label (not approval)</dt>
        <dd><code>{queue.ranking_policy_version}</code></dd>
        <dt>Snapshot time (offset-aware)</dt>
        <dd><time dateTime={queue.generated_at}>{queue.generated_at}</time></dd>
        <dt>Bank ranking approved</dt>
        <dd>{queue.bank_ranking_approved ? "yes" : "no"}</dd>
        <dt>Payment enforcement activated</dt>
        <dd>{queue.enforcement_activated ? "yes" : "no"}</dd>
      </dl>
      {queue.items.length === 0 ? (
        <p role="status">No open cases in this read-only projection.</p>
      ) : (
        <table>
          <caption>Open cases ordered by the supplied, unapproved rank</caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Case reference (pseudonymous)</th>
              <th scope="col">Scenario identifiers</th>
              <th scope="col">Stage</th>
              <th scope="col">Assignee reference (pseudonymous)</th>
              <th scope="col">Last updated (offset-aware)</th>
              <th scope="col">Bank execution</th>
            </tr>
          </thead>
          <tbody>
            {queue.items.map((item) => (
              <tr key={item.case_id}>
                <td>{item.rank}</td>
                <td><code>{item.case_id}</code></td>
                <td>{item.scenario_ids.join(", ")}</td>
                <td>{STATUS_LABELS[item.status]}</td>
                <td>
                  {item.assignee_ref
                    ? <code>{item.assignee_ref.slice(0, 12)}…</code>
                    : "unassigned"}
                </td>
                <td><time dateTime={item.updated_at}>{item.updated_at}</time></td>
                <td>{item.bank_execution}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        No edit, disposition, feedback, approval or intervention control is
        available in this projection. Tenant scope and permission must be
        enforced by the protected backend, not inferred from these labels.
      </p>
    </section>
  );
}

import type { FoundingFeatureEvidence } from "./caseFeatureEvidence";

/** Project only strictly decoded, synthetic creation-source evidence. */
export function FoundingEvidencePanel({ evidence }: { readonly evidence: FoundingFeatureEvidence }) {
  return (
    <section aria-label="Founding-event evidence">
      <h3>Founding-event evidence — synthetic; not Bank-attested</h3>
      <p>This creation-source snapshot is not proof of fraud, APP deception,
        Bank execution, payment intervention or settlement.</p>
      {evidence.availability === "not_recorded" ? (
        <p>Founding-event feature observations were not recorded for this case.</p>
      ) : (
        <>
          <dl>
            <dt>Evidence cutoff (source timezone)</dt>
            <dd><time dateTime={evidence.decisionAsOf}>{evidence.decisionAsOf}</time></dd>
            <dt>Eligible observations</dt>
            <dd>{evidence.eligibleObservations}</dd>
            <dt>Late observations</dt>
            <dd>{evidence.lateObservations}</dd>
            <dt>Non-prior observations</dt>
            <dd>{evidence.nonpriorObservations}</dd>
          </dl>
          <h4>Unavailable signals</h4>
          {evidence.unavailableSignals.length === 0 ? (
            <p>No unavailable signals recorded.</p>
          ) : (
            <ul>{evidence.unavailableSignals.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
          )}
        </>
      )}
    </section>
  );
}

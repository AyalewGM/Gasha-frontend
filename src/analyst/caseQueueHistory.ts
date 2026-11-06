import { parseProtectedCaseHistory, type CaseHistoryProjection } from "./caseHistory";
import { parseProtectedCaseQueue, type CaseQueueItem, type CaseQueueProjection } from "./caseQueue";

/**
 * Read-only issue #45 join of two separately validated server projections.
 *
 * This is NOT an authentication, tenant-authorization or freshness guarantee.
 * A future installed reader must independently authorize each request and
 * bind both responses to the same session, principal, tenant and snapshot.
 * Never import or mount this from the loopback synthetic decision console.
 */
export interface LinkedCaseProjection {
  readonly queue: CaseQueueProjection;
  readonly selectedCase: CaseQueueItem;
  readonly history: CaseHistoryProjection;
}

function invalid(): never {
  // Never echo a server body, identifier or untrusted error to the screen.
  throw new Error("Inconsistent protected case-queue/history projections");
}

const FRACTION = /\.(\d{1,6})(?=(?:Z|[+-]\d{2}:\d{2})$)/;

/** Compare accepted offset-aware instants without losing microseconds. */
function micros(timestamp: string): bigint {
  const fraction = FRACTION.exec(timestamp)?.[1] ?? "";
  const remainder = fraction.padEnd(6, "0").slice(3);
  return BigInt(Date.parse(timestamp)) * 1000n + BigInt(remainder || "0");
}

/**
 * Fail closed if a history response is from a different source, revision or
 * snapshot than an open ranked-queue item. A stale queue/history pair must be
 * refreshed by a future authenticated reader, not silently combined.
 *
 * Both decoders reject extra fields, client-asserted Bank authority, and
 * malformed case identity/provenance before this cross-projection comparison.
 */
export function parseLinkedCaseHistory(
  queueResponse: unknown,
  historyResponse: unknown,
  expectedCaseId: string,
  requestedLimit: number,
): LinkedCaseProjection {
  const queue = parseProtectedCaseQueue(queueResponse, requestedLimit);
  const history = parseProtectedCaseHistory(historyResponse, expectedCaseId);
  const selectedCase = queue.items.find((item) => item.case_id === expectedCaseId);
  if (!selectedCase) invalid();

  const first = history.events[0];
  const last = history.events[history.events.length - 1];
  if (
    !first || !last ||
    history.events.length !== selectedCase.revision ||
    first.operation !== "create" ||
    first.source_event_id !== selectedCase.source_event_id ||
    first.source_context_ref !== selectedCase.source_context_ref ||
    last.operation !== selectedCase.status ||
    last.revision !== selectedCase.revision ||
    last.assignee_ref !== selectedCase.assignee_ref ||
    micros(first.recorded_at) !== micros(selectedCase.created_at) ||
    micros(last.recorded_at) !== micros(selectedCase.updated_at) ||
    micros(last.recorded_at) > micros(queue.generated_at)
  ) invalid();

  return Object.freeze({ queue, selectedCase, history });
}

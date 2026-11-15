import { parseProtectedCaseHistory, type CaseDisposition, type CaseOperation } from "./caseHistory";
import { isCaseIdentifier, protectedCasesPath } from "./protectedCasePath";

type ExistingCaseOperation = Exclude<CaseOperation, "create">;

export type CaseTransitionProposal =
  | { readonly operation: "triage" | "reconcile" }
  | { readonly operation: "assign"; readonly assigneeSelector: string }
  | { readonly operation: "dispose" | "correct"; readonly disposition: CaseDisposition };

type TransitionBody = Readonly<{
  source_event_id: string;
  expected_revision: number;
  idempotency_key: string;
  reason_code: string;
  assignee_selector?: string;
  disposition?: CaseDisposition;
}>;

export type BoundCasePost = (relativePath: string, body: TransitionBody) => Promise<{
  readonly status: number;
  readonly payload?: unknown;
}>;

export interface CaseTransitionReceipt {
  readonly case_id: string;
  readonly source_event_id: string;
  readonly revision: number;
  readonly operation: ExistingCaseOperation;
  readonly disposition: CaseDisposition | null;
  readonly bank_execution: "unknown";
  readonly enforcement_activated: false;
}

const DISPOSITION_REASON: Readonly<Record<CaseDisposition, string>> = {
  confirmed_fraud: "fraud_evidence",
  confirmed_legitimate: "legitimate_evidence",
  unresolved: "needs_review",
};

const FAILURE_MESSAGE = {
  invalid_proposal: "This action does not match the current case history.",
  session_unavailable: "The protected session expired or was revoked. Reconnect and refresh the case.",
  access_denied: "This session cannot access that case or action.",
  refresh_required: "The case changed. Refresh its history before proposing another action.",
  request_rejected: "The server rejected this case action. Refresh the case history.",
  outcome_unknown: "The action could not be confirmed. Refresh the case history before retrying.",
} as const;

export class CaseTransitionFailure extends Error {
  readonly kind: keyof typeof FAILURE_MESSAGE;

  constructor(kind: keyof typeof FAILURE_MESSAGE) {
    super(FAILURE_MESSAGE[kind]);
    this.kind = kind;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(): never {
  throw new CaseTransitionFailure("invalid_proposal");
}

function parseProposal(
  proposal: unknown, previous: CaseOperation, disposition: CaseDisposition | null,
) {
  const value = asRecord(proposal);
  if (!value) invalid();
  switch (value.operation) {
    case "triage":
      if (previous !== "create" || !hasExactKeys(value, ["operation"])) invalid();
      return { operation: value.operation, fields: { reason_code: "analyst_triage" } } as const;
    case "assign":
      if (previous !== "triage" || !hasExactKeys(value, ["operation", "assigneeSelector"]) ||
        !isCaseIdentifier(value.assigneeSelector)) invalid();
      return {
        operation: value.operation,
        fields: { reason_code: "investigation_assigned", assignee_selector: value.assigneeSelector },
      } as const;
    case "dispose":
    case "correct": {
      const operation = value.operation;
      const proposed = value.disposition;
      if (!hasExactKeys(value, ["operation", "disposition"]) ||
        (proposed !== "confirmed_fraud" && proposed !== "confirmed_legitimate" && proposed !== "unresolved") ||
        (operation === "dispose" ? previous !== "assign" :
          ((previous !== "dispose" && previous !== "correct") || proposed === disposition))) invalid();
      return {
        operation, fields: {
          reason_code: operation === "dispose" ? DISPOSITION_REASON[proposed] : "corrected_finding",
          disposition: proposed,
        },
      } as const;
    }
    case "reconcile":
      if ((previous !== "dispose" && previous !== "correct") ||
        !hasExactKeys(value, ["operation"])) invalid();
      return { operation: value.operation, fields: { reason_code: "feedback_reconciled" } } as const;
    default:
      return invalid();
  }
}

const RECEIPT_KEYS = [
  "case_id", "source_event_id", "revision", "operation", "disposition",
  "bank_execution", "enforcement_activated",
] as const;

/**
 * Unmounted transition adapter. The installed composition must own the
 * verified tenant, session and CSRF controls, redirect/cache policy and
 * transport. This port never retries a POST. Reuse the same idempotency key
 * only for an exact repeat of the original proposal after reconciliation.
 */
export function createProtectedCaseTransitionPort(tenant: string, post: BoundCasePost) {
  const base = protectedCasesPath(tenant);
  if (base === null || typeof post !== "function") invalid();
  let sessionUnavailable = false;

  return Object.freeze({
    async submit(
      caseId: string, history: unknown, proposal: CaseTransitionProposal, idempotencyKey: string,
    ): Promise<CaseTransitionReceipt> {
      if (sessionUnavailable) throw new CaseTransitionFailure("session_unavailable");
      if (!isCaseIdentifier(caseId) || typeof idempotencyKey !== "string" ||
        idempotencyKey.length !== 32 || !/^[a-f0-9]+$/.test(idempotencyKey)) invalid();

      let latest;
      try {
        latest = parseProtectedCaseHistory(history, caseId).events.at(-1);
      } catch {
        invalid();
      }
      if (!latest) invalid();
      const { operation, fields } = parseProposal(proposal, latest.operation, latest.disposition);
      const body: TransitionBody = Object.freeze({
        source_event_id: latest.source_event_id,
        expected_revision: latest.revision,
        idempotency_key: idempotencyKey,
        ...fields,
      });

      let response: Awaited<ReturnType<BoundCasePost>>;
      try {
        response = await post(`${base}/${caseId}/transitions/${operation}`, body);
      } catch {
        throw new CaseTransitionFailure("outcome_unknown");
      }
      if (response?.status === 401) {
        sessionUnavailable = true;
        throw new CaseTransitionFailure("session_unavailable");
      }
      // A late POST result after another request invalidates the session is
      // ambiguous for this client, even if the server may have committed it.
      if (sessionUnavailable) throw new CaseTransitionFailure("outcome_unknown");

      switch (response?.status) {
        case 403:
        case 404: throw new CaseTransitionFailure("access_denied");
        case 409: throw new CaseTransitionFailure("refresh_required");
        case 422: throw new CaseTransitionFailure("request_rejected");
        case 200: break;
        default: throw new CaseTransitionFailure("outcome_unknown");
      }

      const receipt: CaseTransitionReceipt = {
        case_id: caseId, source_event_id: body.source_event_id,
        revision: body.expected_revision + 1, operation,
        disposition: body.disposition ?? null,
        bank_execution: "unknown", enforcement_activated: false,
      };
      const payload = asRecord(response.payload);
      if (!payload || !hasExactKeys(payload, RECEIPT_KEYS) ||
        !RECEIPT_KEYS.every((field) => payload[field] === receipt[field])) {
        throw new CaseTransitionFailure("outcome_unknown");
      }
      return Object.freeze(receipt);
    },
  });
}

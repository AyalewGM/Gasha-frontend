import type { ProtectedCaseReadPort } from "./ReadOnlyAnalystJourney";

/**
 * Future installed composition supplies a same-origin GET transport bound to
 * one verified session. It owns credentials, cache and redirect policy, and
 * must create a fresh port when the session or tenant changes.
 */
export type BoundCaseGet = (relativePath: string) => Promise<{
  readonly status: number;
  readonly payload?: unknown;
}>;

const TENANT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class ProtectedCaseReadFailure extends Error {
  readonly status: number | null;

  constructor(status: number | null = null) {
    super("Protected case read unavailable");
    this.status = status;
  }
}

/**
 * Adapt session-bound GET results to the existing inert journey. Callers
 * supply the tenant from trusted session composition, never from a UI choice.
 * The journey still validates every successful payload before rendering.
 */
export function createProtectedCaseReadPort(
  tenant: string,
  get: BoundCaseGet,
): ProtectedCaseReadPort {
  if (typeof tenant !== "string" || tenant !== tenant.trim() ||
    !TENANT_SEGMENT.test(tenant) || typeof get !== "function") {
    throw new ProtectedCaseReadFailure();
  }
  const base = `/v1/tenants/${tenant}/cases`;
  let sessionUnavailable = false;

  async function read(path: string): Promise<unknown> {
    if (sessionUnavailable) throw new ProtectedCaseReadFailure(401);
    let response: Awaited<ReturnType<BoundCaseGet>>;
    try {
      response = await get(path);
    } catch {
      throw new ProtectedCaseReadFailure(sessionUnavailable ? 401 : null);
    }

    // A revoked or expired session may have other reads in flight.
    if (response?.status === 401) sessionUnavailable = true;
    if (sessionUnavailable) throw new ProtectedCaseReadFailure(401);

    switch (response?.status) {
      case 200: return response.payload;
      case 403:
      case 404:
      case 503: throw new ProtectedCaseReadFailure(response.status);
      default: throw new ProtectedCaseReadFailure();
    }
  }

  return Object.freeze({
    async readQueue(limit: number) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ProtectedCaseReadFailure();
      }
      return read(`${base}/queue?limit=${limit}`);
    },
    async readHistory(caseId: string) {
      if (typeof caseId !== "string" || caseId !== caseId.trim() || !CASE_ID.test(caseId)) {
        throw new ProtectedCaseReadFailure();
      }
      return read(`${base}/${caseId}/history`);
    },
  });
}

import { createProtectedCaseReadPort } from "./protectedCaseReadPort";
import { createProtectedCaseTransitionPort } from "./protectedCaseTransitionPort";
import type { ProtectedCaseWritePort } from "./AnalystInvestigation";
import type { InstalledProtectedAnalystSession } from "./installedProtectedSession";

/**
 * Proposed, uninstalled BFF transport boundary for #9.
 *
 * Only a trusted host composition may obtain tenant scope and epoch from a
 * server-verified session. The browser must not derive either from a query
 * string, local storage, synthetic console, form or editable control.
 *
 * This uses same-origin, HttpOnly-cookie session transport with a fresh
 * host-provided CSRF token per mutation. The current protected FastAPI app
 * authenticates bearer credentials, NOT these cookies: an independently
 * reviewed same-origin BFF/CSRF/session contract is still required before
 * this factory may be installed. The default installed getter stays null.
 */
export interface HostVerifiedAnalystBinding {
  readonly tenantId: string;
  readonly epoch: string;
  readonly csrfToken: () => string | null;
  readonly onUnauthorized: () => void;
}

export interface SameOriginAnalystSession extends InstalledProtectedAnalystSession {
  readonly writer: ProtectedCaseWritePort;
  close(): void;
}

const SAFE_CSRF = /^[\x21-\x7e]{1,512}$/;

/**
 * Never appends tenant/role/capability headers, tokens or URL query authority.
 * A server-side session/CSRF verifier must authorize every request. The
 * installed route does not import this module until a separate reviewed
 * composition deliberately wires it.
 */
export function createSameOriginAnalystSession(
  binding: HostVerifiedAnalystBinding,
): SameOriginAnalystSession {
  if (
    !binding ||
    typeof binding.epoch !== "string" ||
    binding.epoch.trim() !== binding.epoch ||
    binding.epoch.length === 0 ||
    typeof binding.csrfToken !== "function" ||
    typeof binding.onUnauthorized !== "function"
  ) {
    throw new Error("Verified analyst session binding required");
  }

  let retired = false;
  function revoke() {
    if (retired) return;
    retired = true;
    try {
      binding.onUnauthorized();
    } catch {
      // Never expose credentials or host callbacks in browser logs.
    }
  }

  async function request(path: string, body?: unknown): Promise<{ status: number; payload?: unknown }> {
    if (retired) return { status: 401 };
    const write = body !== undefined;
    const headers = new Headers({ Accept: "application/json" });
    if (write) {
      let token: unknown;
      try {
        token = binding.csrfToken();
      } catch {
        return { status: 403 };
      }
      // A trusted host may revoke/logout synchronously while providing the
      // CSRF token. Never dispatch a mutation on the retired session.
      if (retired) return { status: 401 };
      if (typeof token !== "string" || !SAFE_CSRF.test(token)) {
        return { status: 403 };
      }
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRF-Token", token);
    }

    // Paths are constructed and validated by the existing tenant-bound ports.
    // This fetch can only target the current origin, never a caller URL.
    const response = await fetch(path, {
      method: write ? "POST" : "GET",
      headers,
      body: write ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      mode: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 401) revoke();
    // A late mutation reply after revocation/logout is ambiguous even if it
    // was HTTP 200. The write port fences it as outcome_unknown, never ACKs.
    if (retired) return { status: write && response.status !== 401 ? 503 : 401 };
    if (response.status !== 200) return { status: response.status };
    if (response.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
      throw new Error("Protected response unavailable");
    }
    const payload: unknown = await response.json();
    if (retired) return { status: write ? 503 : 401 };
    return { status: 200, payload };
  }

  const reader = createProtectedCaseReadPort(binding.tenantId, (path) => request(path));
  const writer = createProtectedCaseTransitionPort(binding.tenantId, (path, body) => request(path, body));
  return Object.freeze({
    epoch: binding.epoch,
    reader,
    writer,
    close: () => { retired = true; },
  });
}

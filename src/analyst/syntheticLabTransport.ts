import { createProtectedCaseReadPort } from "./protectedCaseReadPort";
import { createProtectedCaseTransitionPort } from "./protectedCaseTransitionPort";

const TENANT = "tenant-a";
const PROXY = "/__gasha_analyst_lab";

export function openSyntheticLabSession(credential: string, onUnauthorized: () => void) {
  let retired = false;

  async function request(path: string, init: RequestInit = {}) {
    if (retired) return { status: 401 };
    const write = init.method === "POST";
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    headers.set("Accept", "application/json");
    let response: Response;
    try {
      response = await fetch(PROXY + path, {
        ...init, headers, credentials: "omit", cache: "no-store", redirect: "error",
      });
    } catch {
      // A dispatched POST may have committed even if its response was lost
      // or the analyst logged out. Never report that ambiguous action as a
      // definitive 401/no-op or silently retry it with a fresh key.
      return { status: write ? 503 : retired ? 401 : 503 };
    }
    // Other requests may revoke/logout during this fetch. For an in-flight
    // POST a late non-401 reply is ambiguous, including an apparent 200 ACK.
    // Reads must never reveal payloads from the retired session.
    if (retired) return { status: write && response.status !== 401 ? 503 : 401 };
    if (response.status === 401) {
      retired = true;
      onUnauthorized();
    }
    if (response.status !== 200) return { status: response.status };
    if (response.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
      throw new Error("Invalid synthetic lab response");
    }
    const payload: unknown = await response.json();
    return retired ? { status: write ? 503 : 401 } : { status: 200, payload };
  }

  return Object.freeze({
    reader: createProtectedCaseReadPort(TENANT, (path) => request(path)),
    writer: createProtectedCaseTransitionPort(TENANT, (path, body) => request(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })),
    close: () => { retired = true; },
  });
}

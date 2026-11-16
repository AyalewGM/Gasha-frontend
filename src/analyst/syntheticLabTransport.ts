import { createProtectedCaseReadPort } from "./protectedCaseReadPort";
import { createProtectedCaseTransitionPort } from "./protectedCaseTransitionPort";

const TENANT = "tenant-a";
const PROXY = "/__gasha_analyst_lab";

export function openSyntheticLabSession(credential: string, onUnauthorized: () => void) {
  let retired = false;

  async function request(path: string, init: RequestInit = {}) {
    if (retired) return { status: 401 };
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    headers.set("Accept", "application/json");
    const response = await fetch(PROXY + path, {
      ...init, headers, credentials: "omit", cache: "no-store", redirect: "error",
    });
    if (retired) return { status: 401 };
    if (response.status === 401) {
      retired = true;
      onUnauthorized();
    }
    if (response.status !== 200) return { status: response.status };
    if (response.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
      throw new Error("Invalid synthetic lab response");
    }
    const payload: unknown = await response.json();
    return retired ? { status: 401 } : { status: 200, payload };
  }

  return Object.freeze({
    reader: createProtectedCaseReadPort(TENANT, (path) => request(path)),
    writer: createProtectedCaseTransitionPort(TENANT, (path, body) => request(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })),
    close: () => { retired = true; },
  });
}

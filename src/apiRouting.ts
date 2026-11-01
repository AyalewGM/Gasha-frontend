/** Public, non-secret, same-origin path. Authentication is enforced by the backend. */
export function apiBasePath(configured?: string): string {
  const path = configured || "/api";
  if (!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path) || path === "/") {
    throw new Error("API base must be a same-origin path (e.g. /api)");
  }
  return path.replace(/\/$/, "");
}

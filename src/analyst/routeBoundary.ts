/**
 * Routing is navigation only, never tenant, identity or authorization authority.
 * Refuse unknown paths instead of silently mounting the synthetic console on
 * a protected-looking URL (for example /analyst/ or /analyst/cases/...).
 */
export type GashaRoute = "analyst" | "synthetic" | "unavailable";

export function classifyGashaRoute(pathname: string): GashaRoute {
  if (pathname === "/analyst" || pathname.startsWith("/analyst/")) return "analyst";
  if (pathname === "/" || pathname === "/index.html") return "synthetic";
  return "unavailable";
}

/**
 * Browser host containment for the anonymous synthetic decision console.
 * This is an additional UI guard, not a substitute for the loopback Vite
 * listener/proxy checks or for server-side authorization.
 */
export function isLoopbackBrowserHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Analyst route remains reserved; only the synthetic route is host-gated. */
export function classifyGashaBrowserRoute(pathname: string, hostname: string): GashaRoute {
  const route = classifyGashaRoute(pathname);
  return route === "synthetic" && !isLoopbackBrowserHost(hostname)
    ? "unavailable" : route;
}

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

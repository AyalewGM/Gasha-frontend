const TENANT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function protectedCasesPath(tenant: string): string | null {
  if (typeof tenant !== "string" || tenant !== tenant.trim() || !TENANT_SEGMENT.test(tenant)) {
    return null;
  }
  return `/v1/tenants/${tenant}/cases`;
}

export function isCaseIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && CASE_ID.test(value);
}

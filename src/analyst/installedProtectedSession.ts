import type { ProtectedCaseReadPort } from "./ReadOnlyAnalystJourney";
import type { ProtectedCaseWritePort } from "./AnalystInvestigation";

/**
 * Trusted composition contract for Issue #9 Phase A. The installed session
 * authority MUST supply a fresh read port (or rotate epoch) when the
 * credential, tenant, or privilege set changes. Every protected read is
 * independently authenticated/authorized by the backend.
 *
 * A bank-specific verifier, credential acquisition, CSRF/ingress installation,
 * and live reader do not exist in this repo. Never derive this contract from
 * browser query strings, storage, editable controls, or synthetic App inputs.
 */
export interface InstalledProtectedAnalystSession {
  readonly epoch: string;
  readonly reader: ProtectedCaseReadPort;
  /** Opt-in only after independently accepted backend authorization/CSRF contract. */
  readonly writer?: ProtectedCaseWritePort;
}

/**
 * Fail-closed default. An independently reviewed deployment composition must
 * replace this adapter with a verified, same-origin protected-API session
 * integration before ANY authenticated data read can occur.
 * No browser-provided token, tenant, rank, role or case capability is accepted.
 */
export function getInstalledProtectedAnalystSession(): InstalledProtectedAnalystSession | null {
  return null;
}

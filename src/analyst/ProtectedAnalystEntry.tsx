import { ReadOnlyAnalystJourney } from "./ReadOnlyAnalystJourney";
import { AnalystInvestigation } from "./AnalystInvestigation";
import {
  getInstalledProtectedAnalystSession,
  type InstalledProtectedAnalystSession,
} from "./installedProtectedSession";

// A verified host must rotate epochs and install new, immutable compositions.
// As defense in depth, also discard stale UI if the host replaces the reader
// or writer *inside the same session object* and re-renders with a reused epoch.
// This cannot detect mutations without a render or changes inside a port.
const verifiedViewIdentityKeys = new WeakMap<object, number>();
let nextVerifiedViewIdentityKey = 0;
function verifiedViewIdentityKey(value: object): number {
  const existing = verifiedViewIdentityKeys.get(value);
  if (existing !== undefined) return existing;
  const fresh = ++nextVerifiedViewIdentityKey;
  verifiedViewIdentityKeys.set(value, fresh);
  return fresh;
}

/**
 * Issue #9 Phase A: default-off protected analyst route shell.
 * Never imports synthetic decisioning, supplies credentials, grants a case
 * mutation, grants authorization or treats a queue's order as approved ranking.
 */
export function ProtectedAnalystEntry({
  session = getInstalledProtectedAnalystSession(),
}: {
  readonly session?: InstalledProtectedAnalystSession | null;
}) {
  if (
    session === null ||
    typeof session.epoch !== "string" ||
    session.epoch.length === 0 ||
    typeof session.reader?.readQueue !== "function" ||
    typeof session.reader?.readHistory !== "function" ||
    (session.writer !== undefined && typeof session.writer?.submit !== "function")
  ) {
    return (
      <main aria-label="Protected analyst workspace">
        <h1>Gasha — Protected analyst workspace</h1>
        <p role="status">
          No trusted analyst session is installed. Protected case data is not available.
        </p>
      </main>
    );
  }

  // Snapshot installed ports at render time. Child callbacks must never
  // follow later in-place changes to a shared host session object.
  const installedSession: InstalledProtectedAnalystSession = {
    epoch: session.epoch,
    reader: session.reader,
    writer: session.writer,
  };
  const viewKey = [
    installedSession.epoch,
    verifiedViewIdentityKey(session),
    verifiedViewIdentityKey(installedSession.reader),
    installedSession.writer ? verifiedViewIdentityKey(installedSession.writer) : "read-only",
  ].join(":");

  return (
    <main aria-label="Protected analyst workspace">
      <h1>Gasha — Protected analyst workspace</h1>
      <p>
        {installedSession.writer
          ? "Server-ordered investigation queue with separately authorized case actions."
          : "Read-only, server-ordered investigation queue."}
        {" "}No Bank ranking approval, payment execution or enforcement is supplied by this page.
      </p>
      {installedSession.writer ? (
        <AnalystInvestigation key={viewKey} session={installedSession} />
      ) : (
        <ReadOnlyAnalystJourney key={viewKey} reader={installedSession.reader} sessionEpoch={installedSession.epoch} />
      )}
    </main>
  );
}

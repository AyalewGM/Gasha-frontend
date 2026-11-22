import { ReadOnlyAnalystJourney } from "./ReadOnlyAnalystJourney";
import { AnalystInvestigation } from "./AnalystInvestigation";
import {
  getInstalledProtectedAnalystSession,
  type InstalledProtectedAnalystSession,
} from "./installedProtectedSession";

// A newly verified host composition must not inherit case/history/action
// state from a previous session even if the host accidentally reuses an epoch.
// Session object identity is a second, independent UI-isolation boundary.
const verifiedSessionViewKeys = new WeakMap<InstalledProtectedAnalystSession, number>();
let nextVerifiedSessionViewKey = 0;
function verifiedSessionViewKey(session: InstalledProtectedAnalystSession): number {
  const existing = verifiedSessionViewKeys.get(session);
  if (existing !== undefined) return existing;
  const fresh = ++nextVerifiedSessionViewKey;
  verifiedSessionViewKeys.set(session, fresh);
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

  const viewKey = `${session.epoch}:${verifiedSessionViewKey(session)}`;

  return (
    <main aria-label="Protected analyst workspace">
      <h1>Gasha — Protected analyst workspace</h1>
      <p>
        {session.writer
          ? "Server-ordered investigation queue with separately authorized case actions."
          : "Read-only, server-ordered investigation queue."}
        {" "}No Bank ranking approval, payment execution or enforcement is supplied by this page.
      </p>
      {session.writer ? (
        <AnalystInvestigation key={viewKey} session={session} />
      ) : (
        <ReadOnlyAnalystJourney key={viewKey} reader={session.reader} sessionEpoch={session.epoch} />
      )}
    </main>
  );
}

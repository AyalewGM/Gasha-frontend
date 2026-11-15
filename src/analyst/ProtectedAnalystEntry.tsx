import { ReadOnlyAnalystJourney } from "./ReadOnlyAnalystJourney";
import {
  getInstalledProtectedAnalystSession,
  type InstalledProtectedAnalystSession,
} from "./installedProtectedSession";

/**
 * Issue #9 Phase A: default-off protected analyst route shell.
 * Never imports synthetic decisioning, supplies credentials, enables a case
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
    typeof session.reader?.readHistory !== "function"
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

  return (
    <main aria-label="Protected analyst workspace">
      <h1>Gasha — Protected analyst workspace</h1>
      <p>
        Read-only, server-ordered investigation queue. No Bank ranking approval,
        disposition, payment execution or enforcement is supplied by this page.
      </p>
      <ReadOnlyAnalystJourney reader={session.reader} sessionEpoch={session.epoch} />
    </main>
  );
}

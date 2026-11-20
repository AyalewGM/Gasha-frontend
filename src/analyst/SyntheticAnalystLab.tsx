import { useState, type FormEvent } from "react";
import { AnalystInvestigation } from "./AnalystInvestigation";
import { openSyntheticLabSession } from "./syntheticLabTransport";
import "./syntheticAnalystLab.css";

type Session = ReturnType<typeof openSyntheticLabSession>;

export function SyntheticAnalystLab() {
  const [session, setSession] = useState<Session | null>(null);
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState("");

  function openSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credential || /\s/.test(credential)) {
      setMessage("Enter a synthetic bearer credential without whitespace.");
      return;
    }
    setSession(openSyntheticLabSession(credential, () => {
      setSession(null);
      setMessage("Synthetic session expired or was rejected.");
    }));
    setCredential("");
    setMessage("");
  }

  function closeSession() {
    session?.close();
    setSession(null);
    setMessage("Synthetic session ended.");
  }

  return (
    <main className="analyst-lab" aria-label="Synthetic analyst lab">
      <header>
        <h1>Gasha analyst lab</h1>
        <p>Synthetic cases for tenant-a. Case actions have no payment execution authority.</p>
      </header>
      {message && <p role="status">{message}</p>}
      {session ? (
        <>
          <button type="button" onClick={closeSession}>End session</button>
          <AnalystInvestigation session={session} />
        </>
      ) : (
        <form onSubmit={openSession} className="analyst-lab-actions">
          <label>Synthetic bearer credential
            <input type="password" autoComplete="off" maxLength={200} required value={credential}
              onChange={(event) => setCredential(event.target.value)} />
          </label>
          <button type="submit">Open synthetic session</button>
        </form>
      )}
    </main>
  );
}

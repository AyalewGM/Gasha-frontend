# Protected analyst workspace

`/analyst` is disabled by default. The optional route shell requires an
installed session adapter and shows an unavailable state if none is present.
Its session epoch resets case state when credentials, tenant, or permissions
change. The protected API authorizes every read and transition.

## Synthetic browser lab

Use a loopback protected backend with an isolated synthetic database and test
identity verifier. The existing synthetic decision API does not serve this
workflow.

```sh
VITE_GASHA_ANALYST_PHASE_A=true VITE_GASHA_ANALYST_SYNTHETIC_LAB=true \
  GASHA_LOCAL_API_TARGET=http://127.0.0.1:8000 npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/analyst` and use the bearer credential supplied
by the test fixture. The lab is scoped to the fixture's `tenant-a`. Use the
fixture's synthetic assignee reference when assigning a case. The generic
decision-console proxy is disabled in lab mode. The lab proxy accepts only
loopback requests on the queue, history, founding-feature evidence GET, and five supported transition paths.
Writes require same-origin JSON with a bearer credential, and the transport
omits cookies, bypasses cache and rejects redirects. Credentials stay in memory.
Ending a session or receiving a 401 clears case data and retires both ports.

The queue and history are decoded before use. Existing-case transitions
derive the source and expected revision from history, use a new event key for
each operator action, and verify the server receipt. The UI refreshes history
after a write. Conflicts require a fresh history. After an uncertain write, case actions
stay paused until authenticated history shows a newer revision. The client does not automatically replay a
POST.

The browser lab runs only on an explicitly enabled Vite development server.
Production builds and Vite Preview cannot install the lab. A Bank installation
requires separate Security/Architecture and QA acceptance of identity,
ingress, CSRF, authorization, audit and the durable readers and writer.

## Protected case actions: opt-in host composition

The protected route can reuse the neutral `AnalystInvestigation` component
when the independently installed `InstalledProtectedAnalystSession` supplies
both reader and writer. It remains read-only with only a reader and
unavailable without a session. The default installed-session getter still
returns `null`; there is no Bank identity provider, browser token,
CSRF/ingress installation, production BFF, or release activation in this PR.

A separately reviewed host must supply a verified server-owned tenant scope,
fresh session epoch, independently authorized case read/write ports, CSRF
protection, redacted durable audit and revocation/expiry/rotation/logout.
The browser must never obtain tenant, role, capability or credentials from
URL/query/editable controls or browser storage. Changing the supplied epoch
remounts the view and discards previous case/action state and late UI responses.
An ambiguous case POST must be reconciled via trusted history before any
new mutation; no automatic retries or payment enforcement are implied.

The page displays only partial, page-local queue counts, not whole-tenant
backlog, fraud accuracy or Bank-approved KPIs. Cross-repository real-HTTP
browser E2E for 401/403/foreign-404/503, CSRF, revocation, stale response,
audit failure, alert generation and full workflow remains mandatory before
protected Bank installation. Depend on backend #45, #148 and #142.

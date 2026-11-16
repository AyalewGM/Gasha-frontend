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
loopback requests on the queue, history, and five supported transition paths.
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

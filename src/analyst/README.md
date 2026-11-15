# Issue #45 — inert read-only analyst case-history projection

This directory provides a strict TypeScript decoder and an **unmounted,
display-only** React case-history panel based on the backend document
docs/protected-case-history-issue45.md at main
dd99db55cedaaf7de3f8ba83847e0cd2434c894f.

The display components and the read adapter remain unmounted. The package
contains no browser fetch calls, credentials, proxy routes, browser storage,
mutation controls or imports from the synthetic-only src/App.tsx.

`createProtectedCaseReadPort` adapts a supplied session-bound GET function to
the journey's queue and history operations. It fixes the relative paths to
one tenant, validates route selectors, redacts denied responses, and retires
the port on HTTP 401. Only a separately reviewed composition may supply the
verified tenant and transport. That composition must manage credentials,
redirects, caching and session invalidation, and replace the port when the
session or tenant changes. The supplied transport must return HTTP responses
as status results so a 401 can invalidate pending reads.

The decoder rejects cross-case response substitution, unrecognized fields
(including PII), non-opaque actor/context references, noncontiguous revision,
invalid lifecycle, impossible/naive/out-of-order clocks, non-unknown Bank
execution, and any purported enforcement activation. These checks protect
rendering only: the server must independently authorize case.read, tenant,
credential expiry/revocation, audit and trusted durable reader on each read.

**Next gated dependency:** Security/Architecture must accept a Bank-approved
session/ingress/CSRF model and the backend's installed tenant-scoped reader
before a separately reviewed, authenticated client fetches or mounts this
panel. Independent QA must then exercise 401/403/cross-tenant 404, expired
and revoked credentials, audit/storage outages and denial without mutation.
Do not wire this into the loopback gasha.api.synthetic:app console.

All example identifiers in tests are fictitious. No Bank data/PII,
deployment, case mutation, stage authority or payment enforcement is used.

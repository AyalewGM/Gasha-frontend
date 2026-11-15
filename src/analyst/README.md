# Issue #45 — inert read-only analyst case-history projection

This directory provides a strict TypeScript decoder and an **unmounted,
display-only** React case-history panel based on the backend document
docs/protected-case-history-issue45.md at main
dd99db55cedaaf7de3f8ba83847e0cd2434c894f.

It is **not** an authenticated analyst application, protected API client,
case editor, bank-ready frontend, tenant authority, IdP integration, or
evidence of executed payment intervention. There are no fetch calls,
credentials, added proxy routes, browser storage, mutation controls or
imports from the existing synthetic-only src/App.tsx.

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


## Issue #9 — Phase A route shell (candidate, not accepted)

The build now recognizes the separate `/analyst` path without importing the
synthetic decision console. It remains **off by default**. Only builds with
`VITE_GASHA_ANALYST_PHASE_A=true` load `ProtectedAnalystEntry`, and even
then the `installedProtectedSession.ts` adapter returns `null` until a
separately accepted deployment supplies a verified same-origin session/read
port. Without that installation the page displays a fail-closed unavailable
message and issues no protected API request.

An installed adapter must re-authenticate and authorize **every** queue/history
read through the protected backend; use its own verified tenant selector,
credential lifecycle, capability and least-privilege audit. It must rotate
`epoch` whenever the credential, tenant or permissions change, even if the
read-port instance is reused. The journey key then discards previous results
and rejects in-flight stale responses. The epoch is only a local invalidation
key, **never** authorization evidence. No credentials, tenant authority,
session identifiers or case payloads may come from the URL, query, browser
storage, synthetic console, or caller-edited objects.

This is a bounded development candidate, **not the completed Phase A milestone**:
the installed identity/session/CSRF/ingress adapter, protected live API/browser
E2E, permitted synthetic case fixture, accessibility evidence and independent
Security/Architecture and QA review are still missing. Case mutations,
Bank-facing usage and payment enforcement remain disabled. Issue #49 remains
open.

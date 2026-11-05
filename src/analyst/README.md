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

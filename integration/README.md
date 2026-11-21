# Gasha #9 — disposable synthetic UC-02 cross-repository MVE

This is an opt-in engineering test, never an installed Bank analyst session or production gateway. An invented rapid-funds-flow/fan-in signal is a review hypothesis, not proof of fraud, remote coaching, customer deception or prevented loss. Only UC-02 is currently recognized.

## Run

With disposable local PostgreSQL 16, Python 3.12+, Node 22 and both repositories:

1. Check out backend SHA 7e3e4370ca168c935da5ecb6cb7d9dc96ad377a6 to the frontend root's backend/ directory.
2. Install `python -m pip install -e "./backend[dev,postgres]"` and `npm ci`.
3. Set GASHA_CROSS_REPO_MVE=true, GASHA_MVE_BACKEND=backend, GASHA_MVE_BACKEND_SHA=7e3e4370ca168c935da5ecb6cb7d9dc96ad377a6 and GASHA_TEST_POSTGRES_DSN to the disposable DB, then run `npm run test:mve` (one test command).

GitHub Actions runs the same command against a disposable PostgreSQL service with backend pinned to this exact SHA. NEVER use a Bank/shared database. The runner creates and drops one fresh gasha_browser_<random> schema, and creates a mode-0600 temporary manifest for fictional credentials and selectors. A killed process may leave a disposable schema; clean that separately only after inspection.

The existing synthetic worker experiences a post-ACK evaluation failure and then recovers two distinct events through the PostgreSQL pending ledger. Expected: two immutable shadow evaluations/alerts, one deduplicated case, zero pending. Explicit test-only FastAPI verifier, real PostgreSQL case readers/writer and separate committing audit sink run on loopback. Real Vite development HTTP proxy serves the React analyst lab: queue → history → audited founding-event evidence → triage → assign → dispose → reconcile. No HTTP response stubs or preseeded final history.

The test checks five append-only case revisions, idempotent duplicate POST, redacted audit, unchanged evaluation/alert counts, real 401/403/foreign-404/503, and method/foreign Origin/cookie denial. Browser controls never provide tenant, role, ranking or capability authority.

## Limitations

- React is tested through jsdom and actual Vite/FastAPI/PG HTTP, not Chromium or Playwright.
- The verifier and privileges are synthetic fixture values, not an installed Bank IdP, JWKS, BFF, CSRF, TLS or credential-lifecycle system.
- All connections are loopback. No production Bank session is installed; the existing synthetic console is separate.
- No payment hold/block/settlement is requested or executed. All case events carry bank_execution=unknown and enforcement_activated=false.
- Inputs are invented and credentials are never printed. The page counts are not Bank KPIs, precision/recall, incumbent comparison or acceptance.
- Independent exact-head PO, Security/Architecture and QA review is required before Unified Engineering Lead integration. npm advisories are a separate gate.

## Genuine Chromium browser proof (opt-in, synthetic only)

CI additionally runs Node 22 command: node integration/synthetic_chromium_e2e.mjs
after the React/jsdom MVE with the same disposable PostgreSQL service and pinned backend.
For local execution, reuse the environment and installation steps above, with
a local Chrome/Chromium binary (CHROME_BIN may select it). The script fails
rather than skipping when Chromium is unavailable.

The runner seeds a separate invented UC-02 schema, launches actual headless
Chromium against loopback Vite/FastAPI, and drives the React /analyst page
through queue -> founding evidence/history -> triage -> assignment -> explicit
unresolved disposition -> feedback reconciliation. It verifies PostgreSQL
revisions and redacted audit, real HTTP 401/403/foreign-tenant 404, proxy
method/origin/cookie denial, revoked-token UX, local logout/data clearing,
and audit-outage 503. The browser uses native CDP pointer/keyboard commands;
the test does not mock network responses or instantiate React through jsdom.
It does not print tokens, payloads, DSNs, backend logs or Chromium console.

This is NOT installed-session/Bank identity, BFF, bank-approved CSRF,
revocation service, operational KPI or payment/Bank activation evidence.
Uncertain write/stale request and rotation protections remain separately
tested in frontend unit/jsdom suites; the genuine-browser proof does not
yet exercise a real installed IdP session rotation. It does not close backend
#148/#142 or release security review. Chromium availability and exact-head
CI plus independent PO, Security and QA review remain mandatory.

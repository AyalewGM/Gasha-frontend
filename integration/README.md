# Gasha #9 — disposable synthetic UC-02 cross-repository MVE

This is an opt-in engineering test, never an installed Bank analyst session or production gateway. An invented rapid-funds-flow/fan-in signal is a review hypothesis, not proof of fraud, remote coaching, customer deception or prevented loss. Only UC-02 is currently recognized.

## Run

With disposable local PostgreSQL 16, Redis 7.2, Python 3.12+, Node 22 and both repositories:

1. Check out backend SHA 8e053ec0e973a4baf27400abad94bb1ac68676e3 to the frontend root's backend/ directory.
2. Install `python -m pip install -e "./backend[dev,postgres,redis]"` and `npm ci`.
3. Set GASHA_CROSS_REPO_MVE=true, GASHA_MVE_BACKEND=backend, GASHA_MVE_BACKEND_SHA=8e053ec0e973a4baf27400abad94bb1ac68676e3, GASHA_TEST_REDIS_URL=redis://127.0.0.1:6379/15 and GASHA_TEST_POSTGRES_DSN to the disposable DB, then run `npm run test:mve` (one test command).

GitHub Actions runs the same command against disposable PostgreSQL and Redis services with backend pinned to this exact SHA. NEVER use a Bank/shared database. The runner creates and drops one fresh gasha_browser_<random> schema, and creates a mode-0600 temporary manifest for fictional credentials and selectors. A killed process may leave a disposable schema; clean that separately only after inspection.

The worker experiences a post-ACK failure and stores two distinct normalized pending events. A process-owned RedisFeatureHistory opens a fresh tenant/epoch with five prior-only fictional observations, deliberately unsealed for the first recovery attempt: pending=2 and shadow evaluations/alerts/cases/audit writes=0. Once sealed through the receipt cutoff, the existing RedisSyntheticHistorySource and worker recover the pending records: two immutable evaluations/alerts, one deduplicated case, zero pending, five eligible observations and `sender_beneficiary_history_coverage` unavailable. No precomputed fixture supplies the target: it comes only from the durable normalized envelope. Explicit test-only FastAPI verifier, real PostgreSQL case readers/writer and separate committing audit sink run on loopback. Real Vite development HTTP proxy serves the React analyst lab: queue → history → audited founding-event evidence → triage → assign → dispose → reconcile. No HTTP response stubs or preseeded final history.

The test checks five append-only case revisions, idempotent duplicate POST, redacted audit, unchanged evaluation/alert counts, real 401/403/foreign-404/503, and method/foreign Origin/cookie denial. Browser controls never provide tenant, role, ranking or capability authority.

## Limitations

- React is tested via real jsdom HTTP and native Chromium/CDP through loopback Vite/FastAPI/PG; neither installs a Bank session.
- The verifier and privileges are synthetic fixture values, not an installed Bank IdP, JWKS, BFF, CSRF, TLS or credential-lifecycle system.
- All connections are loopback. No production Bank session is installed; the existing synthetic console is separate.
- No payment hold/block/settlement is requested or executed. All case events carry bank_execution=unknown and enforcement_activated=false.
- Inputs are invented and credentials are never printed. The page counts are not Bank KPIs, precision/recall, incumbent comparison or acceptance.
- Independent exact-head PO, Security/Architecture and QA review is required before Unified Engineering Lead integration. npm advisories are a separate gate.

## Genuine Chromium browser proof (opt-in, synthetic only)

CI additionally runs Node 22 command: node integration/synthetic_chromium_e2e.mjs
after the React/jsdom MVE with the same disposable PostgreSQL and Redis services and pinned backend.
For local execution, reuse the environment and installation steps above, with
a local Chrome/Chromium binary (CHROME_BIN may select it). The script fails
rather than skipping when Chromium is unavailable.

The runner seeds a separate invented UC-02 schema, launches actual headless
Chromium against loopback Vite/FastAPI, and drives the React /analyst page
through queue -> founding evidence/history -> triage -> assignment -> explicit
unresolved disposition -> feedback reconciliation. It verifies Redis-derived five eligible observations and unavailable lifetime relationship history, PostgreSQL
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

## Redis-bound proof constraints

The runner refuses Redis targets except local port 6379 database 15 without credentials, never flushes any DB, and allocates a fresh opaque epoch with a short TTL. The pinned backend's real Redis/worker/PostgreSQL tests rerun in CI for missing, unsealed, expired, poisoned, corrupt, cross-tenant and invalid-envelope negative contracts. Redis sealing is a local **synthetic assertion, not Bank producer attestation**. No browser input controls tenant, epoch, source policy or seal completeness. CI emits only the constant `SYNTHETIC_REDIS_CHROMIUM_PASS` after genuine browser success, without tokens, DSNs or raw pseudonyms.

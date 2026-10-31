# Gasha Frontend — synthetic decision console

This is an **internal, non-authoritative synthetic UI scaffold** for Gasha UC-01/02/03 experimentation. It presents risk *recommendations*, not executed banking interventions. It must not be deployed to a bank, exposed to a bank network, or supplied with real customer data or credentials.

## Run a local synthetic demonstration

The current form deliberately permits caller-selected risk signals and policy values. Those are accepted **only** by the separate synthetic backend application; the protected `gasha.api.main:app` correctly rejects them and requires a trusted identity, security audit and server-selected context.

In a terminal in `Gasha-backend`:

```bash
pip install -e ".[dev]"
uvicorn gasha.api.synthetic:app --host 127.0.0.1 --port 8000
```

In another terminal in this repository:

```bash
npm ci
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173`. The local Vite proxy forwards `/api/v1/decisions` to `http://127.0.0.1:8000/v1/decisions`. Use synthetic transaction identifiers only. The frontend displays the proposed action, risk score, reason codes and policy-version labels. No payment, bank action or authoritative evidence is created.

## Development checks

- `npm run lint` — ESLint
- `npm test` — Vitest (routing and UI state)
- `npm run build` — TypeScript and production-bundle compile, **not approval to deploy**

The local `npm run preview` server uses the same proxy rules as development. Set `VITE_API_BASE_PATH` at build time only if you change the **same-origin** local proxy prefix; the default is `/api`. `GASHA_LOCAL_API_TARGET` defaults to `http://127.0.0.1:8000`; keep it on a loopback synthetic server. Never provide browser-side bank tokens, bank endpoints, real PII or cross-origin service credentials.

## Protected API and bank-facing work — not implemented here

The protected backend `gasha.api.main:app` requires a trusted authenticated principal and accepts only `{"transaction": ...}` for `POST /v1/decisions`. It does **not** accept this UI's client-selected `policy`, risk scores, role, tenant authority or enforcement mode. Therefore this scaffold must **not** be advertised as compatible with the protected bank API.

The future authenticated analyst workflow must use a bank-approved identity/session design; server-authorized tenant and capability scope; trusted policy/signal lineage; denied/expired/revoked-session handling; case history and evidence provenance; appropriate CSRF/TLS/ingress defenses; and independent Security and QA acceptance. Never reuse the synthetic trust model for a bank-facing service.

This PR provides only a safe local starting point, not CBE acceptance, bank deployment or permission to activate intervention.

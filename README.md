# Gasha Frontend

Decision console for the [Gasha backend](https://github.com/AyalewGM/Gasha-backend) real-time fraud decision API.

## Local development

```bash
npm install
npm run dev
```

The dev server proxies `/api/*` to `http://localhost:8000`, so run the backend first:

```bash
# in Gasha-backend
uvicorn gasha.api.main:app --reload
```

Then open http://localhost:5173 — submit a canonical transaction with intelligence inputs and see the `FraudDecision` (action, risk score, reason codes, version provenance).

## Scripts

- `npm run dev` — dev server
- `npm run build` — type-check + production build
- `npm run lint` — ESLint
- `npm test` — Vitest

## Routing and security

Production serves the built static frontend behind an authenticated, TLS-terminated reverse proxy. Route the configured same-origin prefix (default `/api`) to the approved Gasha backend; strip that prefix to match backend routes (`/api/v1/decisions` → `/v1/decisions`; `/api/health/live` → `/health/live`). Set `VITE_API_BASE_PATH` **at build time** only when the reverse proxy uses a different same-origin prefix. Never configure browser-side backend credentials or a cross-origin bank API endpoint. Vite's development and `npm run preview` servers both proxy to `GASHA_LOCAL_API_TARGET` (default `http://127.0.0.1:8000`), which is for local use only, not deployment.

Backend-side authentication, tenant authorization, CSRF protection where cookie sessions are used, and production ingress hardening require independent security acceptance. The console's tenant field is not a security boundary. Outputs represent risk recommendations, not proof that a bank action has been executed.

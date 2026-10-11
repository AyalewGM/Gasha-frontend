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

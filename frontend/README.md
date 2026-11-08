# Payment Reliability Playground

Developer-facing React/Vite demonstration UI for the existing Payment Idempotency Gateway.

## Run locally

From the repository root:

```bash
# terminal 1 — existing gateway
npm run dev

# terminal 2 — optional provider simulator
npm run dev:provider

# terminal 3 — recovery workers as needed
npm run worker:reconciliation
npm run worker:provider-conflicts
npm run worker:orphan-recovery

# terminal 4 — frontend
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to the Fastify gateway at `http://localhost:3000` and removes the `/api` prefix.

To use another gateway origin, create `frontend/.env.local`:

```env
VITE_API_BASE_URL=http://localhost:3000
```

The frontend never receives or exposes the webhook secret and does not collect card details.

## Demonstration flow

1. Create a payment in Payment Playground. The UI sends the actual `POST /payments` request and displays the generated `Idempotency-Key`, status code and response body.
2. Open Idempotency Lab and retry with the same key and payload. Then reuse the key with a changed amount to observe the API's payload-conflict response.
3. Use Recovery Monitoring to refresh the returned payment through `GET /payments/:id` and view available process-local metrics.
4. Use Observability to inspect the existing `/health` and `/metrics` endpoints and the browser-session request timeline.

The backend does not currently expose idempotency-key lookup, payment-event history or a worker-health endpoint. The UI labels those limitations and does not fabricate them.

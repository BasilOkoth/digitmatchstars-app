# Accumulator dashboard integration

The Next.js `/accumulator` page now controls the Python execution engine using a local HTTP control server, via `/api/accumulator`. It is **not** a browser-only Deriv integration. Existing Digit Match functionality is unchanged.

## Local setup (two terminals)

1. `cd tools/accumulator && pip install -r requirements.txt`
2. Set `DERIV_TOKEN` and `DERIV_APP_ID` in the **Python server environment** (never commit them or prefix them with `NEXT_PUBLIC_`). Use an account-authorized token.
3. `python control_server.py` (binds to 127.0.0.1:8765).
4. From the project root, set `ACCUMULATOR_DASHBOARD_ENABLED=true` and run `npm install && npm run dev`.
5. Open `http://localhost:3000/accumulator`, enter your demo account ID, and start. Live mode requires a separate explicit checkbox.

**Deployment warning:** The Next.js proxy route is intentionally disabled unless `ACCUMULATOR_DASHBOARD_ENABLED=true`. It has no user authentication and must only be enabled on a trusted, locally accessed deployment. Never enable it on a public Render/Vercel instance. A remote multi-user deployment requires authenticated per-user sessions, account ownership validation, CSRF protection, encrypted secret storage, and a durable execution worker. The localhost Python service cannot be reached from a separate cloud-hosted Next.js process.

The dashboard does not share browser OAuth or account state. `Stop` terminates the bot process, **not** the Deriv contract; always check for open positions before restarting. A broker order may have succeeded even if its acknowledgement was lost. The bot is not proven profitable and has not been verified with actual Deriv orders.

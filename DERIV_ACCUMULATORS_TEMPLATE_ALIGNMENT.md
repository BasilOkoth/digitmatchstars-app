# Deriv Accumulators template alignment (8 November 2026)

Official template: https://developers.deriv.com/app-builder/accumulators/
Original user-provided dashboard URL: https://developers.deriv.com/dashboard/builder/accumulators/

The public Deriv page describes an app-building wizard, **not** a downloadable trading-strategy source template. This project therefore retains its existing DigitMatchStars UI and Python execution engine; it does **not** claim to embed or reproduce Deriv's proprietary generated template.

## Officially documented capabilities
- WebSocket-based real-time prices and trades.
- OAuth 2.0 + PKCE for browser applications; PAT authentication may be used in native/CLI tools.
- Accumulator contracts grow by a selected growth rate while ticks remain inside broker-defined barriers.
- `proposal`, `buy`, and `proposal_open_contract` are the documented contract workflow. Never use locally simulated barriers as actual execution prices or knockout conditions.

## Current integration
- Existing local Python bot connects using a Deriv account-scoped OTP WebSocket and uses `proposal` (`contract_type=ACCU`), `buy`, and `proposal_open_contract`.
- Local Next.js dashboard controls a separate Python process; this is **not** Deriv's hosted App Builder template.
- No authenticated end-to-end Deriv execution test has been completed; live orders should not be enabled on public deployments.
- Entry signals use price-return volatility and absolute drift. The engine does **not** yet calculate statistically calibrated barrier-survival probabilities, and no profitability edge has been established.

## Safety corrections in this package
- Ignore unsolicited contract updates when no tracked position is open.
- If an open-contract subscription fails after a successful purchase, halt new orders and log the contract ID for manual reconciliation. Do not assume the position closed.

## Required production work
1. Authenticate dashboard controls and enforce authorization per account; do not expose the local control server to the public Internet.
2. Implement secure OAuth 2.0 + PKCE and token refresh for browser-hosted accounts; keep access tokens off the client where possible.
3. Confirm current Deriv account type, symbol support, growth rate and broker-supported take-profit with live proposals.
4. Reconcile open contracts and transactions after disconnects/restarts; persist buy IDs and use idempotent order state.
5. Test demo purchase, knockout, take-profit, disconnect, restart, and sell lifecycle before live trading.

Sources: https://developers.deriv.com/app-builder/accumulators/ ; https://developers.deriv.com/docs/trading/ ; https://developers.deriv.com/docs/workflows/

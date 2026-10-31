# DigitMatchStars Intelligence

This update adds a **research-only intelligence panel** below the existing trading interface. It does not modify Deriv login, buy, or sell code.

- Next-tick accuracy for the digit selected in the existing interface, evaluated prospectively once per incoming tick.
- Rotating-digit baseline for comparison; no AI advantage is asserted.
- Entropy and digit frequencies from the existing market data hook.
- Break-even ratio using current proposal ask price / payout.
- Recent closed-contract P/L from the existing `profit_table` feed (the source caps this at 50 records across all symbols).
- Reset sample button, and automatic reset when account or symbol changes.

**Limitations:** Does not import the proprietary scoring model from the separate Python Render bot; no auto-buys or Martingale. Observations disappear on refresh. The P/L shown is NOT a whole-cycle or full-statement reconciliation. This code makes no profitability promises.

Run `npm install` then `npm run build`. Merge into the separate `digitmatchstars-app` repository; do not replace the Render `tradein` backend.


## Trade Center (Demo-only)

- `components/demo-trade-assistant.tsx` calls the app's existing `useDigitsTrading().buyContract()` only after the customer explicitly clicks and confirms a single purchase.
- The button is disabled for Real accounts, unauthenticated sessions, missing proposal and uncertain/pending purchases.
- The WIN/LOSS cards are driven by verified recent closed contracts and use green/red color.
- Research samples are saved in localStorage per account and symbol; this is browser-local, not server-side historical persistence.
- Closed contract feed currently loads on account initialization, not continuously. Refreshing the page may be necessary to view recent results. Do not retry uncertain purchases.
- Actual Python V1 scoring algorithm is NOT included in this repository. No approximation is represented as that scoring model.
- This project does not add automatic, unattended purchasing or live-account execution. The existing manual Buy form provided by Deriv remains unchanged.

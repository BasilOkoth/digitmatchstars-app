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

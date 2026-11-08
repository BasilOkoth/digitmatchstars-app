# DigitMatchStars Accumulator — DEMO and LIVE execution

This version submits **actual Deriv ACCU buy orders** (not simulated orders). Choose the demo or real account explicitly. It uses Deriv's current OTP-authenticated WebSocket workflow. No keys are bundled.

## Install

Python 3.10+:

```
pip install -r requirements.txt
```

On Windows CMD:

```
set DERIV_TOKEN=YOUR_NEW_DERIV_PERSONAL_ACCESS_TOKEN
set DERIV_APP_ID=YOUR_DERIV_APP_ID
```

Create a Deriv API token with the appropriate trading scope, and find the exact demo and real **options trading account IDs** in your Deriv account. Never share the token in chat or commit it to GitHub.

## Demo — executes actual demo contracts

```
python bot.py --mode demo --account-id YOUR_DEMO_ACCOUNT_ID --symbol 1HZ100V --stake 1 --growth 0.02 --take-profit 0.20 --max-trades 3 --max-loss 3
```

## Live — executes actual REAL-money contracts

```
python bot.py --mode live --account-id YOUR_REAL_ACCOUNT_ID --symbol 1HZ100V --stake 1 --growth 0.02 --take-profit 0.20 --max-trades 3 --max-loss 3 --confirm-live
```

`--confirm-live` is mandatory to prevent accidental live orders. Do not start live trading before verifying the contract settings and results with your account.

## Strategy

- Receives live market ticks from Deriv, calculates the mean price return and rolling tick volatility, and waits for both to fall below configurable thresholds.
- Requests an actual `ACCU` contract proposal with the chosen growth rate and a broker-side take-profit order; then buys using the returned proposal ID.
- Subscribes to `proposal_open_contract` for settlement and P/L; limits to one open contract at a time.
- Stops new entries after maximum trade count or recorded loss cap. Loss cap is a *soft stop*, not a guarantee; one contract can lose its entire stake.
- Logs all actions to `accumulator_trades.jsonl`.
- On unexpected purchase errors or disconnects, **do not assume a contract was not purchased**. Check Deriv's open contracts manually before restarting.

## Caveats

This is a first execution-capable version. It has **not been tested against a live Deriv account here**, so API or contract eligibility errors may need adjustments. The momentum and volatility thresholds are research heuristics, not a proven predictive edge or a barrier survival probability. Deriv defines the actual accumulator barriers. No synthetic barrier is used for execution. The server-side take-profit is requested as part of the proposal; verify it is present on the purchased contract. Not all symbols or account jurisdictions support ACCU. Market orders are not guaranteed to execute on the exact tick that triggered the signal.

## Documentation

https://developers.deriv.com/docs/workflows/
https://developers.deriv.com/docs/trading/proposal/
https://developers.deriv.com/docs/trading/proposal-open-contract/

## Verification and safety updates (8 November 2026)

- Run offline checks with `python -m unittest -v test_bot.py` (no orders are sent).
- Entry is blocked when a full stake exceeds the remaining configured loss budget.
- Entries are prevented while a proposal/buy request is in flight.
- A delayed proposal is skipped after `--max-signal-age` ticks (default: 2). **This does not guarantee exact-tick execution.**
- Invalid numeric and negative risk parameters are rejected.
- The existing `/accumulator` web page is **instructions only**, not an interactive trading control panel.
- **Not end-to-end verified**: authenticated OTP, account permissions, actual ACCU proposal/purchase, barrier handling, settlement, reconnects, or Next.js production build. Do not treat offline tests as broker integration tests. Start on demo and reconcile broker-side positions before any live use.

# Accumulator PRO interface

The `/accumulator` page has been redesigned to match DigitMatchStars' premium dark trading aesthetic: account mode tabs, high-contrast metric cards, execution controls, status monitor, responsive layout and live activity stream. It preserves the existing `/api/accumulator` control API and separate Python engine.

## Verification
- Five Python accumulator unit tests passed offline.
- TypeScript/Next.js build not verified: node_modules are not installed in this environment.
- No real Deriv purchase or settlement was performed.

## Operational warnings
- Demo and live order execution require a local Python service and valid Deriv credentials.
- Stop does not automatically close an existing accumulator contract.
- Never expose the local control endpoint on a public deployment without authentication and authorization.
- The strategy has no established positive expected return.

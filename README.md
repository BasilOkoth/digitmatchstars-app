# Digits Trading App

A self-hosted digit trading app built on the Deriv WebSocket API. Supports Matches/Differs, Over/Under, and Even/Odd contract types with real-time tick streaming and digit frequency statistics.

## Prerequisites

- Node.js 18.18 or later

## Step 1: Register Your App ID

1. Log in to your Deriv account and go to the [API Token page](https://app.deriv.com/account/api-token) to create a token with the required scopes.
2. Navigate to [App Registration](https://developers.deriv.com/dashboard/) and register a new application.
3. Set the **Redirect URI** to the URL where you will host this app (e.g. `http://localhost:3000` for local development).
4. Copy the **App ID** shown after registration — you will need it in the next step.

## Step 2: Configure `.env.production`

Copy `.env.example` to `.env.production` and fill in your values:

```bash
cp .env.example .env.production
```

Edit `.env.production`:

```env
NEXT_PUBLIC_DERIV_APP_ID=your_app_id_here
# NEXT_PUBLIC_DERIV_REDIRECT_URI=https://your-app.example.com/path/  # optional
NEXT_PUBLIC_DERIV_APP_NAME=your_app_name_here
NEXT_PUBLIC_DERIV_SHOW_APP_NAME=true
NEXT_PUBLIC_DERIV_REFERRAL_LINK=your_referral_link_here
NEXT_PUBLIC_DERIV_OAUTH_SCOPES=trade,account_manage
NEXT_PUBLIC_DERIV_ENV=production
```

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_DERIV_APP_ID` | Your Deriv app ID from the App Registration dashboard |
| `NEXT_PUBLIC_DERIV_REDIRECT_URI` | **Optional.** OAuth redirect URI. When unset, login returns to the URL the app is opened on, so that URL must be registered as a redirect URI in your Deriv app. Set it only to pin a fixed redirect (for example, a URL with a path); it must then exactly match a registered URI. |
| `NEXT_PUBLIC_DERIV_APP_NAME` | In-app display name (header, tab title, favicon). Set in App Builder Customise. OAuth/consent registration name is configured separately and is not this env var. |
| `NEXT_PUBLIC_DERIV_SHOW_APP_NAME` | `true` (default) shows the name next to the logo on desktop; `false` hides it (logo only). Tab title / favicon still use `NEXT_PUBLIC_DERIV_APP_NAME`. |
| `NEXT_PUBLIC_DERIV_REFERRAL_LINK` | Affiliate referral link shown to unauthenticated users (optional) |
| `NEXT_PUBLIC_DERIV_OAUTH_SCOPES` | Comma-separated OAuth scopes (e.g. `trade,account_manage`) |
| `NEXT_PUBLIC_DERIV_ENV` | `production` to connect to the live Deriv endpoint; `preview` for staging |

For local development, copy `.env.production` to `.env.local` — Next.js will load `.env.local` automatically and it takes precedence over `.env.production`.

## Step 3: Local Development

```bash
npm install
npm run dev
```

The app is available at `http://localhost:3000`.

## Step 4: Build for Production

```bash
npm run build
```

This produces a fully static export in the `/out` directory. Serve the contents of `/out` from any web server or static file host.

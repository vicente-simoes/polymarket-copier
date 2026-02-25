# GitHub Authentication Guide (Web Dashboard)

This project protects the web dashboard with GitHub OAuth using Auth.js (NextAuth) and a server-side GitHub username allowlist.

What this means:
- Users must sign in with GitHub to access dashboard pages.
- Only GitHub usernames listed in `AUTH_GITHUB_ALLOWED_USERS` can enter.
- Dashboard APIs under `/api/v1/*` are also protected.
- `/api/health` remains public for health checks.

## Required Environment Variables

Add these to `.env` (see `.env.example`):

- `AUTH_SECRET`
  - A long random secret used to sign/encrypt auth cookies/JWTs.
- `AUTH_GITHUB_ID`
  - GitHub OAuth App Client ID.
- `AUTH_GITHUB_SECRET`
  - GitHub OAuth App Client Secret.
- `AUTH_GITHUB_ALLOWED_USERS`
  - Comma-separated GitHub usernames (handles), case-insensitive.
  - Example: `AUTH_GITHUB_ALLOWED_USERS=alice,bob,carol`

Optional (deployment-specific):
- `AUTH_URL`
  - Explicit public base URL for the web app (for some proxy/deployment setups).
  - Example: `https://copybot.example.com`
- `AUTH_TRUST_HOST`
  - Usually `true` behind a reverse proxy that forwards host/proto headers.

## Create a GitHub OAuth App

In GitHub:
1. Go to `Settings` -> `Developer settings` -> `OAuth Apps` -> `New OAuth App`.
2. Fill in the app details:
   - **Application name**: e.g. `Polymarket Copier Dashboard`
   - **Homepage URL**:
     - Local host-run web: `http://localhost:3000`
     - Full Docker stack via nginx: `http://localhost:8080`
     - Production: `https://<your-domain>`
   - **Authorization callback URL**:
     - Local host-run web: `http://localhost:3000/api/auth/callback/github`
     - Full Docker stack via nginx: `http://localhost:8080/api/auth/callback/github`
     - Production: `https://<your-domain>/api/auth/callback/github`
3. Create the app.
4. Copy the generated Client ID and Client Secret into `.env`:
   - `AUTH_GITHUB_ID=...`
   - `AUTH_GITHUB_SECRET=...`

Important:
- The callback URL must exactly match the URL your browser uses to access the dashboard.
- If you switch between `:3000` and `:8080`, update the GitHub OAuth app callback URL accordingly (or use a separate OAuth app for each environment).

## Local Development Setup (Host-Run Web)

Typical local setup (web on host, only DB/Redis in Docker):
1. `cp .env.example .env`
2. Set auth variables in `.env`:
   - `AUTH_SECRET`
   - `AUTH_GITHUB_ID`
   - `AUTH_GITHUB_SECRET`
   - `AUTH_GITHUB_ALLOWED_USERS`
3. Start dev infra:
   - `pnpm dev:infra:up`
4. Run the web app:
   - `pnpm dev:web`
5. Open:
   - `http://localhost:3000`
6. Sign in with an allowlisted GitHub account.

## Full Docker Stack / Nginx Setup Notes

When running `pnpm compose:up`, the public entrypoint is usually nginx on:
- `http://localhost:8080` (unless `NGINX_PORT` is changed)

Make sure the GitHub OAuth App callback URL matches the nginx URL:
- `http://localhost:8080/api/auth/callback/github`

Compose passes auth env vars to the `web` service. Update `.env` before starting or restarting the stack.

## Production Setup Notes

Recommended:
- Use a real domain with HTTPS.
- Set the GitHub OAuth App callback URL to your production origin:
  - `https://<your-domain>/api/auth/callback/github`
- Ensure nginx (or your reverse proxy) forwards:
  - `Host`
  - `X-Forwarded-For`
  - `X-Forwarded-Proto`

This repo’s nginx config already forwards those headers, which Auth.js relies on when `trustHost` is enabled.

## How Username Allowlisting Works

- The allowlist checks the GitHub **username/handle** (`login`), not the display name.
- Matching is case-insensitive.
- Whitespace around commas is ignored.

Examples:
- `AUTH_GITHUB_ALLOWED_USERS=alice,bob`
- `AUTH_GITHUB_ALLOWED_USERS=alice, bob, Carol`

All of the above match GitHub usernames `alice`, `bob`, and `carol`.

## Common Failure Modes and Fixes

## 1) Callback URL mismatch

Symptoms:
- GitHub shows redirect/callback errors.
- Sign-in fails before returning to the app.

Fix:
- Verify the GitHub OAuth App callback URL exactly matches the URL you are using in the browser, including:
  - scheme (`http` vs `https`)
  - host
  - port
  - path `/api/auth/callback/github`

## 2) Missing `AUTH_SECRET`

Symptoms:
- Auth route errors on startup or sign-in.
- Session cookie/JWT errors.

Fix:
- Set `AUTH_SECRET` in `.env` to a long random value.
- Restart the web app/container.

## 3) Not allowlisted

Symptoms:
- GitHub sign-in succeeds, but the app returns to the login page with an access denied message.

Fix:
- Add your GitHub username to `AUTH_GITHUB_ALLOWED_USERS`.
- Restart the web app/container so the updated env value is loaded.

## 4) Cookie/session issues behind a proxy

Symptoms:
- Login appears successful but subsequent requests are treated as unauthenticated.

Fix:
- Ensure proxy headers are forwarded (`Host`, `X-Forwarded-Proto`).
- Confirm you are using the same public origin as configured in GitHub.
- Set `AUTH_URL` explicitly if your deployment has unusual proxy behavior.

## Quick Verification Checklist

1. Open the dashboard root (`/`) while signed out -> you should be redirected to `/login`.
2. Click GitHub sign-in -> complete OAuth flow.
3. After login, you should return to the originally requested page.
4. Open a dashboard data endpoint without a session (e.g. `/api/v1/overview`) -> expect `401` JSON.
5. Open `/api/health` without a session -> expect `200` JSON.

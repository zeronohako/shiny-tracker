# Cloud Sync Design

Date: 2026-09-25

## Goal

See and update the same shiny hunts from phone, laptop and any other device, with no manual copying. Personal use: one user, maybe a friend or two. The app must keep working offline and when signed out, exactly as today.

Success: tap "+" on the phone, open the laptop, the new count is there.

## Current state

Static vanilla HTML/JS/CSS on Vercel, no build step. All data is one JSON object `state` (`hunts`, `selected`, `show_stats`, `dark_theme`) written to `localStorage` by `save()` in `app.js`.

## Architecture

- `api/state.js` (new): one Vercel serverless function (Node). No npm dependencies: passwords hashed with `crypto.scrypt`, Upstash Redis reached with `fetch` against its REST API.
- `app.js`: a sync block (pull/push/auth calls) and the sign-in UI handlers.
- `index.html`: a Sync block at the bottom of the Setup tab.
- `test_api.js` (new): server tests.

Redis connection comes from the environment variables the Vercel Upstash integration sets (`KV_REST_API_URL` / `KV_REST_API_TOKEN`; fall back to `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).

### Redis keys

| Key | Value | Expiry |
|---|---|---|
| `user:<username>` | JSON `{ salt, hash, state, updated_at }` | none |
| `token:<random>` | username | 1 year |
| `fails:<username>` | failed login count | 15 minutes from first failure |

Tokens are 32 random bytes, hex-encoded. `updated_at` is an ISO timestamp set by the server.

## API

All bodies are JSON. Authenticated requests send `Authorization: Bearer <token>`.

| Request | Body | Success | Errors |
|---|---|---|---|
| `POST /api/state?action=register` | `{ username, password, state }` | `{ token, updated_at }` | 400 invalid input, 409 username taken |
| `POST /api/state?action=login` | `{ username, password }` | `{ token, state, updated_at }` | 400, 401 wrong credentials, 429 locked |
| `POST /api/state?action=logout` | none (token in header) | `{}` | none; always succeeds |
| `GET /api/state` | none | `{ state, updated_at }` | 401 bad/missing token |
| `PUT /api/state` | `{ state }` | `{ updated_at }` | 400 invalid state, 401 |

### Validation (server-side)

- Username: lowercased, matches `^[a-z0-9_-]{3,32}$`.
- Password: at least 8 characters.
- State: an object with a non-empty `hunts` array; serialized size under 100 KB.
- Login lockout: after 10 failed logins for a username, return 429 until `fails:<username>` expires (15 minutes). A successful login clears the counter.
- The wrong-password and unknown-username cases return the same 401 message: "Wrong username or password".
- Missing Redis env vars: 500 and log a clear message.

## Auth flow (client)

- **Create account:** sends this device's current `state`, which becomes the account's data. Existing local hunts are kept.
- **Sign in:** on success, the device's `state` is replaced by the account's saved state.
- Create and Sign in are separate buttons, so a mistyped username never silently creates an empty account.
- After either succeeds, the device stores `sync = { username, token, synced_at, dirty }` in `localStorage`. The password is never stored.
- **Sign out:** calls logout, then deletes `sync` locally. Local `state` is kept.
- Any 401 on GET/PUT: sign out locally and show "Signed out, sign in again". Local data is kept.

## Sync behavior

Only active when signed in.

- **Pull:** on page load, and on `visibilitychange` to visible. If `dirty` is set, push instead of pulling. Otherwise GET, and if the server's `updated_at` differs from `synced_at`, replace `state` in memory and in `localStorage`, then render.
- **Push:** `save()` writes to `localStorage` as today, sets `dirty = true`, and schedules a PUT of the whole `state` 1 second after the last change (debounced). On success, set `synced_at` to the returned `updated_at` and clear `dirty`.
- **Retry:** a failed push leaves `dirty` set. Retry on the next save, the next visibility change to visible, or the window `online` event.
- **Conflicts:** last write wins at the whole-state level. Known loss case: edits made on an offline device overwrite edits another device made in the meantime once the offline device reconnects. Accepted for single-user, one-device-at-a-time use. Per-hunt merging is out of scope.
- The whole `state` syncs, including `selected` and `dark_theme`.

## UI

A Sync block at the bottom of the Setup tab.

- **Signed out:** username input, password input, Sign in button, Create account button, error line.
- **Signed in:** "Signed in as <name> · Synced <timeAgo>" (reusing `timeAgo`), or "Offline, will sync" while `dirty`. Sign out button.

Error messages shown on the error line:

| Status | Message |
|---|---|
| 400 | the server's validation message |
| 401 (login) | Wrong username or password |
| 409 | Username taken |
| 429 | Too many attempts, try again in 15 minutes |
| network failure | Can't reach the server |

## Testing

`test_api.js`, plain `node` + `assert` like `test_odds.js`. It replaces global `fetch` with an in-memory fake of the Upstash REST commands the handler uses and checks:

- register, then login, then PUT, then GET round-trips the state
- duplicate username is rejected with 409
- wrong password is rejected with 401; the 11th attempt after 10 failures returns 429
- invalid state (missing or empty `hunts`, over 100 KB) is rejected with 400
- GET/PUT with a missing or unknown token return 401
- logout invalidates the token

Client sync is tested by hand: two browsers signed in to the same account; tap "+" in one, focus the other, and confirm the count updated.

## Setup (one-time, manual)

1. In the Vercel dashboard, add the Upstash Redis integration to the `shiny-tracker` project. It sets the env vars.
2. Local development: `vercel dev`.

## Out of scope

- Password reset (edit Redis directly if needed).
- Changing username.
- Per-hunt merge or real-time push between devices.
- Sign-up restrictions (anyone who finds the site can create an account; each account only sees its own data).

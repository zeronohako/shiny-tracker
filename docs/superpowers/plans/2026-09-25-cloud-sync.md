# Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Username/password accounts that sync the tracker's `state` between devices through a Vercel function backed by Upstash Redis.

**Architecture:** One serverless function, `api/state.js`, handles register/login/logout plus GET/PUT of the user's whole `state` blob, talking to Upstash over its REST API with `fetch`. A new browser script, `sync.js`, pushes after every `save()` (debounced 1 s) and pulls on load/focus; last write wins. The app stays fully usable offline and signed out.

**Tech Stack:** Vanilla browser JS (ES5 style: `var`, `function`, no build step), Node (CommonJS) on Vercel, Upstash Redis REST, Node's `crypto.scrypt`. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-cloud-sync-design.md`

## Global Constraints

- No npm dependencies, no `package.json`. Server uses Node built-ins and global `fetch`; browser code uses `var`/`function` like `app.js`.
- Redis env vars: `KV_REST_API_URL` / `KV_REST_API_TOKEN`, falling back to `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
- Keys: `user:<username>` → JSON `{ salt, hash, state, updated_at }`; `token:<random>` → username, 1 year TTL; `fails:<username>` → count, 15 minute TTL.
- Username: trimmed, lowercased, `^[a-z0-9_-]{3,32}$`. Password: at least 8 characters.
- State: object with non-empty `hunts` array, serialized under 100 KB.
- Lockout: 10 failed logins → 429 until the 15-minute counter expires; success clears it.
- Error messages verbatim: "Wrong username or password", "Username taken", "Too many attempts, try again in 15 minutes", "Signed out, sign in again", "Can't reach the server".
- The password is never stored on the device. Signing out keeps local `state`.

## Review Focus

1. Phone keyboards auto-capitalize and add trailing spaces: `" Ash "` must register and log in as `ash` (tested in Task 1; `autocapitalize="none"` in Task 2).
2. A malformed body (username a number, password missing, `state: null`) must return 400, not crash with 500 (tested in Task 1).
3. A "+" tap that lands while a pull is in flight must not be overwritten by the pull's response (`pull()` drops the response when `sync.dirty`; checked by hand in Task 3).
4. A push that fails (offline) must leave the change marked dirty and retry on focus/`online`, never drop it (checked by hand in Task 3).
5. A token revoked on the server (signed out elsewhere, expired) must sign the device out without touching local hunts (tested server-side in Task 1; client checked by hand in Task 3).

---

### Task 1: Sync API

**Files:**
- Create: `api/state.js`
- Test: `test_api.js`

**Interfaces:**
- Consumes: nothing.
- Produces: HTTP API used by Task 2 (all JSON; auth via `Authorization: Bearer <token>`):
  - `POST /api/state?action=register` `{ username, password, state }` → 200 `{ token, updated_at }` | 400 `{ error }` | 409
  - `POST /api/state?action=login` `{ username, password }` → 200 `{ token, state, updated_at }` | 400 | 401 | 429
  - `POST /api/state?action=logout` → 200 `{}`
  - `GET /api/state` → 200 `{ state, updated_at }` | 401
  - `PUT /api/state` `{ state }` → 200 `{ updated_at }` | 400 | 401
  - Every error body is `{ error: "<message shown to the user>" }`.

- [ ] **Step 1: Write the failing test**

Create `test_api.js`:

```js
// node test_api.js
process.env.KV_REST_API_URL = 'http://fake-redis';
process.env.KV_REST_API_TOKEN = 'fake';

// In-memory stand-in for the Upstash REST commands api/state.js uses
const db = new Map();
global.fetch = async (url, opts) => {
  const [cmd, k, v, ...flags] = JSON.parse(opts.body);
  let result = null;
  if (cmd === 'GET') result = db.has(k) ? db.get(k) : null;
  if (cmd === 'SET') { if (!(flags.includes('NX') && db.has(k))) { db.set(k, String(v)); result = 'OK'; } }
  if (cmd === 'DEL') result = db.delete(k) ? 1 : 0;
  if (cmd === 'INCR') { result = (Number(db.get(k)) || 0) + 1; db.set(k, String(result)); }
  if (cmd === 'EXPIRE') result = 1; // ponytail: fake ignores TTLs; tests clear keys by hand instead
  return { json: async () => ({ result }) };
};

const handler = require('./api/state.js');
async function call(method, action, body, token) {
  let code, out;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; } };
  await handler({ method, query: action ? { action } : {}, body, headers: token ? { authorization: 'Bearer ' + token } : {} }, res);
  return Object.assign({ code }, out);
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(msg + ': got ' + a + ', want ' + b); };

(async () => {
  const S = { hunts: [{ encounters: 1 }], selected: 0 };
  const PW = 'pikachu123';

  // register
  eq((await call('POST', 'register', { username: ' Ash ', password: PW, state: S })).code, 200, 'register');
  eq(db.has('user:ash'), true, 'username trimmed + lowercased');
  eq((await call('POST', 'register', { username: 'ash', password: 'another12', state: S })).code, 409, 'duplicate username');
  eq((await call('POST', 'register', { username: 'a', password: PW, state: S })).code, 400, 'short username');
  eq((await call('POST', 'register', { username: 'bad name', password: PW, state: S })).code, 400, 'space in username');
  eq((await call('POST', 'register', { username: 123, password: PW, state: S })).code, 400, 'non-string username');
  eq((await call('POST', 'register', { username: 'misty', password: 'short', state: S })).code, 400, 'short password');
  eq((await call('POST', 'register', { username: 'misty', password: PW, state: { hunts: [] } })).code, 400, 'empty hunts');
  eq((await call('POST', 'register', { username: 'misty', password: PW })).code, 400, 'missing state');
  eq(db.has('user:misty'), false, 'rejected registers store nothing');

  // login
  let r = await call('POST', 'login', { username: 'ASH', password: PW });
  eq(r.code, 200, 'login');
  eq(r.state.hunts[0].encounters, 1, 'login returns saved state');
  const token = r.token;
  eq((await call('POST', 'login', { username: 'ash' })).code, 400, 'missing password');
  eq((await call('POST', 'login', { username: 'nobody', password: PW })).error, 'Wrong username or password', 'unknown user');

  // save + load
  r = await call('PUT', null, { state: { hunts: [{ encounters: 42 }], selected: 0 } }, token);
  eq(r.code, 200, 'put');
  const putAt = r.updated_at;
  r = await call('GET', null, undefined, token);
  eq(r.state.hunts[0].encounters, 42, 'get returns what put saved');
  eq(r.updated_at, putAt, 'get returns put timestamp');
  eq((await call('PUT', null, { state: null }, token)).code, 400, 'null state');
  eq((await call('PUT', null, { state: { hunts: [{ target: 'x'.repeat(100 * 1024) }] } }, token)).code, 400, 'state over 100 KB');
  eq((await call('GET', null, undefined, token)).state.hunts[0].encounters, 42, 'rejected put changes nothing');

  // tokens
  eq((await call('GET', null, undefined)).code, 401, 'no token');
  eq((await call('GET', null, undefined, 'bogus')).code, 401, 'unknown token');
  eq((await call('PUT', null, { state: S }, 'bogus')).code, 401, 'put with unknown token');

  // lockout: 10 failures, then even the right password gets 429
  for (let i = 0; i < 10; i++) eq((await call('POST', 'login', { username: 'ash', password: 'wrong-pass' })).code, 401, 'wrong password #' + (i + 1));
  r = await call('POST', 'login', { username: 'ash', password: PW });
  eq(r.code, 429, 'locked after 10 failures');
  eq(r.error, 'Too many attempts, try again in 15 minutes', 'lockout message');
  db.delete('fails:ash'); // what the 15-minute TTL does in real Redis
  eq((await call('POST', 'login', { username: 'ash', password: PW })).code, 200, 'unlocked after expiry');
  eq(db.has('fails:ash'), false, 'success clears failure count');

  // logout
  eq((await call('POST', 'logout', undefined, token)).code, 200, 'logout');
  eq((await call('GET', null, undefined, token)).code, 401, 'token dead after logout');

  // missing Redis config
  delete process.env.KV_REST_API_URL;
  const origError = console.error; console.error = () => {};
  eq((await call('GET', null, undefined, 'any')).code, 500, 'missing env vars');
  console.error = origError;

  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test_api.js`
Expected: FAIL with `Error: Cannot find module './api/state.js'`

- [ ] **Step 3: Write the implementation**

Create `api/state.js`:

```js
// Cloud sync API: accounts plus one saved `state` per user, stored in Upstash Redis.
// Spec: docs/superpowers/specs/2026-09-25-cloud-sync-design.md
const crypto = require('crypto');

const TOKEN_TTL = 365 * 86400, LOCK_TTL = 15 * 60, MAX_FAILS = 10, MAX_STATE = 100 * 1024;
const WRONG = 'Wrong username or password';

// One Redis command over Upstash's REST API, e.g. redis('SET', 'k', 'v')
async function redis(...cmd) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis env vars missing: add the Upstash Redis integration to this Vercel project');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(cmd) });
  const out = await r.json();
  if (out.error) throw new Error('Redis: ' + out.error);
  return out.result;
}

function cleanName(u) {
  u = typeof u === 'string' ? u.trim().toLowerCase() : '';
  return /^[a-z0-9_-]{3,32}$/.test(u) ? u : null;
}
function validState(s) {
  return !!s && typeof s === 'object' && Array.isArray(s.hunts) && s.hunts.length > 0 &&
    Buffer.byteLength(JSON.stringify(s)) < MAX_STATE;
}
function hash(password, salt) { return crypto.scryptSync(password, salt, 64); }
function passwordOk(user, password) { return crypto.timingSafeEqual(hash(password, user.salt), Buffer.from(user.hash, 'hex')); }
async function getUser(username) { return JSON.parse((await redis('GET', 'user:' + username)) || 'null'); }
async function newToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  await redis('SET', 'token:' + token, username, 'EX', TOKEN_TTL);
  return token;
}
function bearer(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  return m && m[1];
}

module.exports = async function handler(req, res) {
  const send = (code, body) => res.status(code).json(body);
  const body = req.body || {};
  const action = (req.query || {}).action;
  try {
    if (req.method === 'POST' && action === 'register') {
      const username = cleanName(body.username);
      if (!username) return send(400, { error: 'Username must be 3-32 letters, digits, _ or -' });
      if (typeof body.password !== 'string' || body.password.length < 8) return send(400, { error: 'Password must be at least 8 characters' });
      if (!validState(body.state)) return send(400, { error: 'Invalid tracker data' });
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { salt, hash: hash(body.password, salt).toString('hex'), state: body.state, updated_at: new Date().toISOString() };
      // NX: only set if the key doesn't exist, so two registers can't race
      if (!(await redis('SET', 'user:' + username, JSON.stringify(user), 'NX'))) return send(409, { error: 'Username taken' });
      return send(200, { token: await newToken(username), updated_at: user.updated_at });
    }

    if (req.method === 'POST' && action === 'login') {
      const username = cleanName(body.username);
      if (!username) return send(400, { error: 'Username must be 3-32 letters, digits, _ or -' });
      if (typeof body.password !== 'string') return send(400, { error: 'Password required' });
      const failKey = 'fails:' + username;
      if ((Number(await redis('GET', failKey)) || 0) >= MAX_FAILS) return send(429, { error: 'Too many attempts, try again in 15 minutes' });
      const user = await getUser(username);
      if (!user || !passwordOk(user, body.password)) {
        if ((await redis('INCR', failKey)) === 1) await redis('EXPIRE', failKey, LOCK_TTL);
        return send(401, { error: WRONG });
      }
      await redis('DEL', failKey);
      return send(200, { token: await newToken(username), state: user.state, updated_at: user.updated_at });
    }

    if (req.method === 'POST' && action === 'logout') {
      const token = bearer(req);
      if (token) await redis('DEL', 'token:' + token);
      return send(200, {});
    }

    const token = bearer(req);
    const username = token && (await redis('GET', 'token:' + token));
    const user = username && (await getUser(username));
    if (!user) return send(401, { error: 'Signed out, sign in again' });

    if (req.method === 'GET') return send(200, { state: user.state, updated_at: user.updated_at });
    if (req.method === 'PUT') {
      if (!validState(body.state)) return send(400, { error: 'Invalid tracker data' });
      user.state = body.state;
      user.updated_at = new Date().toISOString();
      await redis('SET', 'user:' + username, JSON.stringify(user));
      return send(200, { updated_at: user.updated_at });
    }
    return send(405, { error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return send(500, { error: 'Server error' });
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test_api.js && node test_odds.js`
Expected: `ok` twice.

- [ ] **Step 5: Commit**

```bash
git add api/state.js test_api.js
git commit -m "Add cloud sync API: accounts and per-user saved state in Upstash Redis"
```

---

### Task 2: Client sync and sign-in UI

**Files:**
- Create: `sync.js`
- Modify: `app.js:4` (`save()`), `app.js` last line area (call `initSync()`)
- Modify: `index.html` (Sync block at the bottom of `#setup`, About text, `<script src="sync.js">`)
- Modify: `style.css` (form layout, error colour)

**Interfaces:**
- Consumes: the Task 1 HTTP API. From `app.js`, the globals `state` (a `var`, reassigned here), `render()`, `timeAgo(iso)`, `$(id)`.
- Produces: globals `queuePush()` (called by `save()`) and `initSync()` (called once at the end of `app.js`). `localStorage.sync` = `{ username, token, synced_at, dirty }` while signed in, absent when signed out.

`sync.js` is loaded **before** `app.js`. It only declares functions and reads `localStorage` at the top level, so it doesn't matter that `state`/`render` don't exist yet. They're only used when the functions run.

- [ ] **Step 1: Create `sync.js`**

```js
// Cloud sync. Spec: docs/superpowers/specs/2026-09-25-cloud-sync-design.md
// While signed in, localStorage.sync = { username, token, synced_at, dirty }.
var sync = JSON.parse(localStorage.getItem('sync'));
var pushTimer;

function saveSync() {
  if (sync) localStorage.setItem('sync', JSON.stringify(sync)); else localStorage.removeItem('sync');
  renderSync();
}

// Resolves to { status, body }; status 0 means the network request failed.
function api(method, action, body) {
  var headers = { 'Content-Type': 'application/json' };
  if (sync) headers.Authorization = 'Bearer ' + sync.token;
  return fetch('/api/state' + (action ? '?action=' + action : ''), { method: method, headers: headers, body: body && JSON.stringify(body) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; }); },
      function () { return { status: 0, body: {} }; });
}

function useServerState(s, updatedAt) {
  state = s;
  localStorage.setItem('state', JSON.stringify(state));
  render();
  sync.synced_at = updatedAt;
  saveSync();
}

function signedOut(msg) {
  clearTimeout(pushTimer);
  sync = null;
  saveSync();
  $('sync-error').textContent = msg || '';
}

// Called by save() after every local change.
function queuePush() {
  if (!sync) return;
  sync.dirty = true;
  saveSync();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 1000);
}

function push() {
  if (!sync) return;
  var sent = JSON.stringify(state);
  api('PUT', null, { state: state }).then(function (r) {
    if (r.status === 401) return signedOut('Signed out, sign in again');
    if (r.status !== 200 || !sync) return renderSync(); // stays dirty; retried on next save, focus or 'online'
    sync.synced_at = r.body.updated_at;
    if (JSON.stringify(state) === sent) sync.dirty = false; // else a newer change already queued its own push
    saveSync();
  });
}

function pull() {
  if (!sync) return;
  if (sync.dirty) return push(); // our unsent changes are newer: last write wins
  api('GET').then(function (r) {
    if (r.status === 401) return signedOut('Signed out, sign in again');
    if (r.status !== 200 || !sync || sync.dirty) return; // dirty: a tap landed mid-request, keep it
    if (r.body.updated_at !== sync.synced_at) useServerState(r.body.state, r.body.updated_at);
  });
}

// action: 'login' replaces this device's hunts; 'register' uploads them.
function signIn(action) {
  var body = { username: $('sync-user').value, password: $('sync-pass').value };
  if (action === 'register') body.state = state;
  $('sync-error').textContent = '';
  api('POST', action, body).then(function (r) {
    if (r.status !== 200) {
      $('sync-error').textContent = r.status ? r.body.error || 'Server error' : 'Can\'t reach the server';
      return;
    }
    sync = { username: body.username.trim().toLowerCase(), token: r.body.token, synced_at: r.body.updated_at, dirty: false };
    $('sync-pass').value = '';
    if (action === 'login') useServerState(r.body.state, r.body.updated_at); else saveSync();
  });
}

function renderSync() {
  $('sync-out').hidden = !!sync;
  $('sync-in').hidden = !sync;
  if (sync) $('sync-status').textContent = 'Signed in as ' + sync.username + ' · ' +
    (sync.dirty ? 'Offline, will sync' : 'Synced ' + timeAgo(sync.synced_at));
}

function initSync() {
  $('sync-out').onsubmit = function (e) { e.preventDefault(); signIn('login'); };
  $('sync-register').onclick = function () { signIn('register'); };
  $('sync-signout').onclick = function () { api('POST', 'logout'); signedOut(); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });
  window.addEventListener('online', pull);
  setInterval(renderSync, 60000);
  renderSync();
  pull();
}
```

- [ ] **Step 2: Hook it into `app.js`**

Change line 4 from:

```js
function save() { localStorage.setItem('state', JSON.stringify(state)); render(); }
```

to:

```js
function save() { localStorage.setItem('state', JSON.stringify(state)); render(); queuePush(); }
```

Append at the very end of `app.js` (after the `$('pokemon-list').innerHTML = ...` line):

```js
initSync();
```

- [ ] **Step 3: Add the markup to `index.html`**

In `#setup`, after `<p class="center"><button class="btn danger" id="reset">⟲ Reset count</button></p>` and before `</section>`, add:

```html
    <h3>Sync</h3>
    <form id="sync-out" class="sync-form">
      <input id="sync-user" class="form-control" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      <input id="sync-pass" class="form-control" type="password" placeholder="Password" autocomplete="current-password" required>
      <div class="btn-group">
        <button class="btn success">Sign in</button><button class="btn" type="button" id="sync-register">Create account</button>
      </div>
    </form>
    <div id="sync-in" hidden>
      <p id="sync-status"></p>
      <button class="btn" id="sync-signout">Sign out</button>
    </div>
    <p id="sync-error" class="error"></p>
```

In `#about`, replace:

```html
    <p>All numbers are probabilities, not guarantees. Your settings and count are stored only in this browser (localStorage); nothing is sent anywhere.</p>
```

with:

```html
    <p>All numbers are probabilities, not guarantees. Your settings and count are stored in this browser (localStorage). If you sign in under Setup → Sync, they're also saved to this site's server so your other devices can load them.</p>
```

Change the scripts at the bottom to load `sync.js` before `app.js`:

```html
<script src="pokemon.js"></script>
<script src="odds.js"></script>
<script src="sync.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 4: Add styles to the end of `style.css`**

`display: flex` would override the `hidden` attribute, hence `:not([hidden])`:

```css
.sync-form:not([hidden]) { display: flex; flex-direction: column; gap: 8px; }
.error { color: var(--red); }
```

- [ ] **Step 5: Check that nothing broke signed-out**

Run: `node --check sync.js && node --check app.js && node test_odds.js && node test_api.js`
Expected: no syntax errors, `ok` twice.

Then open `index.html` directly in a browser (`file://`). Expected: the Sync block shows the sign-in form; "+" and "−" still work and survive a reload; no console errors. Pressing Sign in shows "Can't reach the server" (there's no API on `file://`).

- [ ] **Step 6: Commit**

```bash
git add sync.js app.js index.html style.css
git commit -m "Sync hunts across devices when signed in"
```

---

### Task 3: Connect Redis and verify end to end

The user does steps 1–2 in the Vercel dashboard/terminal; the implementer can't.

**Files:** none.

- [ ] **Step 1 (user): Add storage**

In the Vercel dashboard → project `shiny-tracker` → Storage → add **Upstash Redis** (free plan) and connect it to all environments. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

- [ ] **Step 2 (user): Run locally**

```bash
npm i -g vercel   # if not installed
vercel env pull   # writes .env.local with the Redis vars
vercel dev
```

Make sure `.env.local` is in `.gitignore` before committing anything (add the line if missing).

- [ ] **Step 3: Two-browser check** against the `vercel dev` URL, using a normal window (A) and a private window (B):

1. A: add a hunt with a target, count to 5, then Setup → Create account `test-user` / `password123`. Expected: "Signed in as test-user · Synced just now".
2. B: Sign in as `TEST-USER ` (caps, trailing space). Expected: B shows A's hunts with count 5.
3. B: tap "+" 3 times. Status shows "Offline, will sync" briefly, then "Synced just now".
4. A: switch to another tab and back. Expected: count is 8.
5. A: DevTools → Network → Offline. Tap "+" twice. Expected: status stays "Offline, will sync". Set back to Online. Expected: status becomes "Synced just now"; focusing B shows 10.
6. B: Sign out. Expected: form returns, hunts still on screen. A: focus the tab. Expected: A is still signed in (other device's sign-out only kills B's token).
7. B: Sign in with a wrong password 10 times, then the right one. Expected: "Wrong username or password" ×10, then "Too many attempts, try again in 15 minutes".

- [ ] **Step 4 (user): Deploy**

Push to `main` (the project deploys from Git), then repeat check 1–4 with the phone as device B on the production URL.

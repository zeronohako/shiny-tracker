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

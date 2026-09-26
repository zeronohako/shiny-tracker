// Cloud sync. Spec: docs/superpowers/specs/2026-09-25-cloud-sync-design.md
// While signed in, localStorage.sync = { username, token, synced_at, dirty }.
var sync = JSON.parse(localStorage.getItem('sync'));
var pushTimer, pushing;

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
  if (!sync || pushing) return; // one PUT at a time, so an older one can't land last
  pushing = true;
  var sent = JSON.stringify(state);
  api('PUT', null, { state: state }).then(function (r) {
    pushing = false;
    if (r.status === 401) return signedOut('Signed out, sign in again');
    if (r.status !== 200 || !sync) return renderSync(); // stays dirty; retried on next save, focus or 'online'
    sync.synced_at = r.body.updated_at;
    if (JSON.stringify(state) === sent) sync.dirty = false;
    saveSync();
    if (sync.dirty) push(); // changed while this PUT was out
  });
}

function pull() {
  if (!sync) return;
  if (sync.dirty) return push(); // our unsent changes are newer: last write wins
  var seen = sync.synced_at;
  api('GET').then(function (r) {
    if (r.status === 401) return signedOut('Signed out, sign in again');
    // dirty or a newer synced_at: a tap landed (or was pushed) mid-request, keep it
    if (r.status !== 200 || !sync || sync.dirty || sync.synced_at !== seen) return;
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
  window.addEventListener('focus', pull);
  setInterval(renderSync, 60000);
  renderSync();
  pull();
}

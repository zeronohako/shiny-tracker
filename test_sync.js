// node test_sync.js — runs sync.js on two fake devices against the real api/state.js and an in-memory Redis.
const vm = require('vm'), fs = require('fs');
process.env.KV_REST_API_URL = 'http://fake-redis';
process.env.KV_REST_API_TOKEN = 'fake';
const db = new Map();
global.fetch = async (url, opts) => { // Upstash REST fake, same as test_api.js
  const [cmd, k, v, ...flags] = JSON.parse(opts.body);
  let result = null;
  if (cmd === 'GET') result = db.has(k) ? db.get(k) : null;
  if (cmd === 'SET' && !(flags.includes('NX') && db.has(k))) { db.set(k, String(v)); result = 'OK'; }
  if (cmd === 'DEL') result = db.delete(k) ? 1 : 0;
  if (cmd === 'INCR') { result = (Number(db.get(k)) || 0) + 1; db.set(k, String(result)); }
  return { json: async () => ({ result }) };
};
const handler = require('./api/state.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b, msg) => { if (a !== b) throw new Error(msg + ': got ' + a + ', want ' + b); };
const serverCount = () => JSON.parse(db.get('user:test-user')).state.hunts[0].encounters;

// A device: sync.js in its own global scope with fake DOM/localStorage/fetch.
// d.offline makes fetch fail; d.delays is a queue of [ms before the server sees it, ms before the reply arrives].
function device(hunts) {
  const els = {}, store = {}, on = {}, d = { offline: false, delays: [] };
  const ctx = { setTimeout, clearTimeout, setInterval: () => 0, JSON, Promise,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    document: { hidden: false, addEventListener: (e, f) => { on[e] = f; } },
    window: { addEventListener: (e, f) => { on[e] = f; } },
    $: (id) => els[id] || (els[id] = { value: '', textContent: '', hidden: false }),
    render() {}, timeAgo: () => 'just now',
    fetch: async (url, o) => {
      if (d.offline) throw new TypeError('offline');
      const [pre, post] = d.delays.shift() || [0, 0];
      await sleep(pre);
      const headers = {};
      for (const k in o.headers) headers[k.toLowerCase()] = o.headers[k];
      let code, out;
      await handler({ method: o.method, query: Object.fromEntries(new URL(url, 'http://h').searchParams), headers, body: o.body && JSON.parse(o.body) },
        { status(c) { code = c; return this; }, json(b) { out = b; } });
      await sleep(post);
      return { status: code, json: async () => out };
    } };
  vm.createContext(ctx);
  vm.runInContext('var state = ' + JSON.stringify({ hunts, selected: 0 }) + ';', ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/sync.js', 'utf8'), ctx);
  return Object.assign(d, { run: (js) => vm.runInContext(js, ctx), el: ctx.$, store, on,
    tap: () => vm.runInContext('state.hunts[0].encounters++; queuePush()', ctx),
    count: () => vm.runInContext('state.hunts[0].encounters', ctx) });
}

(async () => {
  const A = device([{ target: 'Eevee', encounters: 5 }]), B = device([{ target: '', encounters: 0 }]);
  A.run('initSync()'); B.run('initSync()');
  eq(A.el('sync-out').hidden, false, 'signed out: form visible');

  // register uploads, sign in downloads
  A.el('sync-user').value = 'test-user'; A.el('sync-pass').value = 'password123';
  A.el('sync-register').onclick(); await sleep(300);
  eq(A.el('sync-status').textContent, 'Signed in as test-user · Synced just now', 'A registered');
  eq(A.el('sync-pass').value, '', 'password field cleared');
  eq(JSON.parse(A.store.sync).password, undefined, 'password not stored');
  B.el('sync-user').value = 'TEST-USER '; B.el('sync-pass').value = 'password123';
  B.el('sync-out').onsubmit({ preventDefault() {} }); await sleep(300);
  eq(B.run('state.hunts[0].target'), 'Eevee', 'sign-in replaces hunts with saved ones');
  eq(JSON.parse(B.store.state).hunts[0].encounters, 5, 'sign-in writes localStorage');

  // debounced push, pull on visibility
  B.tap(); B.tap(); B.tap();
  eq(B.el('sync-status').textContent.includes('Offline, will sync'), true, 'dirty while waiting to push');
  await sleep(1100);
  eq(B.run('sync.dirty'), false, 'pushed after debounce');
  A.on.visibilitychange(); await sleep(300);
  eq(A.count(), 8, 'pull on visibilitychange');

  // pull on window focus (tab visible all along, e.g. laptop next to the phone)
  B.tap(); await sleep(1100);
  A.on.focus(); await sleep(300);
  eq(A.count(), 9, 'pull on window focus');

  // a tap during an in-flight pull survives
  B.tap(); await sleep(1100); // server 10
  A.delays.push([0, 100]); A.run('pull()'); await sleep(20);
  A.run('state.hunts[0].encounters = 42; queuePush()'); await sleep(150);
  eq(A.count(), 42, 'unpushed tap survives in-flight pull');
  await sleep(1000);
  eq(serverCount(), 42, 'then pushed');

  // a tap pushed while a slow pull is still out survives the pull's late reply
  A.delays.push([0, 1500]); A.run('pull()'); await sleep(20);
  A.tap(); await sleep(1600);
  eq(A.count(), 43, 'pushed tap survives late pull reply');
  eq(serverCount(), 43, 'server keeps pushed tap');

  // an older PUT that lands late can't overwrite a newer one
  A.delays.push([1500, 0]); A.tap(); await sleep(1100); // PUT of 44 hits the server at ~2.5 s
  A.tap(); await sleep(1600);                          // 45 must not be sent (and stored) first
  eq(serverCount(), 45, 'newest push wins on server');
  eq(A.run('sync.dirty'), false, 'synced afterwards');

  // offline push stays dirty, retries when back online
  A.offline = true; A.tap(); await sleep(1100);
  eq(A.run('sync.dirty'), true, 'offline push stays dirty');
  A.offline = false; A.on.online(); await sleep(300);
  eq(serverCount(), 46, 'retried on online');

  // sign out, revoked token
  B.el('sync-signout').onclick(); await sleep(300);
  eq(B.el('sync-out').hidden, false, 'sign out shows form');
  eq(B.count(), 10, 'sign out keeps local hunts');
  for (const k of db.keys()) if (k.startsWith('token:')) db.delete(k);
  A.on.visibilitychange(); await sleep(300);
  eq(A.el('sync-error').textContent, 'Signed out, sign in again', 'revoked token signs out');
  eq(A.store.sync, undefined, 'sync cleared from storage');
  eq(A.count(), 46, 'revoked token keeps local hunts');

  // error messages
  A.el('sync-user').value = 'test-user'; A.el('sync-pass').value = 'wrongpass1';
  A.el('sync-out').onsubmit({ preventDefault() {} }); await sleep(300);
  eq(A.el('sync-error').textContent, 'Wrong username or password', 'wrong password message');
  A.offline = true; A.el('sync-out').onsubmit({ preventDefault() {} }); await sleep(300);
  eq(A.el('sync-error').textContent, "Can't reach the server", 'network error message');
  A.offline = false; A.el('sync-register').onclick(); await sleep(300);
  eq(A.el('sync-error').textContent, 'Username taken', 'duplicate username message');

  console.log('ok');
})().catch((e) => { console.error(e.message); process.exit(1); });

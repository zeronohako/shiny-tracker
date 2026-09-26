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

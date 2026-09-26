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

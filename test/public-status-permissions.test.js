import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { initDatabase } from '../src/database/schema.js';
import { buildHistoryId } from '../src/database/indexOptimization.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { generateToken, buildAuthCookie } from '../src/middleware/auth.js';
import { handleServerAPI, handleServersAPI } from '../src/handlers/dashboard.js';
import { handleWebSocketUpgrade, handleUpdateWebSocketUpgrade } from '../src/handlers/update.js';

// Execute the project's actual SQL/schema against isolated SQLite. No cloud or workerd required.
const sqlite = new DatabaseSync(':memory:');
const db = {
  prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      }
    };
  },
  async batch(statements) { return Promise.all(statements.map(statement => statement.all())); }
};
const settings = { is_public: 'true', wss_report_enabled: 'false', jwt_secret: 'permission-test-only-'.padEnd(40, 'x'), servers_optimized: 'true' };
const env = { API_SECRET: 'local-permissions-test-only', DB: db };
const ctx = { waitUntil() {} };
let token;
let forwarded;
const metrics = { cpu: 73, ram_used: 2345, disk_used: 3456, net_rx: 98765, ip_v4: '198.51.100.42' };

function request(path, headers = {}, method = 'GET', body) {
  return new Request('https://local.invalid' + path, { method, headers, body });
}
const call = (path, headers, method, body) => worker.fetch(request(path, headers, method, body), env, ctx);

before(async () => {
  // Admin config normally checks upstream versions; keep the suite entirely local.
  mock.method(globalThis, 'fetch', async () => Response.json({ success: true, workers: 'test', agent: 'test' }));
  await initDatabase(db);
  token = await generateToken(env, settings);
  env.METRICS_BROADCASTER = {
    idFromName: () => 'test-global',
    get: () => ({ async fetch(input) {
      forwarded++;
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (path === '/ws' || path === '/update') return { status: 101 };
      if (path === '/health') return Response.json({ ok: true });
      return Response.json({ updates: [] });
    } })
  };
});
beforeEach(async () => {
  clearAllCaches();
  forwarded = 0;
  sqlite.exec('DELETE FROM servers; DELETE FROM metrics_history; DELETE FROM settings');
  await db.prepare('INSERT INTO settings (key,value) VALUES (?,?)')
    .bind('site_options', JSON.stringify(settings)).run();
  const now = Date.now();
  for (const [index, name, region, hidden, age] of [
    [1, 'Tokyo', 'JP', '0', 60000], [2, 'Frankfurt', 'DE', '0', 600000], [3, 'Hidden', 'US', '1', 60000]
  ]) {
    const id = 'private-server-id-' + index;
    await db.prepare(`INSERT INTO servers (id,name,region,is_hidden,history_partition_id,timestamp,price,note)
      VALUES (?,?,?,?,?,?,?,?)`).bind(id, name, region, hidden, index, now - 3600000, 'private-price', 'private-note').run();
    await db.prepare(`INSERT INTO metrics_history (id,server_id,timestamp,cpu,ram_used,disk_used,net_rx,ip_v4)
      VALUES (?,?,?,?,?,?,?,?)`).bind(buildHistoryId(index, now - age), id, now - age,
        metrics.cpu, metrics.ram_used, metrics.disk_used, metrics.net_rx, metrics.ip_v4).run();
  }
});
after(() => { mock.restoreAll(); sqlite.close(); });

test('public status exposes only aliases, regions, online booleans and visible counts', async () => {
  for (const headers of [{}, { Authorization: 'Bearer ' + token }]) {
    const response = await call('/api/status', headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), {
      servers: [{ name: 'Tokyo', region: 'JP', online: true }, { name: 'Frankfurt', region: 'DE', online: false }],
      stats: { total: 2, online: 1, offline: 1 }
    });
  }
});

test('empty public status reports zero counts', async () => {
  sqlite.exec('DELETE FROM servers; DELETE FROM metrics_history');
  const response = await call('/api/status');
  assert.deepEqual(await response.json(), { servers: [], stats: { total: 0, online: 0, offline: 0 } });
});

test('public status reports unavailability instead of inventing offline nodes on a database failure', async () => {
  const original = db.batch;
  const silent = mock.method(console, 'error', () => {});
  db.batch = async () => { throw new Error('private database diagnostic'); };
  try {
    const response = await call('/api/status');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Status temporarily unavailable' });
  } finally {
    db.batch = original;
    silent.mock.restore();
  }
});

test('anonymous private reads are denied even when legacy is_public is true', async () => {
  for (const headers of [{}, { Authorization: 'Bearer invalid' }, { Cookie: 'cfsm_auth=invalid' }]) {
    for (const path of ['/api/servers', '/api/server?id=private-server-id-1', '/api/history/all?id=private-server-id-1&hours=1', '/__do/health', '/theme']) {
      const response = await call(path, headers);
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /private-price|private-server-id|198\.51\.100|2345|98765/);
    }
  }
  assert.equal(forwarded, 0);
});

test('HTTP query tokens and the Agent secret cannot unlock private reads', async () => {
  for (const headers of [{}, { Authorization: 'Bearer ' + env.API_SECRET }]) {
    assert.equal((await call('/api/servers?token=' + token, headers)).status, 401);
  }
});

test('expired admin credentials cannot read metrics or open browser WebSocket', async () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=/g, '');
  const unsigned = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: 'admin', exp: 1 });
  const expired = unsigned + '.' + createHmac('sha256', settings.jwt_secret).update(unsigned).digest('base64').replace(/=/g, '');
  assert.equal((await call('/api/servers', { Authorization: 'Bearer ' + expired })).status, 401);
  assert.equal((await call('/api/ws?token=' + encodeURIComponent(expired), { Upgrade: 'websocket' })).status, 401);
  assert.equal(forwarded, 0);
});

test('public projection stays safe after the administrator has warmed the full metrics cache', async () => {
  assert.equal((await call('/api/servers', { Authorization: 'Bearer ' + token })).status, 200);
  const status = await (await call('/api/status')).json();
  assert.equal(status.servers.length, 2);
  assert.ok(status.servers.every(row => Object.keys(row).sort().join(',') === 'name,online,region'));
  assert.doesNotMatch(JSON.stringify(status), /private-price|private-server-id|198\.51\.100|2345|98765|Hidden/);
});

test('direct detail/list handlers also reject anonymous reads', async () => {
  for (const handler of [handleServerAPI, handleServersAPI]) {
    assert.equal((await handler(request('/api/server?id=private-server-id-1'), env, settings)).status, 401);
  }
});

test('admin bearer and cookie retain full metrics, hidden nodes and history access', async () => {
  for (const headers of [{ Authorization: 'Bearer ' + token }, { Cookie: buildAuthCookie(request('/'), token) }]) {
    const list = await call('/api/servers', headers);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('Cache-Control'), 'no-store');
    const data = await list.json();
    assert.equal(data.servers.length, 3);
    assert.equal(data.servers[0].cpu, metrics.cpu);
    assert.equal(data.servers[0].ram_used, metrics.ram_used);
    assert.equal(data.servers[0].price, 'private-price');
    const detail = await call('/api/server?id=private-server-id-1', headers);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).disk_used, metrics.disk_used);
    const history = await call('/api/history/all?id=private-server-id-1&hours=1', headers);
    assert.equal(history.status, 200);
    assert.ok((await history.json()).some(row => row.cpu === metrics.cpu));
  }
});

test('anonymous config is allowlisted; authenticated config remains available without cache sharing', async () => {
  const admin = await call('/api/config', { Authorization: 'Bearer ' + token });
  assert.equal((await admin.json()).authorization, true);
  const response = await call('/api/config');
  const config = await response.json();
  assert.deepEqual(Object.keys(config).sort(), ['authorization', 'default_language', 'is_public', 'preferred_theme', 'site_title', 'turnstile_enabled', 'turnstile_login_enabled', 'turnstile_site_key'].sort());
  assert.equal(config.authorization, false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('admin config retains global Turnstile verification without exposing private config anonymously', async () => {
  await db.prepare('UPDATE settings SET value = ? WHERE key = ?')
    .bind(JSON.stringify({ ...settings, turnstile_enabled: 'true', turnstile_site_key: 'test-site', turnstile_secret_key: 'test-turnstile-only' }), 'site_options').run();
  clearAllCaches();
  const response = await call('/api/config', { Authorization: 'Bearer ' + token, 'X-Turnstile-Token': 'local-test-only' });
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.authorization, true);
  assert.equal(config.verified, true);
  assert.equal(config.turnstile_enabled, true);
});

test('anonymous/forged/Agent credentials cannot subscribe to browser WebSocket', async () => {
  for (const suffix of ['', '?token=invalid', '?token=' + env.API_SECRET]) {
    const response = await handleWebSocketUpgrade(request('/api/ws' + suffix, { Upgrade: 'websocket' }), env);
    assert.equal(response.status, 401);
  }
  assert.equal(forwarded, 0);
});

test('admin WebSocket accepts bearer, cookie and query JWT before forwarding', async () => {
  for (const [suffix, headers] of [
    ['', { Authorization: 'Bearer ' + token }], ['', { Cookie: buildAuthCookie(request('/'), token) }],
    ['?token=' + encodeURIComponent(token), {}]
  ]) {
    const response = await call('/api/ws' + suffix, { Upgrade: 'websocket', ...headers });
    assert.equal(response.status, 101);
  }
  assert.equal(forwarded, 3);
});

test('admin API keeps login and authenticated management while denying anonymous management', async () => {
  const login = await call('/admin/api', { 'Content-Type': 'application/json' }, 'POST',
    JSON.stringify({ action: 'login', username: 'admin', password: env.API_SECRET }));
  assert.equal(login.status, 200);
  const { token: loginToken } = await login.json();
  assert.ok(loginToken);
  assert.match(login.headers.get('Set-Cookie'), /HttpOnly/);
  for (const [headers, expected] of [[{}, 401], [{ Authorization: 'Bearer ' + loginToken }, 200]]) {
    assert.equal((await call('/admin/api', { 'Content-Type': 'application/json', ...headers }, 'POST', JSON.stringify({ action: 'list' }))).status, expected);
  }
});

test('Agent POST remains independently authenticated, without requiring an admin JWT', async () => {
  const response = await call('/update', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ id: 'private-server-id-1', secret: 'invalid' }));
  assert.equal(response.status, 401);
  const acceptedSecret = await call('/update', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ id: 'nonexistent', secret: env.API_SECRET }));
  assert.equal(acceptedSecret.status, 404); // Passed Agent authentication and reached the server lookup.
  // Disabled WSS retains its original mode-switch envelope, not an admin-login error.
  const ws = await handleUpdateWebSocketUpgrade(request('/update', { Upgrade: 'websocket' }), env);
  assert.equal(ws.status, 409);
  assert.equal(ws.headers.get('X-Agent-Wss-Mode'), 'disabled');
});

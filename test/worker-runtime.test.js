import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';

const TEST_SECRET = 'runtime-test-only-not-a-production-key';
const SERVER_ID = '550e8400-e29b-41d4-a716-446655440001';

function message(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('WebSocket message timed out')); }, 10000);
    function listener(event) {
      const data = JSON.parse(event.data);
      if (!predicate(data)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', listener);
      resolve(data);
    }
    socket.addEventListener('message', listener);
  });
}

test('bundled Worker with real local D1, SQLite DO, assets and WebSockets', { timeout: 60000 }, async t => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: resolve('.wrangler/test-bundle/index.js'),
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { API_SECRET: TEST_SECRET },
    d1Databases: { DB: 'cfsm-runtime-test-only' },
    durableObjects: { METRICS_BROADCASTER: { className: 'MetricsBroadcaster', useSQLite: true } },
    assets: {
      directory: resolve('dist'), binding: 'ASSETS',
      // Match Wrangler's assets-first routing, falling back to the Worker for API/HTML routes.
      routerConfig: { has_user_worker: true }
    }
  });
  const sockets = [];
  const fetch = (path, init) => mf.dispatchFetch('http://local.invalid' + path, init);
  const post = (path, body, token) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  let token;
  try {
    await t.test('initializes only local D1 and authenticates the administrator', async () => {
      assert.equal((await fetch('/api/config')).status, 200);
      const login = await post('/admin/api', { action: 'login', username: 'admin', password: TEST_SECRET });
      assert.equal(login.status, 200);
      token = (await login.json()).token;
      assert.ok(token);
      assert.match(login.headers.get('Set-Cookie'), /HttpOnly/);
      const db = await mf.getD1Database('DB');
      for (const [id, name, hidden, partition] of [[SERVER_ID, 'Tokyo alias', '0', 1], ['hidden-node', 'Hidden alias', '1', 2]]) {
        await db.prepare(`INSERT INTO servers (id,name,region,is_hidden,history_partition_id,timestamp,price) VALUES (?,?,?,?,?,?,?)`)
          .bind(id, name, 'JP', hidden, partition, Date.now() - 3600000, 'private-price').run();
      }
    });
    await t.test('anonymous and forged credentials cannot access private HTTP or browser WebSocket', async () => {
      for (const headers of [{}, { Authorization: 'Bearer forged' }, { Cookie: 'cfsm_auth=forged' }]) {
        for (const path of ['/api/servers', '/api/server?id=' + SERVER_ID, '/api/history/all?id=' + SERVER_ID, '/__do/health']) {
          assert.equal((await fetch(path, { headers })).status, 401, path);
        }
        assert.equal((await fetch('/api/ws?subscribe=all', { headers: { Upgrade: 'websocket', ...headers } })).status, 401);
      }
    });
    await t.test('Agent POST validates its own secret and persists real metrics to D1', async () => {
      const body = { id: SERVER_ID, secret: 'invalid', metrics: { cpu: 71, ram_used: 1234, disk_used: 2345, net_rx: 3456, timestamp: Date.now() } };
      assert.equal((await post('/update', body)).status, 401);
      body.secret = TEST_SECRET;
      assert.equal((await post('/update', body)).status, 200);
      const db = await mf.getD1Database('DB');
      const row = await db.prepare('SELECT cpu,ram_used FROM metrics_history WHERE server_id = ?').bind(SERVER_ID).first();
      assert.equal(row.cpu, 71);
      assert.equal(row.ram_used, 1234);
    });
    await t.test('public status excludes all metrics, identifiers and hidden servers', async () => {
      const response = await fetch('/api/status');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        servers: [{ name: 'Tokyo alias', region: 'JP', online: true }], stats: { total: 1, online: 1, offline: 0 }
      });
    });
    await t.test('admin Bearer/Cookie retain private metrics and history', async () => {
      for (const headers of [{ Authorization: 'Bearer ' + token }, { Cookie: 'cfsm_auth=' + encodeURIComponent(token) }]) {
        const response = await fetch('/api/servers', { headers });
        assert.equal(response.status, 200);
        const servers = (await response.json()).servers;
        assert.equal(servers.length, 2);
        assert.equal(servers.find(row => row.id === SERVER_ID).cpu, 71);
        const history = await fetch('/api/history/all?id=' + SERVER_ID + '&hours=1', { headers });
        assert.equal(history.status, 200);
        assert.ok((await history.json()).some(row => row.cpu === 71));
      }
      const status = await (await fetch('/api/status')).json();
      assert.deepEqual(Object.keys(status.servers[0]).sort(), ['name', 'online', 'region']);
    });
    await t.test('public/admin HTML and built assets are served by the real assets binding', async () => {
      for (const path of ['/', '/admin']) {
        const response = await fetch(path);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /id="app"/);
      }
      const html = readFileSync('dist/dashboard.html', 'utf8');
      const path = html.match(/src="(\/static\/[^" ]+\.js)"/)[1];
      const asset = await fetch(path);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), readFileSync('dist' + path, 'utf8'));
    });
    await t.test('authenticated browser WebSocket reaches the actual DO and responds to heartbeat', async () => {
      for (const [suffix, headers] of [['', { Authorization: 'Bearer ' + token }], ['', { Cookie: 'cfsm_auth=' + encodeURIComponent(token) }], ['&token=' + encodeURIComponent(token), {}]]) {
        const response = await fetch('/api/ws?subscribe=all' + suffix, { headers: { Upgrade: 'websocket', ...headers } });
        assert.equal(response.status, 101);
        const socket = response.webSocket;
        sockets.push(socket);
        const hello = message(socket, data => data.type === 'hello');
        socket.accept();
        assert.equal((await hello).subscribed, 'all');
        const pong = message(socket, data => data.type === 'pong');
        socket.send(JSON.stringify({ type: 'ping' }));
        await pong;
        socket.close();
      }
    });
    await t.test('real Agent WebSocket rejects an invalid secret and accepts a valid metric report', async () => {
      for (const valid of [false, true]) {
        const response = await fetch('/update', { headers: { Upgrade: 'websocket' } });
        assert.equal(response.status, 101);
        const socket = response.webSocket;
        sockets.push(socket);
        const hello = message(socket, data => data.type === 'hello');
        socket.accept();
        await hello;
        const result = message(socket, data => valid ? data.type === 'ack' : data.type === 'error');
        socket.send(JSON.stringify({ id: SERVER_ID, secret: valid ? TEST_SECRET : 'invalid', metrics: { cpu: 72, ram_used: 4321, timestamp: Date.now() + 1000 } }));
        const data = await result;
        if (!valid) assert.equal(data.code, 401);
        else assert.equal(data.persisted, true);
        socket.close();
      }
      const db = await mf.getD1Database('DB');
      const row = await db.prepare('SELECT cpu FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1').bind(SERVER_ID).first();
      assert.equal(row.cpu, 72);
    });
  } finally {
    for (const socket of sockets) { try { socket.close(); } catch {} }
    await mf.dispose();
  }
});

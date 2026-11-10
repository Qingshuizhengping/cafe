import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import net from 'node:net';
import {createAccountServer} from './account-server.mjs';

const origin = 'https://cafe.example.test';
const password = 'test account password';

// 只做握手：拿 WebSocket 升级的状态行判断账号鉴权有没有接上，
// 数据转发本身由 scale-bridge-server.test.mjs 覆盖（那边不经过 undici 的 WebSocket）。
function upgrade(port, {cookie, role = 'viewer'} = {}) {
  return new Promise((resolve, reject) => {
    const state = {buffer: '', settled: false};
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET /api/scale/relay?role=${role} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '', '',
      ];
      socket.write(lines.join('\r\n'));
    });
    const settle = (fn, value) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      try { socket.destroy(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, new Error('握手超时: ' + JSON.stringify(state.buffer.slice(0, 80)))), 4000);
    socket.on('data', chunk => {
      state.buffer += chunk.toString('latin1');
      const status = state.buffer.split('\r\n')[0];
      if (!status.includes(' ')) return;
      settle(resolve, {status: Number(status.split(' ')[1]), raw: status});
    });
    socket.on('error', error => settle(reject, error));
    socket.on('close', () => settle(reject, new Error('连接在握手前关闭')));
  });
}

async function boot(t) {
  const server = createAccountServer({databasePath: ':memory:', origin});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => {
    // 中继会一直挂着的升级 socket，先把它们掐掉再关服务，否则 close 回调永远等不到
    server.closeAllConnections?.();
    server.close();
  });
  const call = (route, {method = 'GET', session, body} = {}) => fetch(`http://127.0.0.1:${port}/api/account/${route}`, {
    method,
    headers: {
      Origin: origin,
      ...(session ? {Cookie: session.cookie, 'X-Cafe-Account': session.id} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sign = async (route, name) => {
    const response = await call(route, {method: 'POST', body: {name, password}});
    assert.equal(response.status, route === 'register' ? 201 : 200);
    return {id: (await response.json()).user.id, cookie: response.headers.get('set-cookie').split(';')[0]};
  };
  return {port, sign};
}

test('秤中继挂在账号服务上：没登录 401，登录后 101，登出后 401', async t => {
  const {port, sign} = await boot(t);
  assert.equal((await upgrade(port)).status, 401);

  const alice = await sign('register', 'alice');
  const phone = await sign('login', 'alice');
  assert.equal((await upgrade(port, {cookie: alice.cookie, role: 'pusher'})).status, 101);
  assert.equal((await upgrade(port, {cookie: phone.cookie})).status, 101);

  // 第二个 pusher 抢不到同一个房间
  assert.equal((await upgrade(port, {cookie: phone.cookie, role: 'pusher'})).status, 409);

  // 伪造的 Cookie 不被认
  assert.equal((await upgrade(port, {cookie: '__Host-doudang=' + 'a'.repeat(64)})).status, 401);

  // 登出后同一个 Cookie 失效
  assert.equal((await callLogout(port, phone)).status, 200);
  assert.equal((await upgrade(port, {cookie: phone.cookie})).status, 401);
});

async function callLogout(port, session) {
  return fetch(`http://127.0.0.1:${port}/api/account/logout`, {
    method: 'POST', headers: {Origin: origin, Cookie: session.cookie, 'X-Cafe-Account': session.id},
  });
}

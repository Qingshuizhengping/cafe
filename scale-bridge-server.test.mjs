import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {attachScaleRelay} from './scale-bridge-server.mjs';

async function startRelay({authenticate = () => 'u_test0001'} = {}) {
  const server = http.createServer((request, response) => { response.writeHead(404); response.end(); });
  const relay = attachScaleRelay(server, {authenticate});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const url = `ws://127.0.0.1:${port}/api/scale/relay`;
  const clients = [];
  const open = (role, {expectFail = false} = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}?role=${role}`);
    clients.push(socket);
    socket.addEventListener('open', () => (expectFail ? reject(new Error('不该连上')) : resolve(socket)), {once: true});
    socket.addEventListener('error', () => (expectFail ? resolve(socket) : reject(new Error('连接失败 ' + role))), {once: true});
  });
  const shut = () => {
    for (const socket of clients) { try { socket.close(); } catch {} }
    relay.close();
    server.closeAllConnections?.();
    server.close();
  };
  return {relay, open, shut};
}

const waitFor = (socket, predicate, timeout = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待超时')), timeout);
  const listener = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (predicate(message)) { clearTimeout(timer); socket.removeEventListener('message', listener); resolve(message); }
  };
  socket.addEventListener('message', listener);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('未登录的握手被 401 拒掉', async () => {
  const {open, shut} = await startRelay({authenticate: () => ''});
  try {
    await open('viewer', {expectFail: true});
    await open('pusher', {expectFail: true});
  } finally { shut(); }
});

test('pusher 的重量只转发给同一账号的 viewer', async () => {
  const {open, shut} = await startRelay();
  try {
    const viewer = await open('viewer');
    const pusher = await open('pusher');
    const got = waitFor(viewer, message => message.kind === 'weight');
    pusher.send(JSON.stringify({kind: 'weight', grams: 342.2, flow: 5.2, at: Date.now(), junk: 'x'}));
    const message = await got;
    assert.equal(message.grams, 342.2);
    assert.equal(message.flow, 5.2);
    // 只透传白名单字段
    assert.equal(message.at, undefined);
    assert.equal(message.junk, undefined);
  } finally { shut(); }
});

test('不同账号的房间互不可见', async () => {
  let owner = 'u_test0001';
  const {open, shut} = await startRelay({authenticate: () => owner});
  try {
    const viewer = await open('viewer');
    owner = 'u_other9999';
    const pusher = await open('pusher');
    let leaked = 0;
    viewer.addEventListener('message', event => { try { if (JSON.parse(event.data).kind === 'weight') leaked += 1; } catch {} });
    pusher.send(JSON.stringify({kind: 'weight', grams: 1, flow: 1}));
    await sleep(250);
    assert.equal(leaked, 0);
  } finally { shut(); }
});

test('viewer 写进房间的数据不会被转发', async () => {
  const {open, shut} = await startRelay();
  try {
    const a = await open('viewer');
    const b = await open('viewer');
    let weights = 0;
    b.addEventListener('message', event => { try { if (JSON.parse(event.data).kind === 'weight') weights += 1; } catch {} });
    a.send(JSON.stringify({kind: 'weight', grams: 9}));
    await sleep(250);
    assert.equal(weights, 0);
  } finally { shut(); }
});

test('同一房间只允许一个 pusher', async () => {
  const {open, shut} = await startRelay();
  try {
    await open('pusher');
    await open('pusher', {expectFail: true});
  } finally { shut(); }
});

test('非数字重量被拦成 noop，房间空了会回收', async () => {
  const {open, shut, relay} = await startRelay();
  try {
    const viewer = await open('viewer');
    const pusher = await open('pusher');
    assert.equal(relay.active('u_test0001'), true);
    pusher.send(JSON.stringify({kind: 'weight', grams: 'NaN'}));
    const noop = await waitFor(viewer, message => message.kind === 'noop');
    assert.equal(noop.kind, 'noop');
    viewer.close(); pusher.close();
    // 关连接与 FIN 回收都是异步的，轮询到房间里确实没人再断言
    for (let i = 0; i < 40 && relay.rooms().some(room => room.peers); i += 1) await sleep(50);
    for (let i = 0; i < 40 && relay.rooms().length; i += 1) await sleep(50);
    assert.equal(relay.rooms().length, 0);
  } finally { shut(); }
});

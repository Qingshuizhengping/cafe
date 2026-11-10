// 电子秤中继：给 iOS 用。iPhone 上的浏览器没有 Web Bluetooth，
// 所以让能直连蓝牙的那台设备（安卓手机 / 桌面 Chrome / 同一台 iPhone 上的桥页面）当「秤桥」，
// 把解析后的重量推到账号服务，再由账号服务转发给同一个人其它已登录的页面。
//
// 安全模型：
//   - WebSocket 握手必须先通过 authenticate()——账号服务用它校验登录 Cookie，未登录一律 401，
//     所以房间既不能被陌生人猜码订阅，也没有明文房间码可猜。
//   - 房间按账号 id 隔离，只有 pusher 的消息会被广播，viewer 发什么都不会转发。
//   - 房间只存在内存里，不落盘、不记录读数；无人后自动回收。
import http from 'node:http';
import crypto from 'node:crypto';

function frameText(text) {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

const refuse = (socket, status = '401 Unauthorized') => {
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  try { socket.end(); } catch { socket.destroy(); }
};

export function createScaleRelay({
  path = '/api/scale/relay',
  authenticate = async () => '',
  maxRooms = 300,
  maxViewers = 6,
  idleMs = 30 * 60 * 1000,
  logger = console,
} = {}) {
  const rooms = new Map();

  const roomFor = owner => {
    if (!rooms.has(owner)) {
      if (rooms.size >= maxRooms) return null;
      rooms.set(owner, {owner, peers: new Set(), created: Date.now(), lastSeen: Date.now(), seq: 0});
    }
    return rooms.get(owner);
  };

  const broadcast = (state, from, message) => {
    const text = JSON.stringify(reason(message));
    for (const peer of state.peers) {
      if (peer === from || peer.closed || peer.role !== 'viewer') continue;
      peer.socket.write(frameText(text));
    }
  };

  // 只放行中继真正需要的字段，别把桥页面的其它东西透传出去
  const reason = message => {
    if (message?.kind === 'weight') {
      const weight = Number(message.grams);
      const flow = Number(message.flow);
      return Number.isFinite(weight) ? {kind: 'weight', grams: weight, flow: Number.isFinite(flow) ? flow : 0} : {kind: 'noop'};
    }
    if (message?.kind === 'model') return {kind: 'model', model: String(message.model ?? '').slice(0, 32)};
    if (message?.kind === 'bye') return {kind: 'bye'};
    return {kind: 'noop'};
  };

  // 容量检查放在 101 之前：超限直接回状态码，客户端拿到的是连接失败而不是「连上又被踢」
  const check = (owner, role) => {
    const state = rooms.get(owner);
    if (!state) return rooms.size >= maxRooms ? '503 Service Unavailable' : null;
    if (role === 'pusher' && [...state.peers].some(peer => peer.role === 'pusher' && !peer.closed)) return '409 Conflict';
    if (role === 'viewer' && [...state.peers].filter(peer => peer.role === 'viewer').length >= maxViewers) return '429 Too Many Requests';
    return null;
  };

  const join = (socket, owner, role) => {
    const state = roomFor(owner);
    if (!state) { refuse(socket, '503 Service Unavailable'); return null; }
    if (role === 'pusher') {
      for (const peer of state.peers) if (peer.role === 'pusher' && !peer.closed) { refuse(socket, '409 Conflict'); return null; }
    } else if ([...state.peers].filter(peer => peer.role === 'viewer').length >= maxViewers) {
      refuse(socket, '429 Too Many Requests');
      return null;
    }
    const peer = {socket, role, closed: false};
    state.peers.add(peer);
    state.lastSeen = Date.now();
    socket.write(frameText(JSON.stringify({kind: 'hello', role, room: state.seq++})));
    if (role === 'pusher') broadcast(state, peer, {kind: 'bridge-ready'});

    const leave = () => {
      if (peer.closed) return;
      peer.closed = true;
      state.peers.delete(peer);
      if (!state.peers.size) rooms.delete(owner);
      try { socket.end(); } catch {}
    };

    // 一条 TCP 段里可能连着多帧（比如最后一包重量紧跟关闭帧），必须逐个读，否则关闭帧会被丢掉
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      if (peer.closed) return;
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        const fin = (pending[0] & 0x80) !== 0;
        const opcode = pending[0] & 0x0f;
        const masked = (pending[1] & 0x80) !== 0;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        if (length > 64 * 1024 || !masked) { leave(); return; }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.slice(offset, offset + 4);
        const body = pending.slice(offset + 4, offset + 4 + length);
        pending = pending.slice(offset + 4 + length);
        if (opcode === 0x8) { leave(); return; }
        if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0x00])); } catch {} continue; }
        if (opcode !== 0x1 || !fin) continue;
        const text = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) text[i] = body[i] ^ mask[i % 4];
        state.lastSeen = Date.now();
        if (peer.role !== 'pusher') continue;
        let message;
        try { message = JSON.parse(text.toString('utf8')); } catch { continue; }
        if (message?.kind === 'bye') { broadcast(state, peer, {kind: 'bye'}); leave(); return; }
        broadcast(state, peer, message);
      }
    });
    socket.on('close', leave);
    socket.on('error', leave);
    return peer;
  };

  const upgrade = async (request, socket) => {
    const url = new URL(request.url, 'http://relay.local');
    if (url.pathname !== path) { refuse(socket, '404 Not Found'); return; }
    let owner = '';
    try { owner = (await authenticate(request)) || ''; }
    catch (error) { logger.warn?.('scale relay auth failed', error?.message); }
    if (!owner) { refuse(socket, '401 Unauthorized'); return; }
    const key = request.headers['sec-websocket-key'];
    if (!key) { refuse(socket, '400 Bad Request'); return; }
    const role = url.searchParams.get('role') === 'pusher' ? 'pusher' : 'viewer';
    const refusal = check(owner, role);
    if (refusal) { refuse(socket, refusal); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    socket.setNoDelay(true);
    // 握手结束后这条 socket 可能处于 pause 状态，必须显式恢复读，否则客户端发来的帧永远收不到，
    // 客户端的关闭帧也读不到，房间就一直挂着
    socket.resume();
    join(socket, owner, role);
  };

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [owner, state] of rooms) if (!state.peers.size || now - state.lastSeen > idleMs) rooms.delete(owner);
  }, 60_000);
  timer.unref?.();

  return {
    upgrade,
    rooms: () => [...rooms].map(([owner, state]) => ({owner, peers: state.peers.size,
      pushers: [...state.peers].filter(peer => peer.role === 'pusher').length})),
    active: owner => Boolean(rooms.get(owner)?.peers.size),
    close: () => {
      clearInterval(timer);
      for (const state of rooms.values()) for (const peer of state.peers) { try { peer.socket.destroy(); } catch {} }
      rooms.clear();
    },
  };
}

export function attachScaleRelay(server, options = {}) {
  const relay = createScaleRelay(options);
  const path = options.path ?? '/api/scale/relay';
  server.on('upgrade', (request, socket) => {
    const {pathname} = new URL(request.url, 'http://relay.local');
    if (pathname === path) relay.upgrade(request, socket).catch(() => refuse(socket));
    else refuse(socket, '404 Not Found');
  });
  return relay;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const port = Number(process.env.CAFE_SCALE_PORT ?? 8790);
  const server = http.createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(200, {'content-type': 'application/json'}); response.end('{"ok":true}'); return; }
    response.writeHead(404); response.end();
  });
  // 独立跑时只做本机调试，用 CAFE_SCALE_DEBUG_OWNER 指定一个虚拟账号
  const owner = process.env.CAFE_SCALE_DEBUG_OWNER ?? '';
  attachScaleRelay(server, {authenticate: () => owner});
  server.listen(port, '127.0.0.1', () => console.log(`scale relay ws://127.0.0.1:${port}/api/scale/relay`));
}
